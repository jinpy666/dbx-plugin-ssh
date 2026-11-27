use super::upload_meta::remove_upload_meta;
use super::*;

impl SshRuntime {
    pub fn transfer_list(&self, session_id: &str) -> Result<Value, String> {
        let uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?;
        let downloads = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?;
        let finishing_uploads = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?;
        let history = self
            .transfer_history
            .lock()
            .map_err(|_| "Transfer history is poisoned".to_string())?;
        let mut tasks = history
            .iter()
            .filter(|task| task.get("sessionId").and_then(Value::as_str) == Some(session_id))
            .cloned()
            .collect::<Vec<_>>();
        tasks.extend(
            uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, upload)| {
                    upload_progress_payload(
                        task_id,
                        session_id,
                        Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                        upload.received,
                        upload.expected_size,
                        UploadPhase::Staging,
                        "running",
                        upload.compression,
                    )
                })
                .collect::<Vec<_>>(),
        );
        tasks.extend(
            finishing_uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, upload)| {
                    upload_progress_payload(
                        task_id,
                        session_id,
                        Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                        upload.transferred.load(Ordering::Acquire),
                        upload.size,
                        UploadPhase::Uploading,
                        if upload.cancelled.load(Ordering::Acquire) {
                            "cancelled"
                        } else {
                            "running"
                        },
                        upload.compression,
                    )
                }),
        );
        tasks.extend(
            downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .map(|(task_id, download)| {
                    let mut row = json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "running" });
                    if let Some(tree) = download.tree.as_ref() {
                        row["fileCount"] = json!(tree.file_count);
                    }
                    row
                }),
        );
        Ok(json!({ "tasks": tasks }))
    }

    pub fn transfer_status(&self, task_id: &str) -> Result<Value, String> {
        if let Some(upload) = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .get(task_id)
        {
            let status = upload_progress_payload(
                task_id,
                &upload.session_id,
                Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                upload.received,
                upload.expected_size,
                UploadPhase::Staging,
                "running",
                upload.compression,
            );
            return Ok(status);
        }
        if let Some(upload) = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .get(task_id)
        {
            let status = upload_progress_payload(
                task_id,
                &upload.session_id,
                Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                upload.transferred.load(Ordering::Acquire),
                upload.size,
                UploadPhase::Uploading,
                if upload.cancelled.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "running"
                },
                // 显式压缩包模式在 status 上标注 lzpack（前端徽标与分母
                // 语义：压缩预压段按原始体积，推送段按压缩体积）。
                if upload.lzpack_explicit {
                    CompressionMode::Lzpack
                } else {
                    upload.compression
                },
            );
            return Ok(status);
        }
        if let Some(download) = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .get(task_id)
        {
            let mut status = json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "size": download.size, "transferred": download.next_offset, "status": "running" });
            // 并发多流预读窗口标记（ST12，optional 附加字段）：true = 本任务
            // 启用了并发预读；缺省（无字段）= 一期单步预取路径，前端零感知。
            if download.multistream.is_some() {
                status["multistream"] = json!(true);
            }
            if download.expand_lzpack {
                status["compression"] = json!("lzpack");
                status["ready"] = json!(download.ready);
                if !download.ready {
                    if let Ok(preps) = self.download_preps.lock() {
                        if let Some(prep) = preps.get(task_id) {
                            if let Ok(phase) = prep.phase.lock() {
                                status["phase"] = json!(*phase);
                            }
                        }
                    }
                }
            } else if download.compression == CompressionMode::Gzip {
                // ready-wait 的兜底轮询面（M33）：事件丢失时前端据此判断
                // prep 是否完成；进行中的 prep 阶段从 prep 注册表取。
                status["compression"] = json!("gzip");
                status["ready"] = json!(download.ready);
                if !download.ready {
                    if let Ok(preps) = self.download_preps.lock() {
                        if let Some(prep) = preps.get(task_id) {
                            if let Ok(phase) = prep.phase.lock() {
                                status["phase"] = json!(*phase);
                            }
                        }
                    }
                }
            }
            if let Some(tree) = download.tree.as_ref() {
                status["fileCount"] = json!(tree.file_count);
                status["filesRemaining"] =
                    json!(tree.files.len() + usize::from(tree.current.is_some()));
                status["currentFile"] =
                    json!(tree.current.as_ref().map(|file| file.relative.clone()));
            }
            return Ok(status);
        }
        if let Some(task) = self
            .transfer_history
            .lock()
            .map_err(|_| "Transfer history is poisoned".to_string())?
            .iter()
            .find(|task| task.get("taskId").and_then(Value::as_str) == Some(task_id))
        {
            return Ok(task.clone());
        }
        Err("Transfer task was not found".to_string())
    }

    /// `sftp/transfer/history`: merges the persisted history with the
    /// in-memory live tasks, deduplicated by taskId (the live snapshot wins
    /// because it carries fresh progress), newest first. Pure local data, so
    /// it answers without any active connection.
    pub async fn transfer_history_query(
        &self,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Value, String> {
        let sessions = self.sessions.read().await;
        let connection_id_for = |sid: &str| {
            sessions
                .get(sid)
                .map(|session| session.connection_id.clone())
                .unwrap_or_default()
        };
        self.build_transfer_history(session_id, limit, &connection_id_for)
    }

    pub fn clear_transfer_history(&self) -> Result<(), String> {
        self.transfer_history
            .lock()
            .map_err(|_| "Transfer history is poisoned".to_string())?
            .clear();
        transfer_history::clear_history(&self.data_dir)
    }

    /// Synchronous core of `transfer_history_query`; `connection_id_for`
    /// resolves the owning connection of a session (empty when unknown) so
    /// tests can inject the lookup without live sessions.
    pub(super) fn build_transfer_history(
        &self,
        session_id: Option<&str>,
        limit: usize,
        connection_id_for: &impl Fn(&str) -> String,
    ) -> Result<Value, String> {
        // Stale running/queued rows from a dead sidecar surface as failed
        // here (they are never rewritten on disk, so another live process'
        // in-flight transfers stay untouched).
        let mut tasks = transfer_history::load_history(&self.data_dir);
        for row in self.live_transfer_rows(connection_id_for) {
            let task_id = row
                .get("taskId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // The live snapshot has no start context of its own; keep the
            // persisted row's startedAt/connectionId when present.
            let mut merged = row;
            if let Some(persisted) = tasks
                .iter()
                .find(|task| task.get("taskId").and_then(Value::as_str) == Some(task_id.as_str()))
            {
                for key in ["startedAt", "connectionId"] {
                    if let Some(value) = persisted.get(key) {
                        merged[key] = value.clone();
                    }
                }
            }
            tasks.retain(|task| {
                task.get("taskId").and_then(Value::as_str) != Some(task_id.as_str())
            });
            tasks.push(merged);
        }
        if let Some(filter) = session_id {
            tasks.retain(|task| task.get("sessionId").and_then(Value::as_str) == Some(filter));
        }
        // Issue #18: the previous sort keyed on `startedAt` alone and left
        // rows without one (live rows whose start record never reached the
        // disk) stacked at the bottom in whatever order the in-memory
        // registries happened to iterate — so the same task jumped between
        // the top, middle and bottom of the panel between refreshes. A total
        // order with a taskId tiebreak keeps every poll deterministic.
        tasks.sort_by(compare_history_rows);
        tasks.truncate(limit);
        Ok(json!({ "tasks": tasks }))
    }

    /// Live snapshot rows from the in-memory transfer registries. These rows
    /// carry fresh progress but no start context; `build_transfer_history`
    /// merges them over the persisted rows. A poisoned registry is skipped:
    /// the history query stays answerable from the persisted store.
    fn live_transfer_rows(&self, connection_id_for: &impl Fn(&str) -> String) -> Vec<Value> {
        let mut rows = Vec::new();
        if let Ok(uploads) = self.uploads.lock() {
            for (task_id, upload) in uploads.iter() {
                rows.push(json!({
                    "taskId": task_id,
                    "sessionId": upload.session_id,
                    "connectionId": connection_id_for(&upload.session_id),
                    "direction": "upload",
                    "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"),
                    "size": upload.expected_size,
                    "transferred": upload.received,
                    "status": "running",
                }));
            }
        }
        if let Ok(finishing) = self.finishing_uploads.lock() {
            for (task_id, upload) in finishing.iter() {
                rows.push(json!({
                    "taskId": task_id,
                    "sessionId": upload.session_id,
                    "connectionId": connection_id_for(&upload.session_id),
                    "direction": "upload",
                    "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"),
                    "size": upload.size,
                    "transferred": upload.transferred.load(Ordering::Acquire),
                    "status": if upload.cancelled.load(Ordering::Acquire) { "cancelled" } else { "running" },
                }));
            }
        }
        if let Ok(downloads) = self.downloads.lock() {
            for (task_id, download) in downloads.iter() {
                rows.push(json!({
                    "taskId": task_id,
                    "sessionId": download.session_id,
                    "connectionId": connection_id_for(&download.session_id),
                    "direction": "download",
                    "fileName": download.file_name,
                    "size": download.size,
                    "transferred": download.next_offset,
                    "status": "running",
                }));
            }
        }
        rows
    }

    pub(super) fn record_transfer(&self, task: Value) {
        let Some(task_id) = task.get("taskId").and_then(Value::as_str) else {
            return;
        };
        if let Ok(mut history) = self.transfer_history.lock() {
            history.retain(|entry| entry.get("taskId").and_then(Value::as_str) != Some(task_id));
            history.push_back(task.clone());
            while history.len() > 64 {
                history.pop_front();
            }
        }
        // Terminal transitions also land in <data_dir>/transfer-history.json
        // so the workbench keeps them across sidecar restarts. Cross-process
        // semantics are last-writer-wins (see transfer_history.rs).
        self.persist_transfer_record(&task);
    }

    /// Persists the start transition of a transfer job. Live tasks stay in
    /// the in-memory registries; the persisted history only sees status
    /// transitions, never per-chunk progress.
    pub(super) fn record_transfer_start(
        &self,
        task_id: &str,
        session_id: &str,
        connection_id: &str,
        direction: &str,
        file_name: &str,
        size: u64,
    ) {
        self.persist_transfer_record(&json!({
            "taskId": task_id,
            "sessionId": session_id,
            "connectionId": connection_id,
            "direction": direction,
            "fileName": file_name,
            "size": size,
            "transferred": 0,
            "status": "running",
            "startedAt": unix_now_ms(),
            "finishedAt": Value::Null,
        }));
    }

    /// Best-effort persistence of one status transition; a failed write is
    /// logged but never fails the transfer itself (history is UX data, not
    /// an audit ledger).
    fn persist_transfer_record(&self, task: &Value) {
        if let Err(error) = transfer_history::record_transition(&self.data_dir, task) {
            eprintln!("[ssh-trace] failed to persist transfer history: {error}");
        }
    }

    /// Connection owning a session, or empty when the session is no longer
    /// registered (sidecar restarted after the workbench attached).
    pub(super) async fn session_connection_id(&self, session_id: &str) -> String {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|session| session.connection_id.clone())
            .unwrap_or_default()
    }

    /// 会话级传输并发深度（M14-B）：偏好 `transfer_max_active` 可配
    /// （1..=8，缺省 3 = 历史硬编码值）；老旧服务器兼容模式下强制 1。
    /// 每次任务启动现读现用——改动即时生效，进行中的任务按原深度自然完成。
    pub(super) fn transfer_depth_limit(&self) -> u64 {
        if crate::preferences::sftp_compat_mode(&self.data_dir) {
            return 1;
        }
        crate::preferences::transfer_max_active(&self.data_dir)
    }

    pub(super) fn active_transfer_count(&self, session_id: &str) -> Result<usize, String> {
        let uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .values()
            .filter(|upload| upload.session_id == session_id)
            .count();
        let downloads = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .values()
            .filter(|download| download.session_id == session_id)
            .count();
        let finishing_uploads = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .values()
            .filter(|upload| upload.session_id == session_id)
            .count();
        Ok(uploads + finishing_uploads + downloads)
    }

    pub(super) async fn cleanup_session_transfers(&self, session_id: &str) -> Result<(), String> {
        let removed_uploads = {
            let mut uploads = self
                .uploads
                .lock()
                .map_err(|_| "Upload registry is poisoned".to_string())?;
            let task_ids = uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>();
            task_ids
                .into_iter()
                .filter_map(|task_id| uploads.remove_entry(&task_id))
                .collect::<Vec<_>>()
        };
        for (task_id, upload) in removed_uploads {
            let _ = std::fs::remove_file(&upload.local_path);
            // 压缩预压半成品与 sidecar meta 同属本任务（评审 L-2）：完成
            // 路径已清的这里重复删除无害。
            let _ = std::fs::remove_file(format!("{}.gz", upload.local_path.display()));
            remove_upload_meta(&self.transfer_dir, &task_id);
            // A session close aborts its unfinished uploads; record them as
            // failed so the persisted history keeps no silent ghosts.
            self.persist_transfer_record(&json!({
                "taskId": task_id,
                "sessionId": upload.session_id,
                "direction": "upload",
                "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"),
                "size": upload.expected_size,
                "transferred": upload.received,
                "status": "failed",
                "error": "Transfer was aborted because the session closed",
            }));
        }
        let removed_downloads = {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download registry is poisoned".to_string())?;
            let task_ids = downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>();
            task_ids
                .into_iter()
                .filter_map(|task_id| downloads.remove_entry(&task_id))
                .collect::<Vec<_>>()
        };
        for (task_id, download) in removed_downloads {
            // 会话关闭与取消是等价的清理事件（评审 H-2）：树半成品根、
            // 压缩 plain/.gz、远端临时件统一穿过 cleanup_download_assets，
            // 不再只删 sink .part。（registry guard 不跨 await——摘除在
            // 锁内完成，清理在锁外执行。）
            self.cleanup_download_assets(&download.session_id, &download)
                .await;
            self.persist_transfer_record(&json!({
                "taskId": task_id,
                "sessionId": download.session_id,
                "direction": "download",
                "fileName": download.file_name,
                "size": download.size,
                "transferred": download.next_offset,
                "status": "failed",
                "error": "Transfer was aborted because the session closed",
            }));
        }
        for upload in self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .values()
            .filter(|upload| upload.session_id == session_id)
        {
            upload.cancelled.store(true, Ordering::Release);
        }
        if let Ok(mut history) = self.transfer_history.lock() {
            history
                .retain(|task| task.get("sessionId").and_then(Value::as_str) != Some(session_id));
        }
        Ok(())
    }
}
