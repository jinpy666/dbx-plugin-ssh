use super::state::{DownloadSink, TreeDownloadState};
use super::*;

pub(super) async fn publish_terminal(
    session_id: &str,
    stream: TerminalStream,
    data: Vec<u8>,
    replay: &Arc<AsyncMutex<ReplayBuffer>>,
    emitter: &PluginEmitter,
) {
    let frame = replay.lock().await.push(stream, data);
    if let Err(error) = emitter.binary(&format!("ssh/terminal/out/{session_id}"), &frame.encode()) {
        eprintln!(
            "[ssh-sftp-plugin] terminal output failed: {}",
            error.message
        );
    }
}

pub(super) async fn delete_directory_tree(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    root: String,
) -> Result<(), String> {
    // Defense in depth: the caller already refuses "/" — keep the guard at
    // the recursive implementation too, so no future call site can bypass it.
    if root == "/" {
        return Err("Refusing to recursively delete the filesystem root".to_string());
    }
    let mut pending = vec![root];
    let mut directories = Vec::new();
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        let entries = sftp
            .lock()
            .await
            .read_dir(directory)
            .await
            .map_err(sftp_error)?;
        for entry in entries {
            if entry.file_type() == FileType::Dir {
                pending.push(entry.path());
            } else {
                sftp.lock()
                    .await
                    .remove_file(entry.path())
                    .await
                    .map_err(sftp_error)?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        sftp.lock()
            .await
            .remove_dir(directory)
            .await
            .map_err(sftp_error)?;
    }
    Ok(())
}

/// Recursively walks a remote directory over SFTP and collects the folder
/// download plan (breadth-first, so parents are read before children):
/// regular files in download order, the directory layout, symlink/special
/// skips and per-path failures. The root itself is pre-checked first
/// (symlinks are refused, non-directories rejected). Only root-level
/// problems (not a readable directory) abort; a failing subdirectory is
/// recorded and the walk goes on.
/// Symlinks are never followed, so server-side cycles cannot loop the walk.
pub(super) async fn scan_remote_tree(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    root: &str,
) -> Result<sftp_tree::TreeScan, String> {
    let metadata = sftp
        .lock()
        .await
        .symlink_metadata(root.to_string())
        .await
        .map_err(sftp_error)?;
    if metadata.is_symlink() {
        return Err(
            "Refusing to download a symlink as a folder; download its target instead".to_string(),
        );
    }
    if !metadata.is_dir() {
        return Err("Folder download needs a remote directory".to_string());
    }
    scan_remote_tree_walk(sftp, root).await
}

/// 高层客户端的树遍历主体（根预检已由 [`scan_remote_tree`] 完成）。
async fn scan_remote_tree_walk(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    root: &str,
) -> Result<sftp_tree::TreeScan, String> {
    let mut scan = sftp_tree::TreeScan::new();
    let mut pending: VecDeque<(String, String)> = VecDeque::new();
    pending.push_back((root.to_string(), String::new()));
    while let Some((dir_remote, dir_relative)) = pending.pop_front() {
        let entries = sftp.lock().await.read_dir(dir_remote.clone()).await;
        let entries = match entries {
            Ok(entries) => entries,
            Err(error) => {
                if dir_relative.is_empty() {
                    return Err(sftp_error(error));
                }
                scan.record_failure(
                    &dir_relative,
                    format!("directory is not readable: {}", sftp_error(error)),
                );
                continue;
            }
        };
        for entry in entries {
            let name = entry.file_name();
            let child_relative = if dir_relative.is_empty() {
                name.clone()
            } else {
                format!("{dir_relative}/{name}")
            };
            match entry.file_type() {
                FileType::Dir => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "directory name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    match scan.push_dir(&relative) {
                        Ok(true) => pending.push_back((format!("{dir_remote}/{name}"), relative)),
                        Ok(false) => {}
                        Err(capacity) => return Err(capacity.to_string()),
                    }
                }
                FileType::File => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "file name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    let remote_child = format!("{dir_remote}/{name}");
                    let size = match entry.metadata().size {
                        Some(size) => size,
                        None => {
                            scan.record_failure(
                                &child_relative,
                                "directory listing did not report the file size",
                            );
                            continue;
                        }
                    };
                    if let Err(capacity) = scan.push_file(relative, remote_child, size) {
                        return Err(capacity.to_string());
                    }
                }
                _ => scan.skip(),
            }
        }
    }
    Ok(scan)
}

