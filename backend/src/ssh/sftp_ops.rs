use super::sftp_helpers::{content_type_for_path, enrich_owner_names};
use super::*;

impl SshRuntime {
    /// `sftp/list`：目录列表。编码偏好为 latin-1（M14-B）时改走裸包客户端
    /// 拿原始文件名字节（russh-sftp 的反序列化层对文件名做 lossy UTF-8 解码，
    /// 原始字节只能由 raw 路径取得），显示名按 latin-1 解码、传输路径用
    /// `%XX` 转义形式；raw 不可用时回退高层客户端。auto 模式保持原路径
    /// （字节往返无损），仅按 wire 名是否含 U+FFFD 标记 `lossy`。
    pub async fn sftp_list_path(
        &self,
        session_id: &str,
        path: &str,
        include_owner: bool,
        encoding: NameEncoding,
    ) -> Result<Vec<SftpEntry>, String> {
        let path = normalize_remote_path(path)?;
        let mut result = if encoding == NameEncoding::Latin1 {
            match self.raw_list_entries(session_id, &path, encoding).await {
                Ok(entries) => entries,
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte listing unavailable, falling back: {error}"
                    );
                    self.crate_list_entries(session_id, &path, include_owner)
                        .await?
                }
            }
        } else {
            self.crate_list_entries(session_id, &path, include_owner)
                .await?
        };
        if include_owner {
            // One extra read-only round trip upgrades numeric ids to names on
            // SFTPv3 servers (OpenSSH): `ls -l` puts owner/group in fields 3/4.
            // Any failure (no shell, no `ls`, timeout) keeps the numeric or
            // absent values, never the listing itself.
            enrich_owner_names(self, session_id, &path, &mut result).await;
        }
        result.sort_by(|left, right| {
            let left_dir = left.kind == "directory";
            let right_dir = right.kind == "directory";
            right_dir
                .cmp(&left_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(result)
    }

    /// 高层客户端（russh-sftp）路径：合法 UTF-8 服务器下字节往返无损。
    async fn crate_list_entries(
        &self,
        session_id: &str,
        path: &str,
        include_owner: bool,
    ) -> Result<Vec<SftpEntry>, String> {
        let sftp = self.sftp(session_id).await?;
        let entries = sftp
            .lock()
            .await
            .read_dir(path.to_string())
            .await
            .map_err(sftp_error)?;
        Ok(entries
            .map(|entry| {
                let metadata = entry.metadata();
                let kind = classify_entry_kind(entry.file_type());
                let (owner, group) = if include_owner {
                    // Names first (SFTPv4+), numeric ids as the v3 fallback —
                    // the same semantics `sftp/stat` already documents.
                    let owner = metadata
                        .user
                        .clone()
                        .or_else(|| metadata.uid.map(|uid| uid.to_string()));
                    let group = metadata
                        .group
                        .clone()
                        .or_else(|| metadata.gid.map(|gid| gid.to_string()));
                    (owner, group)
                } else {
                    (None, None)
                };
                let name = entry.file_name();
                SftpEntry {
                    lossy: sftp_name::is_lossy_wire(&name),
                    name,
                    uri: sftp_uri(&entry.path()),
                    kind,
                    size: metadata.size,
                    modified_at: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions.map(format_permissions),
                    content_type: content_type_for_path(&entry.path()),
                    owner,
                    group,
                }
            })
            .collect())
    }

    /// latin-1 路径：裸包客户端取原始字节。显示名 = latin-1 解码（忠实）；
    /// 传输名 = `%XX` 转义的 wire 形式（合法 UTF-8 字节按字符透传，与高层
    /// 路径完全一致）。属主增强不做（exec 通道对转义名不可靠），保持空值。
    async fn raw_list_entries(
        &self,
        session_id: &str,
        path: &str,
        encoding: NameEncoding,
    ) -> Result<Vec<SftpEntry>, String> {
        let mut client = self.raw_sftp_client(session_id).await?;
        let raw_entries = client.readdir(path.as_bytes()).await?;
        Ok(raw_entries
            .into_iter()
            .filter(|entry| entry.name.as_slice() != b"." && entry.name.as_slice() != b"..")
            .map(|entry| {
                let display = sftp_name::decode_display_name(&entry.name, encoding);
                let wire_name = sftp_name::escape_wire(&entry.name);
                let wire_path = sftp_name::join_wire_name(path, &wire_name);
                SftpEntry {
                    lossy: display.lossy,
                    name: display.text,
                    uri: sftp_uri(&wire_path),
                    kind: classify_raw_kind(entry.attrs.permissions),
                    size: entry.attrs.size,
                    modified_at: entry.attrs.mtime.map(u64::from),
                    permissions: entry.attrs.permissions.map(format_permissions),
                    content_type: content_type_for_path(&wire_path),
                    owner: None,
                    group: None,
                }
            })
            .collect())
    }

    /// 打开一条独立 sftp 子系统通道并跑裸包客户端（严格串行请求/响应）。
    pub(crate) async fn raw_sftp_client(&self, session_id: &str) -> Result<RawSftpClient, String> {
        let session = self.session(session_id).await?;
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("Failed to start SFTP: {error}"))?;
        sftp_raw::RawSftp::init(channel.into_stream()).await
    }

    /// 裸包读一个下载分片（转义路径专用）：wire 路径先在字符串域归一
    /// （绝对化 + 去 `.`/`..`/空段，与 auto 车道的 normalize_remote_path 同一
    /// 口径——M24-R3 拉齐；`%2E%2E` 这类转义名还原出字面 `..` 的场景不受
    /// 影响，归一只作用于还原前的 wire 字符串组件），再还原为服务器原始
    /// 字节交给 SFTP READ。requested=0 直接回空（EOF 语义）。
    /// 客户端走 `DownloadState.raw_client` 任务槽复用（字段注释）：此前逐片
    /// 新开一条 SFTP 子系统通道，多付数个 RTT。任何错误整槽报废由下一片
    /// 惰性重建（RawSftp poisoned 一次性语义，重建只是多一次握手）；通道级
    /// 错误连带失效整个 SFTP 客户端缓存——死通道被原样复用会把该会话 SFTP
    /// 打到永久报错。客户端与路径无关：树下载逐文件换路径仍复用同一通道。
    pub(super) async fn raw_read_chunk_cached(
        &self,
        session_id: &str,
        raw_client: &AsyncMutex<Option<RawSftpClient>>,
        remote_path: &str,
        offset: u64,
        requested: u32,
    ) -> Result<Vec<u8>, String> {
        if requested == 0 {
            return Ok(Vec::new());
        }
        let normalized = normalize_remote_path(remote_path)?;
        let raw_path = sftp_name::unescape_wire(&normalized);
        let read = async {
            let mut slot = raw_client.lock().await;
            if slot.is_none() {
                *slot = Some(self.raw_sftp_client(session_id).await?);
            }
            slot.as_mut()
                .expect("raw client just ensured")
                .read_chunk(&raw_path, offset, requested)
                .await
        };
        match read.await {
            Ok(chunk) => Ok(chunk),
            Err(error) => {
                *raw_client.lock().await = None;
                if is_channel_level_sftp_error(&error) {
                    self.invalidate_sftp_cache(session_id).await;
                }
                Err(error)
            }
        }
    }

    /// 一次性裸包读（`sftp/read` 的 latin-1 车道）：无任务槽可挂，每调用
    /// 自开一条 SFTP 子系统通道用完即弃——预览读是小载荷低频路径，简单优先；
    /// 下载分片的热路径走 `raw_read_chunk_cached`。
    pub(crate) async fn raw_read_chunk(
        &self,
        session_id: &str,
        remote_path: &str,
        offset: u64,
        requested: u32,
    ) -> Result<Vec<u8>, String> {
        if requested == 0 {
            return Ok(Vec::new());
        }
        let normalized = normalize_remote_path(remote_path)?;
        let raw_path = sftp_name::unescape_wire(&normalized);
        let mut client = self.raw_sftp_client(session_id).await?;
        client.read_chunk(&raw_path, offset, requested).await
    }

    pub async fn sftp_read_path(
        &self,
        session_id: &str,
        path: &str,
        offset: u64,
        max_bytes: usize,
    ) -> Result<(Vec<u8>, bool), String> {
        let sftp = self.sftp(session_id).await?;
        let path = normalize_remote_path(path)?;
        let mut file = sftp.lock().await.open(path).await.map_err(sftp_error)?;
        if offset > 0 {
            use tokio::io::AsyncSeekExt;
            // `SeekFrom::Start` only moves the local read cursor (no fstat
            // round trip); an offset at/after EOF simply yields no data.
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| format!("SFTP seek failed: {error}"))?;
        }
        let mut data = Vec::new();
        file.take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut data)
            .await
            .map_err(|error| format!("SFTP read failed: {error}"))?;
        let truncated = data.len() > max_bytes;
        data.truncate(max_bytes);
        Ok((data, truncated))
    }

    pub async fn sftp_create_directory(
        &self,
        session_id: &str,
        path: &str,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let path = normalize_remote_path(path)?;
        if encoding == NameEncoding::Latin1 {
            // latin-1：目录前缀是列表回传的 wire 形式、最后一段是用户新输入
            // 的显示文本，write_path_bytes 组装出服务器字节后走裸包 MKDIR。
            // 客户端建立失败（尚未发出任何请求）回退高层路径；操作本身的
            // 错误原样上抛——写操作失败后回退可能重复执行，不做。
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    let raw_path = sftp_name::write_path_bytes(&path);
                    return client.mkdir(&raw_path).await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte mkdir unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let result = sftp.lock().await.create_dir(path).await.map_err(sftp_error);
        result
    }

    pub async fn sftp_write_path(
        &self,
        session_id: &str,
        path: &str,
        data: &[u8],
        create: bool,
        overwrite: bool,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        if data.len() > 1024 * 1024 {
            return Err(
                "Direct filesystem writes are limited to 1 MiB; use the streaming transfer API"
                    .to_string(),
            );
        }
        let sftp = self.sftp(session_id).await?;
        let path = normalize_remote_path(path)?;
        let exists = sftp.lock().await.metadata(path.clone()).await.is_ok();
        if exists && !overwrite {
            return Err("SFTP target already exists and overwrite is disabled".to_string());
        }
        if !exists && !create {
            return Err("SFTP target does not exist and create is disabled".to_string());
        }
        let task_id = Uuid::new_v4().to_string();
        let (temporary, backup) = remote_transfer_paths(&path, &task_id)?;
        let mut file = sftp
            .lock()
            .await
            .create(temporary.clone())
            .await
            .map_err(sftp_error)?;
        if let Err(error) = file.write_all(data).await {
            drop(file);
            let _ = sftp.lock().await.remove_file(temporary).await;
            return Err(format!("SFTP write failed: {error}"));
        }
        file.flush()
            .await
            .map_err(|error| format!("SFTP write flush failed: {error}"))?;
        drop(file);
        commit_remote_file(&sftp, &temporary, &path, &backup).await
    }

    pub async fn sftp_rename(
        &self,
        session_id: &str,
        source: &str,
        target: &str,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let source = normalize_remote_path(source)?;
        let target = normalize_remote_path(target)?;
        if encoding == NameEncoding::Latin1 {
            // latin-1：源是列表回传的 wire 路径（整条还原为原始字节）；目标
            // 最后一段是用户新输入的显示文本（write_path_bytes 按 latin-1 编
            // 码回字节）。裸包 RENAME 保证改名不破坏非 UTF-8 字节。
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    let raw_source = sftp_name::unescape_wire(&source);
                    let raw_target = sftp_name::write_path_bytes(&target);
                    return client.rename(&raw_source, &raw_target).await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte rename unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let result = sftp
            .lock()
            .await
            .rename(source, target)
            .await
            .map_err(sftp_error);
        result
    }

    pub async fn sftp_delete(
        &self,
        session_id: &str,
        path: &str,
        recursive: bool,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let path = normalize_remote_path(path)?;
        if path == "/" {
            return Err("Refusing to delete the filesystem root".to_string());
        }
        if encoding == NameEncoding::Latin1 {
            // latin-1：wire 路径整条还原为原始字节后走裸包删除（LSTAT 判型
            // → REMOVE/RMDIR/递归树删，symlink 绝不跟随）。回退策略与
            // mkdir/rename 相同：仅客户端建立失败时回退高层路径。
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    let raw_path = sftp_name::unescape_wire(&path);
                    return raw_delete_path(&mut client, &raw_path, recursive).await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte delete unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let metadata = sftp
            .lock()
            .await
            .symlink_metadata(path.clone())
            .await
            .map_err(sftp_error)?;
        if metadata.is_symlink() {
            sftp.lock()
                .await
                .remove_file(path)
                .await
                .map_err(sftp_error)
        } else if metadata.is_dir() {
            if !recursive {
                return sftp.lock().await.remove_dir(path).await.map_err(sftp_error);
            }
            delete_directory_tree(&sftp, path).await
        } else {
            sftp.lock()
                .await
                .remove_file(path)
                .await
                .map_err(sftp_error)
        }
    }

    /// Changes the permission bits of a remote path (`sftp/chmod`).
    ///
    /// 路径来源（M17 增量③迁移）：前端传来的整条 wire 路径（`pathFromUri`），
    /// latin-1 模式整条按 [`sftp_name::unescape_wire`] 还原后走裸包 SETSTAT
    /// （此前高层客户端按字面量发送，转义名探不到）；裸包客户端**建立**失败
    /// 回退高层路径（M15 先例），SETSTAT 已发出后的失败原样上抛，不回退
    /// （写操作不重复执行）。
    pub async fn sftp_chmod(
        &self,
        session_id: &str,
        path: &str,
        mode: u32,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let path = normalize_remote_path(path)?;
        if encoding == NameEncoding::Latin1 {
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    return client
                        .setstat(
                            &sftp_name::unescape_wire(&path),
                            &sftp_raw::RawAttrs {
                                permissions: Some(mode),
                                ..sftp_raw::RawAttrs::default()
                            },
                        )
                        .await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte chmod unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let metadata = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        };
        let result = sftp.lock().await.set_metadata(path, metadata).await;
        result.map_err(sftp_error)
    }

    /// Reports filesystem usage for the mount containing `path` via `df -kP`.
    /// Read-only, so it stays available on read-only connections.
    pub async fn sftp_disk_usage(&self, session_id: &str, path: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let path = normalize_remote_path(path)?;
        let command = format!("df -kP {}", exec::shell_quote(&path));
        // Plugin-internal plumbing: no client setEnv, keeping the df output
        // parseable regardless of the connection's locale overrides.
        let outcome =
            exec::exec_plain(&session.handle, &command, Duration::from_secs(20), &[]).await?;
        exec::parse_disk_usage(&outcome.output)
            .ok_or_else(|| format!("Could not parse disk usage output: {}", outcome.output))
    }
}
