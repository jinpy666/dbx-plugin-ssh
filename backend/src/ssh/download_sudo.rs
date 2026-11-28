use super::state::{DownloadSink, DownloadState};
use super::*;

impl SshRuntime {
    /// Creates the optional local sink (staging `.part` file) shared by
    /// `sftp/download/start` and `sudo/download/start`.
    pub(super) async fn build_download_sink(
        &self,
        task_id: &str,
        download_dir: Option<&str>,
        conflict: Option<&str>,
    ) -> Result<Option<Arc<DownloadSink>>, String> {
        let staging = self.transfer_dir.join("downloads");
        std::fs::create_dir_all(&staging)
            .map_err(|error| format!("Failed to create download staging directory: {error}"))?;
        let part_path = staging.join(format!("download-{task_id}.part"));
        let final_dir = download_dir
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                local_downloads::downloads_base_dir(|key| std::env::var_os(key), &self.data_dir)
            });
        if !final_dir.is_absolute() {
            return Err("Download directory must be an absolute path".to_string());
        }
        std::fs::create_dir_all(&final_dir).map_err(|error| {
            format!(
                "Failed to create download directory '{}': {error}",
                final_dir.display()
            )
        })?;
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part_path)
            .await
            .map_err(|error| {
                format!(
                    "Failed to create local download file '{}': {error}",
                    part_path.display()
                )
            })?;
        Ok(Some(Arc::new(DownloadSink {
            part_path,
            final_dir,
            overwrite: matches!(conflict, Some("overwrite")),
            file: AsyncMutex::new(file),
        })))
    }

    /// `sudo/download/start`: root-owned files streamed through the regular
    /// SFTP download pipeline (M14-C DownloadSudo). The source is staged into
    /// a same-directory sudo temp file (`sudo_download::stage_source`) which
    /// is registered as the task's read source; `sftp/download/next`,
    /// `sftp/download/finish` and the progress events are reused unchanged.
    /// The temp file is removed on finish, cancel, error and session close
    /// (finally semantics; cleanup failures surface as a non-fatal warning).
    #[allow(clippy::too_many_arguments)]
    pub async fn start_sudo_download(
        &self,
        session_id: &str,
        path: &str,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        // 与其余 start 路径同走 transfer_depth_limit（M14-B 偏好与 compat
        // 模式强制 1 都要约束 sudo 车道；此前字面 3 绕过了两者）。
        if self.active_transfer_count(session_id)? as u64 >= self.transfer_depth_limit() {
            return Err(format!(
                "This SSH session already has {} active transfers",
                self.transfer_depth_limit()
            ));
        }
        let staged = sudo_download::stage_source(self, session_id, path).await?;
        let outcome = self
            .start_sudo_download_staged(
                session_id,
                &staged,
                save_to_local,
                download_dir,
                conflict,
                emitter,
            )
            .await;
        if outcome.is_err() {
            // 注册失败也要把远端临时件收掉，不能等下载循环来清。
            if let Err(error) = sudo_download::discard_tmp(self, session_id, &staged.tmp_path).await
            {
                eprintln!(
                    "[sudo-download] staging temp cleanup failed ({}): {error}",
                    staged.tmp_path
                );
            }
        }
        outcome
    }

    async fn start_sudo_download_staged(
        &self,
        session_id: &str,
        staged: &sudo_download::StagedSource,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        if staged.size > MAX_TRANSFER_SIZE {
            return Err(format!(
                "Transfers are limited to {MAX_TRANSFER_SIZE} bytes"
            ));
        }
        // SFTP 提前探测：源目录对登录用户不可穿越（如 /root 0700）时，普通
        // SFTP 读不到临时件——在这里给出明确错误，而不是第一块分块才失败。
        let sftp = self.sftp(session_id).await?;
        sftp.lock()
            .await
            .metadata(staged.tmp_path.clone())
            .await
            .map_err(sftp_error)?;
        let task_id = Uuid::new_v4().to_string();
        let sink = if save_to_local {
            self.build_download_sink(&task_id, download_dir, conflict)
                .await?
        } else {
            None
        };
        self.downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                DownloadState {
                    session_id: session_id.to_string(),
                    remote_path: staged.tmp_path.clone(),
                    file_name: staged.file_name.clone(),
                    size: staged.size,
                    next_offset: 0,
                    sink,
                    tree: None,
                    sudo_tmp: Some(staged.tmp_path.clone()),
                    // sudo 下载走独立车道（sudo_download.rs），读侧不经
                    // has_wire_lane 判分支；字面 false 只做字段填充。
                    latin1: false,
                    // sudo 车道本期不在限速范围（issue #66 收敛在 SFTP
                    // 下载），字段照常填充但快照取 0（不限速）。
                    throttle: Throttle::new(0),
                    progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                    // sudo 车道不参与压缩通道（M33）：远端临时件机制独立。
                    compression: CompressionMode::None,
                    ready: false,
                    serving_plain: false,
                    staged_plain: None,
                    gz_staging: None,
                    remote_temp: None,
                    final_dir: None,
                    overwrite: false,
                    read_handle: Arc::new(AsyncMutex::new(None)),
                    raw_client: Arc::new(AsyncMutex::new(None)),
                    expand_lzpack: false,
                    prefetch: Arc::new(AsyncMutex::new(None)),
                    multistream: None,
                },
            );
        emitter
            .event(
                "sftp/transfer/progress",
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": 0, "size": staged.size, "status": "queued" }),
            )
            .map_err(plugin_error)?;
        let connection_id = self.session_connection_id(session_id).await;
        self.record_transfer_start(
            &task_id,
            session_id,
            &connection_id,
            "download",
            &staged.file_name,
            staged.size,
        );
        Ok(
            json!({ "taskId": task_id, "fileName": staged.file_name, "size": staged.size, "chunkSize": TRANSFER_CHUNK_SIZE, "resumeOffset": 0_u64, "saveToLocal": save_to_local, "sudo": true }),
        )
    }
}
