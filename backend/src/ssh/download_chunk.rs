use super::state::{DownloadState, MultistreamState};
use super::*;

impl SshRuntime {
    pub async fn download_chunk(
        self: &Arc<Self>,
        task_id: &str,
        offset: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let download = {
            let downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download registry is poisoned".to_string())?;
            downloads
                .get(task_id)
                .cloned()
                .ok_or("Download task was not found")?
        };
        // 读侧快照对树任务仍是一次整树深拷贝（files 队列 + failures 随
        // chunk 数 O(n²) 增长）；彻底消除需要把 tree 改成 Arc<tokio::Mutex>
        // 并让 status/cancel/finish 全链路加锁——登记为后续项，当前网络腿
        // IO 仍占大头，先不动结构。
        if download.tree.is_some() {
            return self
                .download_tree_chunk(task_id, offset, download, emitter)
                .await;
        }
        // staged 车道分派（M33 gzip 与 ST10 lzpack 解压下载共用）：压缩任
        // 务的原始字节都来自本地 staged plain 文件。
        if download.expand_lzpack
            || (download.compression == CompressionMode::Gzip && !download.serving_plain)
        {
            return self
                .download_staged_chunk(task_id, offset, download, emitter)
                .await;
        }
        if offset != download.next_offset {
            // offset 失配（续传跳片/重试乱序）：并发预读窗口整窗作废（ST12，
            // 与一期预取槽「失配即作废」同语义），防止跨跳供给陈块。降级
            // 状态保留——降级是本任务生命周期事实，不因作废重置。
            if let Some(state) = download.multistream.as_ref() {
                state.window.lock().await.clear();
            }
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
        let remaining = download.size.saturating_sub(offset);
        let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
        // 限速节奏（issue #66）：块耗时从读开始计量（含网络/磁盘），读毕
        // 由 limiter 补足差额等待。限速关闭时 Throttle::pace 是纯即时调用，
        // 热路径零开销。
        let chunk_started = download.throttle.enabled().then(std::time::Instant::now);
        // 预取命中（ST9）：上一片返回时后台预读的本片已在槽里，直接取出，
        // 省一个整 RTT。仅普通单文件下载启用（树/压缩/latin-1 车道不预取）；
        // 槽 offset 与本片请求不一致即作废（续传/重试跳片安全）。
        // 并发预读窗口车道（ST12）启用时走窗口分支，一期单步预取不再叠加
        // （两套在途读会双倍打服务端并发，收益不增）。
        let prefetchable = download.multistream.is_none()
            && download.compression == CompressionMode::None
            && !(download.latin1 && sftp_name::has_wire_escapes(&download.remote_path));
        let mut served_from_prefetch = false;
        let chunk = if let Some(state) = download.multistream.as_ref() {
            // 窗口命中（(offset, len) 精确匹配，末块短读/跳片天然失配）直接
            // 回——后台并发读已把本片备好；未命中（预读未完成/已降级）同步
            // 读兜底。分块供给顺序与二进制帧形状不变，并发只发生在 sidecar
            // 内部的「预读未到来分块」上。
            let hit = state.window.lock().await.take(offset, requested);
            match hit {
                Some(hit) => hit,
                None => {
                    self.read_plain_download_chunk(&download, offset, requested)
                        .await?
                }
            }
        } else if prefetchable {
            let mut slot = download.prefetch.lock().await;
            match slot.take() {
                Some((hit_offset, hit_chunk))
                    if hit_offset == offset && hit_chunk.len() == requested =>
                {
                    served_from_prefetch = true;
                    hit_chunk
                }
                Some(_) | None => {
                    // 槽空/过期：正常同步读。
                    drop(slot);
                    self.read_plain_download_chunk(&download, offset, requested)
                        .await?
                }
            }
        } else {
            self.read_plain_download_chunk(&download, offset, requested)
                .await?
        };
        // 限速等待在读毕、本地落盘之前：等待本身计入下一块之前的墙钟，
        // 且不会推迟本地写完成的应答语义（前端循环按块等待）。
        if let (true, Some(started)) = (download.throttle.enabled(), chunk_started) {
            download.throttle.pace(chunk.len(), started.elapsed()).await;
        }
        let length = chunk.len();
        if let Some(sink) = download.sink.as_ref() {
            sink.file
                .lock()
                .await
                .write_all(&chunk)
                .await
                .map_err(|error| format!("Failed to write local download file: {error}"))?;
        }
        let next_offset = offset.saturating_add(length as u64);
        let mut payload = Vec::with_capacity(8 + length);
        payload.extend_from_slice(&offset.to_be_bytes());
        payload.extend_from_slice(&chunk);
        emitter
            .binary(&format!("sftp/download/{task_id}"), &payload)
            .map_err(plugin_error)?;
        // 进度事件时间窗节流（progress_throttle）：每块一条 IPC 事件在
        // 大文件下约 200 条/秒，直驱前端重渲染；终块必发保证进度条终值。
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
        if emit_progress {
            emitter
                .event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "transferred": next_offset, "size": download.size, "status": "running" }),
                )
                .map_err(plugin_error)?;
        }
        // 窗口回填（ST12，issue #237 二期）：供给推进后按窗口目标补发并发
        // 预读。规划在窗口锁内完成（目标置在途，防重复发）；读任务用轮转
        // 槽位的独立句柄并发读远端，结果回窗，失败整窗降级单流（错误不打
        // 断任务，由同步车道按原语义浮出）。降级/EOF 后 plan 返回空，不再
        // 发起。取消/终态无需专门清理：窗口任务只写窗口（Arc 随任务回收），
        // 不触碰 sink/远端。
        if let Some(state) = download.multistream.as_ref() {
            let plan = {
                let mut window = state.window.lock().await;
                window.plan(next_offset, download.size, TRANSFER_CHUNK_SIZE as u64)
            };
            let spawn_task_id = task_id.to_string();
            for (read_offset, read_len) in plan {
                let this = self.clone_for_download_prefetch();
                let download = download.clone();
                let state = Arc::clone(state);
                let slot = state.pick_slot();
                let task_id = spawn_task_id.clone();
                tokio::spawn(async move {
                    match this
                        .read_window_chunk(&download, &state, slot, read_offset, read_len)
                        .await
                    {
                        Ok(data) => state.window.lock().await.complete(read_offset, data),
                        Err(error) => {
                            eprintln!(
                                "[sftp] multistream {task_id} read offset {read_offset} failed: {error}"
                            );
                            let degraded = state.window.lock().await.fail(read_offset);
                            if degraded {
                                eprintln!(
                                    "[sftp] multistream {task_id} degraded to single-stream (read-ahead aborted)"
                                );
                            }
                            if is_channel_level_sftp_error(&error) {
                                this.invalidate_sftp_cache(&download.session_id).await;
                            }
                        }
                    }
                });
            }
        }
        // 预取下一片（ST9）：仅当本片非 EOF、限速关闭（限速节奏下预取会
        // 打乱配速）且本次不是预取命中时发起；命中时后台任务通常还在跑，
        // 槽仍为空则补发一次。预读失败静默丢弃（槽保持空，下一片同步读）。
        if prefetchable
            && next_offset < download.size
            && !download.throttle.enabled()
            && !served_from_prefetch
        {
            let this = self.clone_for_download_prefetch();
            let download = download.clone();
            let prefetch_offset = next_offset;
            let prefetch_len = download
                .size
                .saturating_sub(prefetch_offset)
                .min(TRANSFER_CHUNK_SIZE as u64) as usize;
            tokio::spawn(async move {
                // 预取失败不打断主流程，下一片同步读兜底。
                if let Ok(prefetched) = this
                    .read_plain_download_chunk(&download, prefetch_offset, prefetch_len)
                    .await
                {
                    *download.prefetch.lock().await = Some((prefetch_offset, prefetched));
                }
            });
        }
        Ok(
            json!({ "taskId": task_id, "offset": offset, "length": length, "eof": next_offset >= download.size, "fileName": download.file_name }),
        )
    }

    /// download_chunk 的 Arc 派生入口（预取任务用）：download_chunk 本就
    /// 定义在 `Arc<Self>` 上（start_download 同款）。
    fn clone_for_download_prefetch(self: &Arc<Self>) -> Arc<Self> {
        Arc::clone(self)
    }

    /// 普通单文件下载的分片读取（原 download_chunk 内联逻辑抽取）：latin-1
    /// 转义名走裸包 READ，其余走高层句柄复用 seek+read。错误语义与抽取前
    /// 一致：句柄错误弃槽、通道级错误连带失效 SFTP 客户端缓存。
    async fn read_plain_download_chunk(
        &self,
        download: &DownloadState,
        offset: u64,
        requested: usize,
    ) -> Result<Vec<u8>, String> {
        if download.latin1 && sftp_name::has_wire_escapes(&download.remote_path) {
            return self
                .raw_read_chunk_cached(
                    &download.session_id,
                    &download.raw_client,
                    &download.remote_path,
                    offset,
                    requested as u32,
                )
                .await;
        }
        self.read_highlevel_chunk(
            &download.session_id,
            &download.remote_path,
            &download.read_handle,
            offset,
            requested,
        )
        .await
    }

    /// 并发预读窗口的分片读取（ST12）：恒走高层车道（窗口车道 start 时已
    /// 排除裸包转义名），使用轮转槽位的独立句柄——并发读共用 `read_handle`
    /// 会被槽锁串行化，分槽才能真并发。错误语义与同步车道一致。
    async fn read_window_chunk(
        &self,
        download: &DownloadState,
        state: &MultistreamState,
        slot: usize,
        offset: u64,
        requested: usize,
    ) -> Result<Vec<u8>, String> {
        let handle = state.stream_handle(slot);
        self.read_highlevel_chunk(
            &download.session_id,
            &download.remote_path,
            &handle,
            offset,
            requested,
        )
        .await
    }

    /// 高层车道分片读取（句柄复用）：首片 open 后缓存在句柄槽（File 的
    /// Drop 发 close_nowait，槽位置 None 即完成关闭），后续片直接 seek+read
    /// ——逐片 OPEN/READ/CLOSE 每片多付 2 个 RTT，高延迟链路吞吐被 RTT 界
    /// 死。seek 用绝对 offset，断点续传/重试跳片/并发多流各自持有句柄同样
    /// 成立。错误弃柄（下一片惰性重建）；通道级错误连带失效整个 SFTP 客户
    /// 端缓存——死通道被原样复用会把该会话 SFTP 打到永久报错（误判无害：
    /// 重建只是多一次握手）。
    async fn read_highlevel_chunk(
        &self,
        session_id: &str,
        remote_path: &str,
        handle_slot: &AsyncMutex<Option<russh_sftp::client::fs::File>>,
        offset: u64,
        requested: usize,
    ) -> Result<Vec<u8>, String> {
        let read_result: Result<Vec<u8>, String> = async {
            let sftp = self.sftp(session_id).await?;
            let mut handle_slot = handle_slot.lock().await;
            if handle_slot.is_none() {
                let opened = sftp
                    .lock()
                    .await
                    .open(remote_path.to_string())
                    .await
                    .map_err(sftp_error)?;
                *handle_slot = Some(opened);
            }
            let source = handle_slot.as_mut().expect("handle just ensured");
            source
                .seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| format!("SFTP download seek failed: {error}"))?;
            let mut chunk = vec![0_u8; requested];
            let length = source
                .read(&mut chunk)
                .await
                .map_err(|error| format!("SFTP download failed: {error}"))?;
            chunk.truncate(length);
            Ok(chunk)
        }
        .await;
        match read_result {
            Ok(chunk) => Ok(chunk),
            Err(error) => {
                // 读失败即弃句柄（下一片惰性重建）；通道级错误连带失效
                // 整个 SFTP 客户端缓存——死通道被原样复用会把该会话
                // SFTP 打到永久报错（误判无害：重建只是多一次握手）。
                *handle_slot.lock().await = None;
                if is_channel_level_sftp_error(&error) {
                    self.invalidate_sftp_cache(session_id).await;
                }
                Err(error)
            }
        }
    }

    /// `sftp/transfer/cancel`. `reason` is an optional workbench slug ("user",
    /// "ack-timeout", ...) recorded in the ledger event so a cancellation can
    /// be told apart from a server failure on the next bug report.
    /// 统一清理一个下载任务的全部临时资产（2026-09-30 收口，评审 H-2）：
    /// sink .part、树半成品根目录、sudo 远端暂存、压缩任务的 plain 解压
    /// 暂存/本地压缩流/远端 .gz。best-effort——路径可缺失，完成/取消/会话
    /// 关闭多路径穿过这里，重复删除只是一次无害的 NoSuchFile。远端删除
    /// 需要会话，会话已死时记 stderr（本地资产是会话关闭场景的主清理面）。
    pub(super) async fn cleanup_download_assets(&self, session_id: &str, download: &DownloadState) {
        if let Some(sink) = download.sink.as_ref() {
            let _ = std::fs::remove_file(&sink.part_path);
        }
        // 文件夹下载：整棵半成品目录删除，不在下载目录里留部分内容（根
        // 目录是本任务创建的让位新目录，删除不伤及他物）。
        if let Some(tree) = download.tree.as_ref() {
            let _ = std::fs::remove_dir_all(&tree.root_local);
        }
        if let Some(tmp) = download.sudo_tmp.as_ref() {
            if let Err(error) = sudo_download::discard_tmp(self, session_id, tmp).await {
                eprintln!("[sudo-download] temp cleanup failed ({tmp}): {error}");
            }
        }
        if download.compression == CompressionMode::Gzip || download.expand_lzpack {
            if let Some(staged) = download.staged_plain.as_ref() {
                let _ = std::fs::remove_file(staged);
            }
            if let Some(gz) = download.gz_staging.as_ref() {
                let _ = std::fs::remove_file(gz);
            }
            if let Some(tmp) = download.remote_temp.as_ref() {
                match self.sftp(session_id).await {
                    Ok(sftp) => {
                        if let Err(error) = sftp.lock().await.remove_file(tmp.clone()).await {
                            eprintln!("[sftp] cleanup: remote temp not removed: {error}");
                        }
                    }
                    Err(error) => eprintln!("[sftp] cleanup: session unavailable: {error}"),
                }
            }
        }
    }
}
