use super::state::{DownloadSink, DownloadState, UploadPhase};
use super::*;

impl SshRuntime {
    pub async fn cancel_transfer(
        &self,
        task_id: &str,
        reason: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<(), String> {
        let upload = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .remove(task_id);
        let download = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .remove(task_id);
        let finishing = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .get(task_id)
            .map(|upload| {
                upload.cancelled.store(true, Ordering::Release);
                if let Ok(mut slot) = upload.cancel_reason.lock() {
                    if slot.is_none() {
                        *slot = reason.map(str::to_string);
                    }
                }
                let mut task = upload_progress_payload(
                    task_id,
                    &upload.session_id,
                    Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                    upload.transferred.load(Ordering::Acquire),
                    upload.size,
                    UploadPhase::Uploading,
                    "cancelled",
                    upload.compression,
                );
                task["error"] = json!(upload_cancel_error(reason));
                (
                    task,
                    upload.session_id.clone(),
                    upload.remote_path.clone(),
                    upload.sudo_staging.clone(),
                )
            });
        // 压缩下载 prep（M33）：置取消旗标让 prep 循环在块边界退出；prep
        // 独占（任务已不在 downloads registry 的竞窗）时由这里直接清理。
        let prep = self
            .download_preps
            .lock()
            .map_err(|_| "Download prep registry is poisoned".to_string())?
            .get(task_id)
            .map(|prep| {
                prep.cancelled.store(true, Ordering::Release);
                if let Ok(mut slot) = prep.cancel_reason.lock() {
                    if slot.is_none() {
                        *slot = reason.map(str::to_string);
                    }
                }
                (
                    prep.remote_temp.clone(),
                    prep.gz_staging.clone(),
                    prep.session_id.clone(),
                )
            });
        if let Some(upload) = upload.as_ref() {
            let _ = std::fs::remove_file(&upload.local_path);
            remove_upload_meta(&self.transfer_dir, task_id);
        }
        if let Some(download) = download.as_ref() {
            self.cleanup_download_assets(&download.session_id, download)
                .await;
        }
        // prep 独占的取消（任务条目已被先前的取消摘除）：直接清压缩产物。
        if let (true, Some((remote_temp, gz_staging, session_id))) =
            (download.is_none(), prep.as_ref())
        {
            if let Some(tmp) = remote_temp {
                if let Ok(sftp) = self.sftp(session_id).await {
                    let _ = sftp.lock().await.remove_file(tmp.clone()).await;
                }
            }
            let _ = std::fs::remove_file(gz_staging);
        }
        if upload.is_none() && download.is_none() && finishing.is_none() && prep.is_none() {
            return Err("Transfer task was not found".to_string());
        }
        // 推送阶段取消的远端收尾提前：推送循环要到下一个分块边界才观察到
        // cancelled 标志并自行删除远端临时文件，取消 RPC 返回后立刻列目录会
        // 看见最长一个分块周期的 .part 残留（#60 回归记录的竞窗）。这里
        // best-effort 提前删掉推送暂存件。只删暂存件，绝不碰 .backup——取消
        // 可能与提交链的 target→backup→target 往返并发，删 backup 会破坏回滚；
        // 与推送循环自身的 remove 并发安全（重复删除只是一次无害的 NoSuchFile）。
        // sudo 车道（UploadSudo）的推送暂存件在登录用户 home 下，按注册时
        // 定死的 sudo_staging 删，不落目标目录。
        if let Some((_, session_id, remote_path, sudo_staging)) = finishing.as_ref() {
            let temporary = match sudo_staging.as_ref() {
                Some(staging) => staging.clone(),
                None => match remote_transfer_paths(remote_path, task_id) {
                    Ok((temporary, _backup)) => temporary,
                    Err(_) => String::new(),
                },
            };
            if !temporary.is_empty() {
                match self.sftp(session_id).await {
                    Ok(sftp) => {
                        if let Err(error) = sftp.lock().await.remove_file(temporary).await {
                            eprintln!("[sftp] cancel cleanup: remote temp not removed: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("[sftp] cancel cleanup: session unavailable: {error}")
                    }
                }
            }
        }
        let finishing = finishing.map(|(task, _, _, _)| task);
        let task = upload
            .as_ref()
            .map(|upload| {
                let mut task = upload_progress_payload(
                    task_id,
                    &upload.session_id,
                    Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                    upload.received,
                    upload.expected_size,
                    UploadPhase::Staging,
                    "cancelled",
                    upload.compression,
                );
                task["error"] = json!(upload_cancel_error(reason));
                task
            })
            .or_else(|| download.as_ref().map(|download| json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "cancelled" })))
            .or(finishing)
            .expect("a transfer was present");
        eprintln!(
            "[sftp] transfer {task_id} cancelled (reason={})",
            reason.unwrap_or("unspecified")
        );
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)
    }

