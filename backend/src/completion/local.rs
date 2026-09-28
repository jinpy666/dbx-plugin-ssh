//! local target 执行器：短生命周期 tokio 子进程。
//!
//! argv 直 exec 不经 shell（Windows 无需引号处理），绝不触碰
//! [`crate::local_terminal`] 的交互 PTY。stdout/stderr **并发**读取且各自按
//! `max_output_bytes` 上限截断——任一流到顶立即杀进程（停止排空后写端会
//! 永久阻塞在管道上，另一路的 EOF 也只能靠进程退出到来）；completion 层
//! 用 [`tokio::time::timeout`] 竞速超时，超时杀进程并置 `timed_out`。

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;

use crate::completion::protocol::CompletionExecuteResult;

/// 执行一次 local generator 命令。入参必须是经过
/// [`crate::completion::security::validate_and_clamp`] 收紧后的值。
pub async fn execute(
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> Result<CompletionExecuteResult, String> {
    let mut builder = tokio::process::Command::new(command);
    builder
        .args(args)
        // generator 是非交互命令：stdin 接 /dev/null，防止误读宿主输入。
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        builder.current_dir(dir);
    }
    let mut child = builder
        .spawn()
        .map_err(|error| format!("completion: failed to start '{command}': {error}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let run = async {
        let mut out_buf: Vec<u8> = Vec::new();
        let mut err_buf: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut out_open = stdout.is_some();
        let mut err_open = stderr.is_some();
        let mut out_chunk = [0u8; 8192];
        let mut err_chunk = [0u8; 8192];
        while out_open || err_open {
            tokio::select! {
                read = read_step(stdout.as_mut(), &mut out_chunk), if out_open => {
                    match read {
                        Ok(0) => out_open = false,
                        Ok(n) => {
                            if !append_capped(&mut out_buf, &out_chunk[..n], max_output_bytes) {
                                out_open = false;
                                truncated = true;
                                let _ = child.start_kill();
                            }
                        }
                        Err(_) => out_open = false,
                    }
                }
                read = read_step(stderr.as_mut(), &mut err_chunk), if err_open => {
                    match read {
                        Ok(0) => err_open = false,
                        Ok(n) => {
                            if !append_capped(&mut err_buf, &err_chunk[..n], max_output_bytes) {
                                err_open = false;
                                truncated = true;
                                let _ = child.start_kill();
                            }
                        }
                        Err(_) => err_open = false,
                    }
                }
            }
        }
        let status = child.wait().await;
        (out_buf, err_buf, truncated, status)
    };

    match tokio::time::timeout(Duration::from_millis(timeout_ms), run).await {
        Ok((out, err, truncated, Ok(status))) => Ok(CompletionExecuteResult {
            exit_code: status.code(),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            truncated,
            timed_out: false,
        }),
        Ok((_, _, _, Err(error))) => Err(format!("completion: local process failed: {error}")),
        Err(_elapsed) => {
            // 竞速超时（决策 D3）：杀掉并收尸，输出按契约丢弃、exitCode 置空。
            let _ = child.start_kill();
            let _ = child.wait().await;
            Ok(CompletionExecuteResult {
                timed_out: true,
                ..CompletionExecuteResult::default()
            })
        }
    }
}

/// 读一步（None 视作已关闭，直接给 EOF），供 select! 两路复用。
async fn read_step<R>(reader: Option<&mut R>, chunk: &mut [u8]) -> std::io::Result<usize>
where
    R: tokio::io::AsyncRead + Unpin + ?Sized,
{
    match reader {
        Some(reader) => reader.read(chunk).await,
        None => Ok(0),
    }
}

/// 追加至多到 `cap`；返回 false 表示缓冲已到顶（调用方停止读该流并杀进程）。
fn append_capped(buffer: &mut Vec<u8>, data: &[u8], cap: usize) -> bool {
    let room = cap.saturating_sub(buffer.len());
    if data.len() > room {
        buffer.extend_from_slice(&data[..room]);
        return false;
    }
    buffer.extend_from_slice(data);
    buffer.len() < cap
}

#[cfg(test)]
mod tests {
    use super::*;

    // 大输出/超时用例用 unix 的 yes/sleep；Windows 本机没有这些工具，
    // 跳过（细则 §3 平台注意）。CI 与开发机均为 unix。

    #[cfg(unix)]
    #[tokio::test]
    async fn local_printf_succeeds_with_exit_code() {
        let result = execute("printf", &["hello".to_string()], None, 1200, 4096)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.stderr, "");
        assert!(!result.truncated && !result.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_captures_nonzero_exit_and_stderr() {
        let result = execute(
            "sh",
            &["-c".to_string(), "echo boom >&2; exit 3".to_string()],
            None,
            1200,
            4096,
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(3));
        assert_eq!(result.stderr.trim(), "boom");
        assert!(!result.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_runs_in_cwd() {
        // /tmp 在 macOS 是 /private/tmp 的符号链接，pwd 打印解析后路径，
        // 用 tempdir 双侧 canonicalize 比较才跨平台稳定。
        let dir = tempfile::tempdir().unwrap();
        let dir_str = dir.path().to_str().unwrap().to_string();
        let result = execute("pwd", &[], Some(&dir_str), 1200, 4096)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        let expected = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            std::path::Path::new(result.stdout.trim()),
            expected.as_path(),
            "pwd={}",
            result.stdout
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_timeout_kills_and_reports() {
        let started = std::time::Instant::now();
        let result = execute("sleep", &["5".to_string()], None, 400, 4096)
            .await
            .unwrap();
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
        assert_eq!(result.stdout, "");
        // 400ms 超时必须真正生效（留 2s 余量防 CI 抖动）。
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_output_cap_truncates() {
        // yes 无限输出；上限 1 KiB 时必须停止读取并杀进程。
        let started = std::time::Instant::now();
        let result = execute("yes", &["x".to_string()], None, 1200, 1024)
            .await
            .unwrap();
        assert!(result.truncated);
        assert!(!result.timed_out);
        assert!(result.stdout.len() <= 1024);
        assert!(result.stdout.starts_with("x\n"));
        // 截断后进程被回收，不能等到 1.2s 超时才返回。
        assert!(started.elapsed() < Duration::from_millis(1100));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_stderr_cap_truncates_too() {
        // stderr 到顶同样触发截断+回收（两路流对称）。
        let result = execute(
            "sh",
            &["-c".to_string(), "yes err >&2".to_string()],
            None,
            1200,
            512,
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert!(!result.timed_out);
        assert!(result.stderr.len() <= 512);
    }

    #[tokio::test]
    async fn local_missing_binary_errors_with_prefix() {
        let error = execute("dbx-no-such-generator-binary", &[], None, 1200, 4096)
            .await
            .unwrap_err();
        assert!(error.starts_with("completion: "), "{error}");
    }

    #[tokio::test]
    async fn local_missing_cwd_errors_with_prefix() {
        let error = execute(
            #[cfg(unix)]
            "pwd",
            #[cfg(windows)]
            "cmd",
            &[],
            Some("/no/such/dbx-completion-dir"),
            1200,
            4096,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("completion: "), "{error}");
    }

    #[test]
    fn append_capped_stops_at_cap() {
        let mut buffer = Vec::new();
        assert!(append_capped(&mut buffer, b"abc", 8));
        assert_eq!(buffer, b"abc");
        // 追加后恰好到顶：本次已放行，下一次才判停。
        assert!(!append_capped(&mut buffer, b"defgh", 8));
        assert_eq!(buffer.len(), 8);
        // 超量数据只保留有 room 的前缀。
        assert!(!append_capped(&mut buffer, b"zzz", 8));
        assert_eq!(buffer, b"abcdefgh");
    }
}