/// 裸包树扫描（latin-1 模式）：同一通道内 LSTAT 根预检 + READDIR 递归，
/// 整树路径字节保真——远端路径用 wire 转义形式（分块下载按转义自动走
/// raw READ），本地落盘名用 latin-1 解码的显示名。symlink/特殊条目跳过
/// 不跟随（与高层路径同语义），根预检失败整个下载拒绝，子目录失败记录
/// 后继续走。
pub(super) async fn scan_tree_with_raw(
    client: &mut RawSftpClient,
    root_wire: &str,
) -> Result<sftp_tree::TreeScan, String> {
    let root_raw = sftp_name::unescape_wire(root_wire);
    let attrs = client.lstat(&root_raw).await?;
    let kind = classify_raw_kind(attrs.permissions);
    if kind == "symlink" {
        return Err(
            "Refusing to download a symlink as a folder; download its target instead".to_string(),
        );
    }
    if kind != "directory" {
        return Err("Folder download needs a remote directory".to_string());
    }
    let mut scan = sftp_tree::TreeScan::new();
    // 队列元素：(远端目录原始字节, 远端目录 wire 形式, 本地相对显示路径)。
    let mut pending: VecDeque<(Vec<u8>, String, String)> = VecDeque::new();
    pending.push_back((root_raw, root_wire.to_string(), String::new()));
    while let Some((dir_raw, dir_wire, dir_relative)) = pending.pop_front() {
        let entries = match client.readdir(&dir_raw).await {
            Ok(entries) => entries,
            Err(error) => {
                if dir_relative.is_empty() {
                    return Err(error);
                }
                scan.record_failure(&dir_relative, format!("directory is not readable: {error}"));
                continue;
            }
        };
        for entry in entries {
            if entry.name.as_slice() == b"." || entry.name.as_slice() == b".." {
                continue;
            }
            // 显示相对路径（本地落盘布局）与 wire 远端路径严格分离。
            let display = sftp_name::decode_display_name(&entry.name, NameEncoding::Latin1);
            let child_relative = if dir_relative.is_empty() {
                display.text
            } else {
                format!("{dir_relative}/{}", display.text)
            };
            let child_wire =
                sftp_name::join_wire_name(&dir_wire, &sftp_name::escape_wire(&entry.name));
            match classify_raw_kind(entry.attrs.permissions) {
                "directory" => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "directory name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    match scan.push_dir(&relative) {
                        Ok(true) => pending.push_back((
                            sftp_name::join_raw_path(&dir_raw, &entry.name),
                            child_wire,
                            relative,
                        )),
                        Ok(false) => {}
                        Err(capacity) => return Err(capacity.to_string()),
                    }
                }
                "file" => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "file name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    let Some(size) = entry.attrs.size else {
                        scan.record_failure(
                            &child_relative,
                            "directory listing did not report the file size",
                        );
                        continue;
                    };
                    if let Err(capacity) = scan.push_file(relative, child_wire, size) {
                        return Err(capacity.to_string());
                    }
                }
                _ => scan.skip(),
            }
        }
    }
    Ok(scan)
}

