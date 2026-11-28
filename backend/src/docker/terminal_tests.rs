//! B5 容器终端单测：输入序号、尺寸钳制、replay 边界、close 幂等、
//! 只读/needsSudo 拒绝、并发上限与墓碑。

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use crate::model::TerminalStream;
use crate::ssh::ReplayBuffer;

use super::logs_stream::StreamSink;
use super::terminal::*;
use super::EngineConfig;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<(String, Value)>>,
    frames: Mutex<Vec<(String, Vec<u8>)>>,
}

impl StreamSink for Recorder {
    fn binary(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        self.frames
            .lock()
            .unwrap()
            .push((channel.to_string(), data.to_vec()));
        Ok(())
    }

    fn event(&self, method: &str, params: Value) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push((method.to_string(), params));
        Ok(())
    }
}

fn entry(id: &str, connection_id: &str) -> Arc<TerminalEntry> {
    let (input, _input_rx) = mpsc::channel(1);
    let (cancel, _cancel_rx) = watch::channel(false);
    Arc::new(TerminalEntry {
        id: id.to_string(),
        connection_id: connection_id.to_string(),
        owner: id.to_string(),
        cancel,
        ended: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        join: Mutex::new(None),
        input,
        replay: Arc::new(Mutex::new(ReplayBuffer::default())),
        last_activity: Arc::new(Mutex::new(Instant::now())),
    })
}

// 1) 输入序号：<8 字节报错、8 字节前缀解析、后续字节原样。
#[test]
fn sequenced_input_requires_eight_byte_prefix() {
    assert!(crate::decode_sequenced_input(&[0u8; 7]).is_err());
    let (sequence, payload) = crate::decode_sequenced_input(&[0u8; 8]).unwrap();
    assert_eq!(sequence, 0);
    assert!(payload.is_empty());

    let mut frame = 0x0102_0304_0506_0708u64.to_be_bytes().to_vec();
    frame.extend_from_slice(b"echo ok\r");
    let (sequence, payload) = crate::decode_sequenced_input(&frame).unwrap();
    assert_eq!(sequence, 0x0102_0304_0506_0708);
    assert_eq!(payload, b"echo ok\r");
    // 序号之后的字节逐字节原样（含 ESC、NUL、UTF-8 多字节）。
    let mut raw = 7u64.to_be_bytes().to_vec();
    raw.extend_from_slice(&[0x1b, 0x00, 0xe4, 0xbd, 0xa0]);
    assert_eq!(crate::decode_sequenced_input(&raw).unwrap().1, raw[8..]);
}

// 2) resize/open 尺寸钳制（2..500 / 2..300）。
#[test]
fn terminal_size_is_clamped() {
    assert_eq!(clamp_terminal_size(None, None), (80, 24));
    assert_eq!(clamp_terminal_size(Some(0), Some(0)), (2, 2));
    assert_eq!(clamp_terminal_size(Some(1), Some(1)), (2, 2));
    assert_eq!(clamp_terminal_size(Some(501), Some(301)), (500, 300));
    assert_eq!(clamp_terminal_size(Some(120), Some(40)), (120, 40));
    assert_eq!(
        clamp_terminal_size(Some(u64::MAX), Some(u64::MAX)),
        (500, 300)
    );
}

// 3) replay：环形覆盖后 complete:false；afterSequence 边界。
#[test]
fn replay_reports_incomplete_after_ring_eviction() {
    let mut buffer = ReplayBuffer::with_byte_limit(4);
    buffer.push(TerminalStream::Stdout, vec![1; 3]);
    buffer.push(TerminalStream::Stdout, vec![2; 3]);
    assert_eq!(buffer.first_sequence(), 2);
    assert_eq!(buffer.tail_sequence(), 2);
    assert!(!replay_complete(0, buffer.first_sequence()));
    assert!(replay_complete(1, buffer.first_sequence()));
    assert_eq!(buffer.after(0).len(), 1);
    assert_eq!(buffer.after(1).len(), 1);
    assert!(buffer.after(2).is_empty());

    assert!(replay_complete(0, 1));
    assert!(!replay_complete(0, 2));
    assert!(replay_complete(5, 6));
    assert!(!replay_complete(5, 7));
    assert!(replay_complete(u64::MAX, 1));
}

