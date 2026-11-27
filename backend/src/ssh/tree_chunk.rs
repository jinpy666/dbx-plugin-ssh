use super::state::DownloadState;
use super::tree_fs::{discard_tree_current, finalize_tree_current, open_tree_sink};
use super::*;

impl SshRuntime {
    /// Chunk pump for folder downloads. `next_offset` stays the aggregate byte
    /// position across the tree; when the in-flight file completes it is
    /// renamed into place and the next queued file opens within the same call,
    /// so the caller's chunk loop is identical to a plain download. A tree
    /// whose queue is drained answers with an empty eof chunk (this is also
    /// how a zero-byte tree completes — the frontend loop runs until eof, not
    /// until the byte total).
    pub(super) async fn download_tree_chunk(
        &self,
        task_id: &str,
        offset: u64,
        download: DownloadState,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        if download.compression == CompressionMode::Gzip && !download.ready {
            return Err("Compressed download is still preparing".to_string());
        }
        if offset != download.next_offset {
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
        let sftp = self.sftp(&download.session_id).await?;
        // download 参数已持有所有权：move 而非再 clone——这里的 clone 会把
        // 剩余 files 队列 + failures 全量再拷一份（树下载热路径的分配热点，
        // 与读侧快照同量级）。回写仍走 store_tree_state 的零拷贝 swap。
        let Some(mut tree) = download.tree else {
            return Err("Download task is not a folder download".to_string());
        };
        loop {
            if tree.current.is_none() {
                let Some(file) = tree.files.pop_front() else {
                    // 队列耗尽：空树或全部走完。最后一批文件的改名/失败登记
                    // 就发生在本次调用里，先把状态写回，finish 才能看到完整
                    // 汇总；随后补发一个空 eof 块，让前端的分块等待器（只认
                    // 二进制帧）与单文件语义保持一致。
                    {
                        let mut downloads = self
                            .downloads
                            .lock()
                            .map_err(|_| "Download registry is poisoned".to_string())?;
                        if let Some(current) = downloads.get_mut(task_id) {
                            if let Some(tree_state) = current.tree.as_mut() {
                                Self::store_tree_state(tree_state, &mut tree);
                            }
                        }
                    }
                    let mut payload = Vec::with_capacity(8);
                    payload.extend_from_slice(&offset.to_be_bytes());
                    emitter
                        .binary(&format!("sftp/download/{task_id}"), &payload)
                        .map_err(plugin_error)?;
                    return Ok(
                        json!({ "taskId": task_id, "offset": offset, "length": 0, "eof": true, "fileName": download.file_name }),
                    );
                };
                match open_tree_sink(&tree.root_local, &file.relative).await {
                    Ok(sink) => {
                        tree.sink = Some(Arc::new(sink));
                        tree.current = Some(file);
                        tree.current_offset = 0;
                    }
                    Err(error) => {
                        tree.failures
                            .push(json!({ "path": file.relative, "error": error }));
                        continue;
                    }
                }
            }
            let file = tree.current.clone().expect("current file is present");
            let remaining = file.size - tree.current_offset;
            if remaining == 0 {
                // 当前文件收尾：暂存 .part 改名落位（空文件也会在这一步真实
                // 落地），失败记入汇总且不中断整树。
                finalize_tree_current(self, &mut tree).await;
                continue;
            }
            let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
            // 限速节奏（issue #66）：树下载逐文件分块循环与单文件同口径——
            // 块耗时从读开始计量，读毕由 limiter 补足差额；缺省 0 零开销。
            // 压缩树不限速（网络腿已在 prep 拉取段按压缩流限速，这里是
            // 本地读，限速只添堵）。
            let chunk_started = (download.throttle.enabled()
                && (download.compression != CompressionMode::Gzip || download.serving_plain))
                .then(std::time::Instant::now);
            let (mut chunk, length) = if download.compression == CompressionMode::Gzip
                && !download.serving_plain
            {
                // 压缩树（M33）：整树已由 prep 解包到本地 staging 根，逐
                // 文件从本地镜像按 offset 读（不再远端 open）。单文件读取
                // 失败照旧记入汇总跳过，不中断整树。
                let mut source = match tokio::fs::File::open(tree.root_local.join(&file.relative))
                    .await
                {
                    Ok(source) => source,
                    Err(error) => {
                        tree.failures
                            .push(json!({ "path": file.relative, "error": format!("staged read failed: {error}") }));
                        discard_tree_current(&mut tree);
                        continue;
                    }
                };
                if let Err(error) = source
                    .seek(std::io::SeekFrom::Start(tree.current_offset))
                    .await
                {
                    tree.failures
                        .push(json!({ "path": file.relative, "error": format!("staged seek failed: {error}") }));
                    discard_tree_current(&mut tree);
                    continue;
                }
                let mut chunk = vec![0_u8; requested];
                let length = match source.read(&mut chunk).await {
                    Ok(length) => length,
                    Err(error) => {
                        tree.failures.push(json!({ "path": file.relative, "error": format!("staged read failed: {error}") }));
                        discard_tree_current(&mut tree);
                        continue;
                    }
                };
                (chunk, length)
            } else if tree.latin1 {
                // latin-1：远端路径是 wire 形式（raw 扫描），高层 open 按
                // UTF-8 找不到字节名文件——走裸包 READ（download 分片的
                // raw_read_chunk 同款：整条 unescape 后裸包 OPEN/READ）。
                match self
                    .raw_read_chunk_cached(
                        &download.session_id,
                        &download.raw_client,
                        &file.remote_path,
                        tree.current_offset,
                        requested as u32,
                    )
                    .await
                {
                    Ok(data) => {
                        let length = data.len();
                        (data, length)
                    }
                    Err(error) => {
                        tree.failures
                            .push(json!({ "path": file.relative, "error": error }));
                        discard_tree_current(&mut tree);
                        continue;
                    }
                }
            } else {
                let mut source = match sftp.lock().await.open(file.remote_path.clone()).await {
                    Ok(source) => source,
                    Err(error) => {
                        let error = sftp_error(error);
                        // 通道级错误（NAT/服务器掐断 SFTP 子系统通道）：继续
                        // 循环只会把整树文件逐个登记成失败——失效缓存并中止
                        // 本批，前端按既有失败汇总语义收尾重试。
                        if is_channel_level_sftp_error(&error) {
                            self.invalidate_sftp_cache(&download.session_id).await;
                            tree.failures
                                .push(json!({ "path": file.relative, "error": error }));
                            {
                                let mut downloads = self
                                    .downloads
                                    .lock()
                                    .map_err(|_| "Download registry is poisoned".to_string())?;
                                if let Some(current) = downloads.get_mut(task_id) {
                                    if let Some(tree_state) = current.tree.as_mut() {
                                        Self::store_tree_state(tree_state, &mut tree);
                                    }
                                }
                            }
                            return Err(
                                "SFTP channel died during folder download; reconnect and retry the remaining files"
                                    .to_string(),
                            );
                        }
                        tree.failures
                            .push(json!({ "path": file.relative, "error": error }));
                        discard_tree_current(&mut tree);
                        continue;
                    }
                };
                if let Err(error) = source
                    .seek(std::io::SeekFrom::Start(tree.current_offset))
                    .await
                {
                    tree.failures.push(json!({ "path": file.relative, "error": format!("SFTP download seek failed: {error}") }));
                    discard_tree_current(&mut tree);
                    continue;
                }
                let mut chunk = vec![0_u8; requested];
                let length = match source.read(&mut chunk).await {
                    Ok(length) => length,
                    Err(error) => {
                        let error = format!("SFTP download failed: {error}");
                        // 同 open 分支：通道死亡中止整批而不是烧完队列。
                        if is_channel_level_sftp_error(&error) {
                            self.invalidate_sftp_cache(&download.session_id).await;
                            tree.failures
                                .push(json!({ "path": file.relative, "error": error }));
                            {
                                let mut downloads = self
                                    .downloads
                                    .lock()
                                    .map_err(|_| "Download registry is poisoned".to_string())?;
                                if let Some(current) = downloads.get_mut(task_id) {
                                    if let Some(tree_state) = current.tree.as_mut() {
                                        Self::store_tree_state(tree_state, &mut tree);
                                    }
                                }
                            }
                            return Err(
                                "SFTP channel died during folder download; reconnect and retry the remaining files"
                                    .to_string(),
                            );
                        }
                        tree.failures
                            .push(json!({ "path": file.relative, "error": error }));
                        discard_tree_current(&mut tree);
                        continue;
                    }
                };
                (chunk, length)
            };
            if length == 0 {
                // 远端文件比扫描时短：只记失败，不把半成品留在本地。
                tree.failures.push(
                    json!({ "path": file.relative, "error": "file shrank below its scanned size" }),
                );
                discard_tree_current(&mut tree);
                continue;
            }
            chunk.truncate(length);
            // 限速等待读毕即执行（本地写之前），与单文件路径同口径。
            if download.throttle.enabled() {
                if let Some(started) = chunk_started {
                    download.throttle.pace(length, started.elapsed()).await;
                }
            }
            // 克隆 Arc 而非借用，写失败的清理路径需要 &mut tree。
            if let Some(sink) = tree.sink.clone() {
                if let Err(error) = sink.file.lock().await.write_all(&chunk).await {
                    tree.failures.push(json!({ "path": file.relative, "error": format!("Failed to write local download file: {error}") }));
                    discard_tree_current(&mut tree);
                    continue;
                }
            }
            tree.current_offset += length as u64;
            // 文件耗尽即在本调用内收尾（改名落位）：eof 与落位必须同帧，否则
            // eof 后调用方直接 finish，最后一个文件会被记成未传输。
            if tree.current_offset >= file.size {
                finalize_tree_current(self, &mut tree).await;
            }
            let next_offset = offset + length as u64;
            let mut payload = Vec::with_capacity(8 + length);
            payload.extend_from_slice(&offset.to_be_bytes());
            payload.extend_from_slice(&chunk);
            emitter
                .binary(&format!("sftp/download/{task_id}"), &payload)
                .map_err(plugin_error)?;
            // 进度事件时间窗节流（progress_throttle），eof 帧必发兜底树
            // 收尾/文件切换的最终进度可见。
            let emit_progress = {
                let mut downloads = self
                    .downloads
                    .lock()
                    .map_err(|_| "Download registry is poisoned".to_string())?;
                let current = downloads
                    .get_mut(task_id)
                    .ok_or("Download task was not found")?;
                if current.next_offset != offset {
                    return Err("Download task changed while a chunk was in flight".to_string());
                }
                current.next_offset = next_offset;
                current
                    .progress_throttle
                    .should_emit(download.size > 0 && next_offset >= download.size)
            };
            let current_remaining = tree
                .current
                .as_ref()
                .map(|file| file.size - tree.current_offset)
                .unwrap_or(0);
            let eof = sftp_tree::tree_eof(tree.files.len(), current_remaining);
            if emit_progress || eof {
                // 压缩树（含 prep 回退）供给段标 phase=transferring：前端换
                // 阶段重置计数，不再停在解包终值（M-1，2026-09-30 补齐）。
                // 普通树维持无 phase（线上兼容）。
                let mut progress = json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "transferred": next_offset, "size": download.size, "status": "running", "fileCount": tree.file_count, "fileIndex": tree.files_done + u64::from(tree.current.is_some()), "currentFile": tree.current.as_ref().map(|file| file.relative.clone()) });
                if download.compression == CompressionMode::Gzip {
                    progress["phase"] = json!("transferring");
                }
                emitter
                    .event("sftp/transfer/progress", progress)
                    .map_err(plugin_error)?;
            }
            // 树状态回写：零拷贝转移（store_tree_state），放在 eof/进度读取
            // 之后——此前每 chunk 深拷贝整树（万文件树 × 每 256KiB 一次）且
            // 在 registry 锁内进行，是下载热路径的分配与锁竞争热点。
            {
                let mut downloads = self
                    .downloads
                    .lock()
                    .map_err(|_| "Download registry is poisoned".to_string())?;
                if let Some(current) = downloads.get_mut(task_id) {
                    if let Some(tree_state) = current.tree.as_mut() {
                        Self::store_tree_state(tree_state, &mut tree);
                    }
                }
            }
            return Ok(
                json!({ "taskId": task_id, "offset": offset, "length": length, "eof": eof, "fileName": download.file_name }),
            );
        }
    }
}