/// 裸包删除单个路径：LSTAT 判型后分派 REMOVE/RMDIR/递归树删（分派语义与
/// 高层 `sftp_delete` 一致；READDIR attrs 是 lstat 语义，目录里的符号链接
/// 按 REMOVE 处理，绝不跟随）。
pub(super) async fn raw_delete_path(
    client: &mut RawSftpClient,
    raw_path: &[u8],
    recursive: bool,
) -> Result<(), String> {
    let attrs = client.lstat(raw_path).await?;
    match classify_raw_kind(attrs.permissions) {
        "directory" if recursive => raw_delete_tree(client, raw_path).await,
        "directory" => client.rmdir(raw_path).await,
        _ => client.remove(raw_path).await,
    }
}

/// 裸包递归删除：后序遍历（先文件后目录），单通道串行，`.`/`..` 跳过。
/// pub(crate)：MCP 工具面 sftp_remove 的 latin-1 递归分支复用（M17）。
pub(crate) async fn raw_delete_tree(client: &mut RawSftpClient, root: &[u8]) -> Result<(), String> {
    // 与 delete_directory_tree 同源的根守卫：调用方已拒绝 "/"，此处兜底。
    if root == b"/" {
        return Err("Refusing to recursively delete the filesystem root".to_string());
    }
    let mut pending = vec![root.to_vec()];
    let mut directories = Vec::new();
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        for entry in client.readdir(&directory).await? {
            if entry.name.as_slice() == b"." || entry.name.as_slice() == b".." {
                continue;
            }
            let child = sftp_name::join_raw_path(&directory, &entry.name);
            match classify_raw_kind(entry.attrs.permissions) {
                "directory" => pending.push(child),
                _ => client.remove(&child).await?,
            }
        }
    }
    for directory in directories.into_iter().rev() {
        client.rmdir(&directory).await?;
    }
    Ok(())
}

/// Creates the parent directories for one queued tree file and opens its
/// staging `.part` file. The relative path is re-validated (sanitize +
/// containment) so nothing server-reported can place bytes outside the
/// download root. A stale `.part` from a crashed earlier attempt is replaced,
/// never appended to.
pub(super) async fn open_tree_sink(
    root_local: &Path,
    relative: &str,
) -> Result<DownloadSink, String> {
    let Some(final_path) = sftp_tree::safe_tree_path(root_local, relative) else {
        return Err("path escapes the download folder".to_string());
    };
    let name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let final_dir = final_path.parent().unwrap_or(root_local).to_path_buf();
    std::fs::create_dir_all(&final_dir).map_err(|error| {
        format!(
            "Failed to create local folder '{}': {error}",
            final_dir.display()
        )
    })?;
    let part_path = final_dir.join(format!("{name}.part"));
    let _ = std::fs::remove_file(&part_path);
    let file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&part_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local download file '{}': {error}",
                part_path.display()
            )
        })?;
    Ok(DownloadSink {
        part_path,
        final_dir,
        overwrite: false,
        file: AsyncMutex::new(file),
    })
}

/// Drops the in-flight tree file after a failure: the staging `.part` is
/// deleted so a failed file never leaves partial bytes behind.
pub(super) fn discard_tree_current(tree: &mut TreeDownloadState) {
    if let Some(sink) = tree.sink.take() {
        let _ = std::fs::remove_file(&sink.part_path);
    }
    tree.current = None;
    tree.current_offset = 0;
}

/// Completes the in-flight tree file: the staging `.part` is flushed and
/// renamed into place. Failures are recorded and the file simply vanishes
/// from the local tree (no partial bytes) while the walk continues.
pub(super) async fn finalize_tree_current(runtime: &SshRuntime, tree: &mut TreeDownloadState) {
    if let Some(sink) = tree.sink.take() {
        if let Some(file) = tree.current.clone() {
            let name = file
                .relative
                .rsplit('/')
                .next()
                .unwrap_or(&file.relative)
                .to_string();
            match runtime.finalize_download_sink(&sink, &name).await {
                Ok(_) => tree.files_done += 1,
                Err(error) => {
                    let _ = std::fs::remove_file(&sink.part_path);
                    tree.failures
                        .push(json!({ "path": file.relative, "error": error }));
                }
            }
        }
    }
    tree.current = None;
    tree.current_offset = 0;
}