    pub async fn complete_download(
        &self,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let download = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .remove(task_id)
            .ok_or("Download task was not found".to_string())?;
        if download.tree.is_some() {
            return self
                .complete_tree_download(download, task_id, emitter)
                .await;
        }
        let sudo_tmp = download.sudo_tmp.clone();
        let session_id = download.session_id.clone();
        // 压缩任务终态清理条件（M33 gzip 与 ST10 lzpack 解压下载同骨架）：
        // lzpack 的 gz_staging 槽放的是 packed 暂存件（.part.dbxz），remote_temp
        // 恒为 None（无远端临时件）。
        let compressed_cleanup =
            (download.compression == CompressionMode::Gzip || download.expand_lzpack).then(|| {
                (
                    download.remote_temp.clone(),
                    download.gz_staging.clone(),
                    download.staged_plain.clone(),
                    download.final_dir.is_none(),
                )
            });
        let result = self
            .complete_single_file_download(download, task_id, emitter)
            .await;
        // 压缩任务终态（M33，finally 语义）：远端 .gz 与本地压缩流暂存在
        // 完成/失败两条路径都清；plain 解压暂存只在「浏览器模式且成功」时
        // 清（字节已在前端）——saveToLocal 失败保留，与普通 .part「字节不
        // 丢」语义一致。
        if let Some((remote_temp, gz_staging, staged_plain, browser_mode)) = compressed_cleanup {
            self.cleanup_compressed_download(
                &session_id,
                remote_temp.as_deref(),
                gz_staging.as_deref(),
                staged_plain
                    .as_deref()
                    .filter(|_| browser_mode && result.is_ok()),
            )
            .await;
        }
        // finally 语义：sudo 下载的远端临时件在完成/失败两条路径上都要清理；
        // 清理失败不吞掉原结果，只在成功响应上附加 warning 兜底提示。
        if let Some(tmp) = sudo_tmp {
            match sudo_download::discard_tmp(self, &session_id, &tmp).await {
                Ok(()) => {}
                Err(error) => {
                    eprintln!("[sudo-download] temp cleanup failed ({tmp}): {error}");
                    let mut result = result;
                    if let Ok(response) = result.as_mut() {
                        response["warning"] = json!(format!(
                            "Remote sudo temp file cleanup failed: {tmp} ({error})"
                        ));
                    }
                    return result;
                }
            }
        }
        result
    }