// 4) close 幂等；未知 id 返回 success 且不发 end。
#[tokio::test]
async fn close_is_idempotent_and_unknown_id_succeeds() {
    let registry = TerminalRegistry::new(MAX_ACTIVE_TERMINALS);
    let sink = Recorder::default();

    let unknown = registry.close("missing", &sink).await.unwrap();
    assert_eq!(unknown, json!({ "success": true }));
    assert!(sink.events.lock().unwrap().is_empty());

    registry.register(entry("term-1", "conn-1")).unwrap();
    registry.close("term-1", &sink).await.unwrap();
    {
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "docker/terminal/end");
        assert_eq!(events[0].1["terminalId"], "term-1");
        assert_eq!(events[0].1["reason"], "closed");
    }

    registry.close("term-1", &sink).await.unwrap();
    assert_eq!(sink.events.lock().unwrap().len(), 1);
}

// 5) 只读连接拒绝；needsSudo 拒绝且不注入密码；预热后只允许 sudo -n。
#[test]
fn authorization_paths_never_accept_a_password() {
    let read_only = terminal_access(true, false, false).unwrap_err();
    assert!(
        read_only.contains("read-only connection setting"),
        "{read_only}"
    );

    let needs_sudo = terminal_access(false, true, false).unwrap_err();
    assert!(
        needs_sudo.contains("does not inject sudo passwords"),
        "{needs_sudo}"
    );
    assert!(!needs_sudo.contains("sudo -S"), "{needs_sudo}");

    assert_eq!(
        terminal_access(false, false, false).unwrap(),
        SudoPlan::Plain
    );
    assert_eq!(
        terminal_access(false, true, true).unwrap(),
        SudoPlan::NonInteractive
    );

    let engine = EngineConfig::default();
    let plain = terminal_ssh_command(&engine, "d4a7c9f1e2b3", TerminalShell::Bash, false);
    assert!(plain.contains("sh -c"), "{plain}");
    assert!(
        plain.contains("exec \"$1\" exec -it \"$2\" \"$3\""),
        "{plain}"
    );
    assert!(!plain.contains("sudo -n"), "{plain}");
    let elevated = terminal_ssh_command(&engine, "d4a7c9f1e2b3", TerminalShell::Auto, true);
    assert!(
        elevated.contains("exec sudo -n \"$1\" exec -it \"$2\""),
        "{elevated}"
    );
    assert!(elevated.contains("bash zsh fish ash sh"), "{elevated}");
    // 审计文本只含方法/容器/壳名，不含任何键入字节。
    assert_eq!(
        terminal_audit_command(&engine, "d4a7c9f1e2b3", TerminalShell::Sh),
        "docker exec -it d4a7c9f1e2b3 sh"
    );
}

// 6) 上限 8：第 9 个返回可读错误。
#[tokio::test]
async fn ninth_terminal_is_rejected_with_readable_error() {
    let registry = TerminalRegistry::new(MAX_ACTIVE_TERMINALS);
    for index in 0..MAX_ACTIVE_TERMINALS {
        registry
            .register(entry(&format!("term-{index}"), "conn-1"))
            .unwrap();
    }
    assert_eq!(registry.active_count(), MAX_ACTIVE_TERMINALS);
    assert_eq!(registry.connection_terminal_count("conn-1"), 8);
    let error = registry.register(entry("term-9", "conn-1")).unwrap_err();
    assert!(
        error.contains("Too many active container terminals (8)"),
        "{error}"
    );
}

// 7) 关闭墓碑：close 之后同 id 的迟到 open 被拒（附录 C.3）。
#[tokio::test]
async fn closed_id_is_tombstoned() {
    let registry = TerminalRegistry::new(MAX_ACTIVE_TERMINALS);
    let sink = Recorder::default();
    registry.register(entry("term-x", "conn-1")).unwrap();
    registry.close("term-x", &sink).await.unwrap();
    let error = registry.register(entry("term-x", "conn-1")).unwrap_err();
    assert!(error.contains("was closed"), "{error}");
}

#[test]
fn terminal_id_charset_and_shell_whitelist() {
    assert!(valid_terminal_id("docker-term-abc_1.2"));
    assert!(!valid_terminal_id(""));
    assert!(!valid_terminal_id("a/b"));
    assert!(!valid_terminal_id("a b"));
    assert_eq!(TerminalShell::parse(None).unwrap(), TerminalShell::Auto);
    assert!(TerminalShell::parse(Some("ZSH"))
        .unwrap_err()
        .contains("Unsupported"));
    assert_eq!(
        TerminalShell::parse(Some("fish")).unwrap(),
        TerminalShell::Fish
    );
}