    /// Single-file half of `sftp/download/finish`, extracted so the sudo
    /// variant can run its remote temp cleanup around it.
    async fn complete_single_file_download(
        &self,
        download: DownloadState,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let record_failed = |error: &str| {
            self.record_transfer(json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "failed", "error": error }));
        };
        if download.next_offset < download.size {
            let error = format!(
                "Download is incomplete: received {} of {} bytes",
                download.next_offset, download.size
            );
            // The task dies here without reaching the completed path, so
            // the failure is recorded explicitly.
            record_failed(&error);
            return Err(error);
        }
        let local_path = if let Some(staged) = download.staged_plain.as_ref() {
            // 压缩任务（M33）：saveToLocal 由解压暂存 rename 落位（浏览器
            // 模式字节在前端，暂存由 complete_download 包装层清理）。
            match download.final_dir.as_ref() {
                Some(dir) => {
                    match Self::finalize_staged_plain(
                        staged,
                        dir,
                        download.overwrite,
                        &download.file_name,
                    ) {
                        Ok(path) => Some(path),
                        Err(error) => {
                            record_failed(&error);
                            return Err(error);
                        }
                    }
                }
                None => None,
            }
        } else {
            match download.sink.as_ref() {
                None => None,
                Some(sink) => {
                    match Self::finalize_download_sink(self, sink, &download.file_name).await {
                        Ok(path) => Some(path),
                        Err(error) => {
                            record_failed(&error);
                            return Err(error);
                        }
                    }
                }
            }
        };
        let mut task = json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.size, "status": "completed" });
        if let Some(path) = local_path.as_ref() {
            task["localPath"] = json!(path.to_string_lossy());
        }
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)?;
        Ok(json!({
            "success": true,
            "taskId": task_id,
            "localPath": local_path.as_ref().map(|path| path.to_string_lossy()),
        }))
    }

    /// Tree flavor of `sftp/download/finish`: every queued file must be
    /// drained (eof), otherwise the whole folder is torn down — there is no
    /// tree resume, so a half-downloaded folder never lingers on disk. A
    /// drained tree completes even when individual files failed: the summary
    /// (`failedCount` + inline samples) is the contract for the workbench
    /// notice.
    async fn complete_tree_download(
        &self,
        download: DownloadState,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let Some(tree) = download.tree.clone() else {
            return Err("Download task is not a folder download".to_string());
        };
        // 压缩树（M33）终态清理：远端 .tgz 与本地压缩流暂存在此入口即清
        // （解包已在 prep 完成，完成/未完成两态都不再需要；finally 语义与
        // sudo 临时件同向，取消路径由 cancel_transfer 负责）。清理失败不
        // 吞掉原结果，只留 stderr 诊断。
        if download.compression == CompressionMode::Gzip {
            self.cleanup_compressed_download(
                &download.session_id,
                download.remote_temp.as_deref(),
                download.gz_staging.as_deref(),
                None,
            )
            .await;
        }
        let remaining = tree.files.len() + usize::from(tree.current.is_some());
        if remaining > 0 {
            // 未传完：整树拆除（无目录续传语义），失败入账。
            let _ = std::fs::remove_dir_all(&tree.root_local);
            let error =
                format!("Folder download is incomplete: {remaining} file(s) not transferred");
            self.record_transfer(json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "failed", "error": error }));
            return Err(error);
        }
        if let Some(sink) = tree.sink.as_ref() {
            // 正常路径不会到达（current 已全部收尾）；防御性清理残留 .part。
            let _ = std::fs::remove_file(&sink.part_path);
        }
        let (failed_count, failed_files) = sftp_tree::failure_report(&tree.failures);
        // 压缩树（M33）：staging 树 rename 落到最终名（staging 是落点目录
        // 内的隐藏目录，同卷 rename 零拷贝；跨卷失败递归拷贝兜底）。落位
        // 失败保留 staging 并按失败入账（与 sink 的「字节不丢」同向）。
        let final_root = if download.compression == CompressionMode::Gzip {
            match download.final_dir.as_ref() {
                Some(dir) => {
                    match Self::finalize_tree_staging(&tree.root_local, dir, &download.file_name) {
                        Ok(path) => path,
                        Err(error) => {
                            let error =
                                format!("Failed to move the downloaded folder into place: {error}");
                            self.record_transfer(json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "failed", "error": error }));
                            return Err(error);
                        }
                    }
                }
                None => tree.root_local.clone(),
            }
        } else {
            tree.root_local.clone()
        };
        let mut task = json!({
            "taskId": task_id, "sessionId": download.session_id, "direction": "download",
            "fileName": download.file_name, "size": download.size, "transferred": download.next_offset,
            "status": "completed",
            "fileCount": tree.file_count, "failedCount": failed_count, "skippedCount": tree.skipped,
        });
        task["localPath"] = json!(final_root.to_string_lossy());
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)?;
        Ok(json!({
            "success": true,
            "taskId": task_id,
            "localPath": final_root.to_string_lossy(),
            "fileCount": tree.file_count,
            "failedCount": failed_count,
            "skippedCount": tree.skipped,
            "failedFiles": failed_files,
        }))
    }

    /// Flushes the staging file and moves it to its final non-colliding name
    /// in the user's Downloads folder. Rename first (same volume = cheap);
    /// staging and Downloads can live on different volumes, so a failed rename
    /// falls back to copy+delete. The staging file survives failures so the
    /// bytes are never lost silently.
    pub(super) async fn finalize_download_sink(
        &self,
        sink: &DownloadSink,
        file_name: &str,
    ) -> Result<PathBuf, String> {
        {
            let file = sink.file.lock().await;
            file.sync_all()
                .await
                .map_err(|error| format!("Failed to flush local download file: {error}"))?;
        }
        let final_path =
            local_downloads::final_download_path(&sink.final_dir, file_name, sink.overwrite);
        if std::fs::rename(&sink.part_path, &final_path).is_ok() {
            return Ok(final_path);
        }
        std::fs::copy(&sink.part_path, &final_path)
            .and_then(|_| std::fs::remove_file(&sink.part_path))
            .map_err(|error| {
                format!(
                    "Failed to move the download into '{}': {error}",
                    final_path.display()
                )
            })?;
        Ok(final_path)
    }

    /// 压缩单文件任务 saveToLocal 落位（M33）：解压暂存 rename（同卷）→
    /// 跨卷回退 copy+delete，语义与 [`Self::finalize_download_sink`] 对齐。
    fn finalize_staged_plain(
        staged: &Path,
        final_dir: &Path,
        overwrite: bool,
        file_name: &str,
    ) -> Result<PathBuf, String> {
        let final_path = local_downloads::final_download_path(final_dir, file_name, overwrite);
        if std::fs::rename(staged, &final_path).is_ok() {
            return Ok(final_path);
        }
        std::fs::copy(staged, &final_path)
            .and_then(|_| std::fs::remove_file(staged))
            .map_err(|error| {
                format!(
                    "Failed to move the download into '{}': {error}",
                    final_path.display()
                )
            })?;
        Ok(final_path)
    }

    /// 压缩树任务落位（M33）：staging 树 rename 成最终根名（staging 是落
    /// 点目录内的隐藏目录，同卷 rename 几乎必成）；跨卷失败递归拷贝兜底。
    fn finalize_tree_staging(
        staging: &Path,
        final_dir: &Path,
        root_name: &str,
    ) -> Result<PathBuf, String> {
        let final_path = local_downloads::final_download_path(final_dir, root_name, false);
        if std::fs::rename(staging, &final_path).is_ok() {
            return Ok(final_path);
        }
        copy_dir_recursive(staging, &final_path).map_err(|error| {
            format!(
                "Failed to move the download into '{}': {error}",
                final_path.display()
            )
        })?;
        let _ = std::fs::remove_dir_all(staging);
        Ok(final_path)
    }
}
