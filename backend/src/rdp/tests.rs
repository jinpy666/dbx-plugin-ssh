//! RDP 子模块测试：原 rdp_session.rs tests 整体迁入，经 mod.rs 的
//! pub(crate) use 再导出保持原有可见性与断言不变。
#![cfg(test)]
use super::*;
use dbx_plugin_sdk::PluginEmitter;
use ironrdp::input::{
    Database as IronRdpInputDatabase, MouseButton as IronRdpMouseButton,
    Operation as IronRdpInputOperation,
};
use ironrdp::pdu::input::fast_path::{
    FastPathInputEvent as IronRdpFastPathInputEvent, KeyboardFlags as IronRdpKeyboardFlags,
};
use smallvec::SmallVec;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

// —— 配置归一化 ————————————————————————————————————————————

#[test]
fn security_defaults_are_review_locked() {
    // 缺省（无参数、无偏好）= use_nla true + prompt（清单 §3-C 基线）。
    let resolved = resolve_security(None, None, &serde_json::json!({})).expect("defaults");
    assert!(resolved.use_nla);
    assert_eq!(resolved.certificate_policy, CertPolicy::Prompt);
}

#[test]
fn security_preferences_fill_absent_params() {
    let prefs = serde_json::json!({ "rdp_use_nla": false, "rdp_certificate_policy": "strict" });
    let resolved = resolve_security(None, None, &prefs).expect("from prefs");
    assert!(!resolved.use_nla);
    assert_eq!(resolved.certificate_policy, CertPolicy::Strict);
    // 显式参数压过偏好。
    let resolved =
        resolve_security(Some(true), Some("accept-temporarily"), &prefs).expect("explicit");
    assert!(resolved.use_nla);
    assert_eq!(resolved.certificate_policy, CertPolicy::AcceptTemporarily);
}

#[test]
fn security_rejects_unknown_policy_names() {
    let error = resolve_security(None, Some("trust-everything"), &serde_json::json!({}))
        .expect_err("unknown policy must fail closed");
    assert!(
        error.contains("prompt, strict or accept-temporarily"),
        "{error}"
    );
}

#[test]
fn desktop_size_bounds_match_the_contract() {
    assert!(validate_desktop_size(640, 480).is_ok());
    assert!(validate_desktop_size(3840, 2160).is_ok());
    assert!(validate_desktop_size(1280, 800).is_ok());
    // NyaTerm 下界（640 以下拒绝）。
    assert!(validate_desktop_size(639, 480).is_err());
    assert!(validate_desktop_size(640, 479).is_err());
    // 插件上界（3840x2160，保证补丁负载 < 64 MiB）。
    assert!(validate_desktop_size(3841, 2160).is_err());
    assert!(validate_desktop_size(3840, 2161).is_err());
}

// —— 错误分类与重连门控 ——————————————————————————————————

#[test]
fn connector_classifier_gates_reconnect_by_failure_kind() {
    // 认证类失败绝不重试（凭据错误不会因重试变对）。
    for text in [
        "credssp finalization failed",
        "authentication failed",
        "password expired",
        "logon failure",
        "access denied",
    ] {
        let (kind, retryable) = classify_connector_error_text(text);
        assert_eq!(kind, RdpErrorKind::Authentication, "{text}");
        assert!(!retryable, "{text}");
    }
    // 证书拒绝 fail-closed：不重试。
    for text in [
        "tlsupgrade failed: certificate rejected",
        "unknown certificate",
        "certificate fingerprint changed",
    ] {
        let (kind, retryable) = classify_connector_error_text(text);
        assert_eq!(kind, RdpErrorKind::Certificate, "{text}");
        assert!(!retryable, "{text}");
    }
    // TLS 升级被对端重置（NyaTerm 测试向量）：TLS 类，可重试。
    let text =
        r#"error { context: "tlsupgrade", source: os { code: 10054, kind: connectionreset } }"#;
    assert_eq!(
        classify_connector_error_text(text),
        (RdpErrorKind::Tls, true)
    );
    // 协商失败不重试。
    let (kind, retryable) = classify_connector_error_text("x224 negotiation failed");
    assert_eq!(kind, RdpErrorKind::Negotiation);
    assert!(!retryable);
    // 其余传输错误可重试。
    assert_eq!(
        classify_connector_error_text("os error 111 connection refused"),
        (RdpErrorKind::Transport, true)
    );
}

#[test]
fn session_classifier_routes_tls_transport_and_clipboard() {
    assert_eq!(
        classify_session_error_text("native-tls Schannel handshake failure"),
        (RdpErrorKind::Tls, true)
    );
    // TLS 升级被对端重置按 TLS 分类（NyaTerm 同款语义，连接重试）。
    assert_eq!(
        classify_session_error_text("connection reset by peer"),
        (RdpErrorKind::Tls, true)
    );
    // 纯传输中断（broken pipe/eof）按传输分类，可重试。
    assert_eq!(
        classify_session_error_text("broken pipe"),
        (RdpErrorKind::Transport, true)
    );
    assert_eq!(
        classify_session_error_text("unexpected eof from transport"),
        (RdpErrorKind::Transport, true)
    );
    let (kind, retryable) = classify_session_error_text("cliprdr channel broken");
    assert_eq!(kind, RdpErrorKind::Clipboard);
    assert!(!retryable);
    // 认证字样照旧不重试。
    assert_eq!(
        classify_session_error_text("authentication token expired"),
        (RdpErrorKind::Authentication, false)
    );
}

#[test]
fn auth_failures_surface_as_one_opaque_message() {
    // 清单 §3-A：失败语义统一，不区分用户名/密码，不回显凭据。
    let (kind, _) = classify_connector_error_text("credssp: wrong password for admin");
    assert_eq!(
        connector_error_message(kind, "credssp: wrong password for admin"),
        "RDP authentication failed"
    );
    let (kind, _) = classify_session_error_text("password rejected");
    assert_eq!(
        session_error_message(kind, "password rejected"),
        "RDP authentication failed"
    );
    // 传输类错误保留细节（不含凭据）。
    let message =
        connector_error_message(RdpErrorKind::Transport, "os error 111: connection refused");
    assert!(message.contains("connection refused"), "{message}");
}

#[test]
fn reconnect_delay_follows_nyaterm_ladder() {
    assert_eq!(reconnect_delay(1), Duration::from_secs(1));
    assert_eq!(reconnect_delay(2), Duration::from_secs(2));
    assert_eq!(reconnect_delay(3), Duration::from_secs(4));
    assert_eq!(reconnect_delay(4), Duration::from_secs(8));
    assert_eq!(reconnect_delay(5), Duration::from_secs(15));
    assert_eq!(reconnect_delay(6), Duration::from_secs(30));
    assert_eq!(reconnect_delay(100), Duration::from_secs(30));
}

// —— 证书策略状态机 ——————————————————————————————————————

#[test]
fn certificate_policy_matches_nyaterm_semantics() {
    use KnownCertStatus::{Changed, Match, Unknown};
    // strict：仅已记住的匹配指纹放行，未知/变更一律拒绝。
    assert_eq!(
        certificate_allows_without_prompt(CertPolicy::Strict, Match),
        Ok(true)
    );
    assert!(certificate_allows_without_prompt(CertPolicy::Strict, Unknown).is_err());
    assert!(certificate_allows_without_prompt(CertPolicy::Strict, Changed).is_err());
    // prompt：匹配静默放行，其余弹确认（false = 需要 prompt）。
    assert_eq!(
        certificate_allows_without_prompt(CertPolicy::Prompt, Match),
        Ok(true)
    );
    assert_eq!(
        certificate_allows_without_prompt(CertPolicy::Prompt, Unknown),
        Ok(false)
    );
    assert_eq!(
        certificate_allows_without_prompt(CertPolicy::Prompt, Changed),
        Ok(false)
    );
    // accept-temporarily：显式选择，无需 prompt。
    assert_eq!(
        certificate_allows_without_prompt(CertPolicy::AcceptTemporarily, Changed),
        Ok(true)
    );
    // 无「静默接受任意证书」路径：默认策略对未知证书必须要求 prompt。
    assert_eq!(
        resolve_security(None, None, &serde_json::json!({}))
            .expect("default")
            .certificate_policy,
        CertPolicy::Prompt
    );
}

#[test]
fn cert_policy_parses_wire_names_only() {
    assert_eq!(CertPolicy::parse("prompt"), Some(CertPolicy::Prompt));
    assert_eq!(CertPolicy::parse("strict"), Some(CertPolicy::Strict));
    assert_eq!(
        CertPolicy::parse("accept-temporarily"),
        Some(CertPolicy::AcceptTemporarily)
    );
    assert_eq!(CertPolicy::parse("always-accept"), None);
    assert_eq!(CertPolicy::Prompt.as_str(), "prompt");
}

#[test]
fn known_cert_status_matches_changed_and_unknown() {
    let mut store = HashMap::new();
    store.insert("rdp.local:3389".to_string(), "SHA256:aa".to_string());
    assert_eq!(
        known_cert_status(&store, "rdp.local", 3389, "SHA256:aa"),
        KnownCertStatus::Match
    );
    assert_eq!(
        known_cert_status(&store, "rdp.local", 3389, "SHA256:bb"),
        KnownCertStatus::Changed
    );
    assert_eq!(
        known_cert_status(&store, "other.local", 3389, "SHA256:aa"),
        KnownCertStatus::Unknown
    );
}

#[test]
fn known_cert_store_persists_and_roundtrips() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let store = KnownCertStore::new(data_dir.path());
    assert_eq!(
        store.check("h", 3389, "SHA256:aa"),
        KnownCertStatus::Unknown
    );
    store.remember("h", 3389, "SHA256:aa").expect("remember");
    assert_eq!(store.check("h", 3389, "SHA256:aa"), KnownCertStatus::Match);
    assert_eq!(
        store.check("h", 3389, "SHA256:bb"),
        KnownCertStatus::Changed
    );
    // 损坏文件按空存储处理（不毒化启动）。
    std::fs::write(&store.path, "{not json").expect("write junk");
    assert_eq!(
        store.check("h", 3389, "SHA256:aa"),
        KnownCertStatus::Unknown
    );
}

#[test]
fn fingerprint_is_nyaterm_wire_form() {
    // SHA256:<lowercase hex>，64 位 hex 摘要。
    let fingerprint = certificate_fingerprint(b"der-bytes");
    assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
    assert_eq!(fingerprint.len(), "SHA256:".len() + 64);
    // 确定性：同输入同指纹。
    assert_eq!(certificate_fingerprint(b"der-bytes"), fingerprint);
    assert_ne!(certificate_fingerprint(b"other-der"), fingerprint);
}

#[tokio::test]
async fn cert_broker_request_emits_and_resolves() {
    let broker = Arc::new(CertPromptBroker::new());
    // 先注册一个 prompt（后台任务持有请求端），再从 resolve 端应答。
    let request_task = tokio::spawn({
        let broker = broker.clone();
        async move {
            broker
                .request(
                    &test_emitter(),
                    "s1",
                    "h",
                    3389,
                    "SHA256:aa",
                    KnownCertStatus::Unknown,
                )
                .await
        }
    });
    // 等 prompt 注册完成。
    for _ in 0..50 {
        if !broker.pending.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // 找到刚注册的 challengeId（只有一个）。
    let challenge_id = {
        let pending = broker.pending.lock().unwrap();
        assert_eq!(pending.len(), 1);
        pending.keys().next().cloned().expect("one pending")
    };
    assert!(broker.pending.lock().unwrap().contains_key(&challenge_id));
    broker.resolve(&challenge_id, true, false).expect("resolve");
    let decision = request_task.await.expect("task").expect("decision");
    assert!(decision.accept);
    assert!(!decision.remember);
    assert!(!broker.pending.lock().unwrap().contains_key(&challenge_id));
    // 已解析后再 resolve 报错（一次性语义）。
    assert!(broker.resolve(&challenge_id, true, true).is_err());
}

#[tokio::test]
async fn cert_broker_cancel_rejects_pending_prompts() {
    let broker = Arc::new(CertPromptBroker::new());
    let request_task = tokio::spawn({
        let broker = broker.clone();
        async move {
            broker
                .request(
                    &test_emitter(),
                    "s1",
                    "h",
                    3389,
                    "SHA256:aa",
                    KnownCertStatus::Unknown,
                )
                .await
        }
    });
    // 等 prompt 注册完成。
    for _ in 0..50 {
        if !broker.pending.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    broker.cancel_session("s1");
    // 取消 = 以 accept=false 应答（fail-closed），verify 端据此拒绝。
    let decision = request_task.await.expect("task").expect("decision");
    assert!(!decision.accept);
    assert!(!decision.remember);
    assert!(broker.pending.lock().unwrap().is_empty());
}

fn test_emitter() -> PluginEmitter {
    let output: Arc<StdMutex<Box<dyn std::io::Write + Send>>> =
        Arc::new(StdMutex::new(Box::new(Vec::<u8>::new())));
    PluginEmitter::for_tests(output, dbx_plugin_sdk::PluginTransport::JsonLines)
}

// —— 剪贴板上限 ————————————————————————————————————————————

#[test]
fn clipboard_limit_rejects_oversized_text_whole() {
    assert!(validate_clipboard_text("").is_ok());
    assert!(validate_clipboard_text("hello").is_ok());
    assert!(validate_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT_BYTES)).is_ok());
    let error = validate_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1))
        .expect_err("must reject oversized");
    assert!(error.contains("16 MiB"), "{error}");
}

#[test]
fn clipboard_stage_holds_latest_text_only() {
    let stage = ClipboardStage::default();
    assert!(stage.text().is_none());
    stage.set_text("first".to_string());
    stage.set_text("second".to_string());
    assert_eq!(stage.text().as_deref(), Some("second"));
    stage.clear();
    assert!(stage.text().is_none());
}

// —— 帧封装（共享 44 字节 patch 头）————————————————————

#[test]
fn image_patch_matches_shared_frame_header() {
    // 与 vnc_session 的 44 字节头逐字段一致（RDP 引擎的 u32 0x00RRGGBB
    // 像素展开成 RGBA8888，alpha 恒 0xff）。
    let pixels = [0x0011_2233, 0x0044_5566, 0x0077_8899, 0x00aa_bbcc];
    let frame = image_patch_to_frame(&pixels, 1920, 1080, 10, 20, 2, 2, 9)
        .expect("valid patch should encode");
    assert_eq!(frame.len(), crate::vnc_session::FRAME_HEADER_BYTES + 16);
    assert_eq!(&frame[0..8], &9_u64.to_le_bytes());
    assert_eq!(&frame[8..12], &1920_u32.to_le_bytes());
    assert_eq!(&frame[12..16], &1080_u32.to_le_bytes());
    assert_eq!(&frame[16..20], &10_u32.to_le_bytes());
    assert_eq!(&frame[20..24], &20_u32.to_le_bytes());
    assert_eq!(&frame[24..28], &2_u32.to_le_bytes());
    assert_eq!(&frame[28..32], &2_u32.to_le_bytes());
    assert_eq!(&frame[32..36], &8_u32.to_le_bytes());
    assert_eq!(
        &frame[36..40],
        &crate::vnc_session::PIXEL_FORMAT_RGBA8888.to_le_bytes()
    );
    assert_eq!(&frame[40..44], &16_u32.to_le_bytes());
    assert_eq!(
        &frame[44..],
        &[
            0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff, 0x77, 0x88, 0x99, 0xff, 0xaa, 0xbb,
            0xcc, 0xff
        ]
    );
}

#[test]
fn image_patch_rejects_short_buffers_and_geometry_overflow() {
    // 引擎缓冲小于补丁：丢弃该帧而不是越界读。
    assert!(image_patch_to_frame(&[0], 10, 10, 0, 0, 2, 2, 1).is_err());
    // 补丁几何由 vnc 的 encode_frame_patch 复核（出界/零尺寸拒绝）。
    assert!(image_patch_to_frame(&[0; 4], 10, 10, 9, 0, 2, 2, 1).is_err());
    assert!(image_patch_to_frame(&[0; 16], 10, 10, 0, 0, 0, 2, 1).is_err());
}

#[test]
fn replay_framebuffer_composites_incremental_patches_into_one_full_desktop() {
    let mut framebuffer = RdpReplayFramebuffer::new(4, 2).expect("framebuffer");
    framebuffer
        .apply_patch(&[0; 8], 4, 2, 0, 0, 4, 2)
        .expect("full baseline");
    framebuffer
        .apply_patch(&[0x00ff_0000, 0x0000_ff00], 4, 2, 0, 0, 2, 1)
        .expect("first incremental patch");
    framebuffer
        .apply_patch(&[0x0000_00ff, 0x00ff_ffff], 4, 2, 2, 1, 2, 1)
        .expect("second incremental patch");

    let frame = framebuffer.full_frame(42).expect("full replay frame");
    assert_eq!(&frame[0..8], &42_u64.to_le_bytes());
    assert_eq!(
        &frame[16..32],
        &[0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0]
    );
    assert_eq!(&frame[44..52], &[0xff, 0, 0, 0xff, 0, 0xff, 0, 0xff]);
    assert_eq!(
        &frame[44 + 24..44 + 32],
        &[0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    );
}

#[test]
fn replay_framebuffer_requires_a_fullscreen_baseline_before_marking_complete() {
    let mut framebuffer = RdpReplayFramebuffer::new(4, 2).expect("framebuffer");
    framebuffer
        .apply_patch(&[0x00ff_0000], 4, 2, 1, 1, 1, 1)
        .expect("local patch");
    assert!(
        framebuffer.full_frame(1).is_err(),
        "a first local patch does not establish a replayable desktop"
    );

    framebuffer
        .apply_patch(&[0x0000_0000; 8], 4, 2, 0, 0, 4, 2)
        .expect("full baseline");
    assert!(framebuffer.full_frame(2).is_ok());

    framebuffer
        .apply_patch(&[0x0000_00ff], 5, 2, 0, 0, 1, 1)
        .expect_err("dimension change must clear the complete baseline");
    assert!(framebuffer.full_frame(3).is_err());
}

#[test]
fn replay_framebuffer_serializes_patch_and_replay_sequences() {
    let mut state = RdpFrameState::default();
    let realtime = state
        .apply_and_encode(&[0x00ff_0000, 0x0000_ff00], 2, 1, 0, 0, 2, 1)
        .expect("full realtime patch");
    let replay = state.replay().expect("complete replay");
    let next = state
        .apply_and_encode(&[0x0000_00ff], 2, 1, 1, 0, 1, 1)
        .expect("incremental realtime patch");

    assert_eq!(frame_sequence(&realtime), 0);
    assert_eq!(frame_sequence(&replay), 1);
    assert_eq!(frame_sequence(&next), 2);
}

#[test]
fn replay_framebuffer_accepts_4k_within_the_explicit_byte_budget() {
    let framebuffer = RdpReplayFramebuffer::new(MAX_DESKTOP_WIDTH, MAX_DESKTOP_HEIGHT)
        .expect("4K framebuffer stays within the replay budget");
    assert_eq!(framebuffer.byte_len(), RDP_REPLAY_FRAMEBUFFER_MAX_BYTES);
    assert!(framebuffer.byte_len() <= RDP_REPLAY_FRAMEBUFFER_MAX_BYTES);
}

#[test]
fn replay_framebuffer_rejects_invalid_patches_and_can_be_cleared() {
    let mut framebuffer = RdpReplayFramebuffer::new(2, 2).expect("framebuffer");
    assert!(framebuffer.apply_patch(&[0], 2, 2, 1, 1, 2, 1).is_err());
    framebuffer.clear();
    assert_eq!(framebuffer.byte_len(), 0);
    assert!(framebuffer.full_frame(1).is_err());
}

// —— 输入映射（NyaTerm 对齐）———————————————————————————

#[test]
fn input_events_decode_from_the_documented_shapes() {
    let key: RdpWireInput = serde_json::from_value(serde_json::json!({
        "kind": "key-down", "scanCode": 29, "extended": false
    }))
    .expect("key-down");
    assert!(matches!(
        key,
        RdpWireInput::KeyDown {
            scan_code: 29,
            extended: false
        }
    ));
    // NyaTerm 兼容 camelCase delta 别名。
    let wheel: RdpWireInput = serde_json::from_value(serde_json::json!({
        "kind": "mouse-wheel", "deltaX": 1.0, "deltaY": -2.0, "x": 10, "y": 20
    }))
    .expect("wheel");
    assert!(
        matches!(wheel, RdpWireInput::MouseWheel { delta_x, .. } if (delta_x - 1.0).abs() < f64::EPSILON)
    );
    // 未知 kind 拒绝。
    assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({ "kind": "drag" })).is_err());
    // 完整请求（camelCase sessionId + flatten input）。
    let request: RdpInputRequest = serde_json::from_value(serde_json::json!({
        "sessionId": "s1", "kind": "mouse-move", "x": 1, "y": 2
    }))
    .expect("request");
    assert_eq!(request.session_id, "s1");
}

#[test]
fn right_shift_uses_direct_fast_path() {
    let action = wire_input_to_action(RdpWireInput::KeyDown {
        scan_code: RDP_RIGHT_SHIFT_SCAN_CODE,
        extended: false,
    })
    .expect("mapped");
    assert!(matches!(
        action,
        InputAction::FastPath(IronRdpFastPathInputEvent::KeyboardEvent(flags, code))
            if flags == IronRdpKeyboardFlags::empty() && code == RDP_RIGHT_SHIFT_SCAN_CODE
    ));
    let action = wire_input_to_action(RdpWireInput::KeyUp {
        scan_code: RDP_RIGHT_SHIFT_SCAN_CODE,
        extended: false,
    })
    .expect("mapped");
    assert!(matches!(
        action,
        InputAction::FastPath(IronRdpFastPathInputEvent::KeyboardEvent(flags, code))
            if flags == IronRdpKeyboardFlags::RELEASE && code == RDP_RIGHT_SHIFT_SCAN_CODE
    ));
    // 扩展位上的 0x36 不是右 Shift（照走数据库路径）。
    let action = wire_input_to_action(RdpWireInput::KeyDown {
        scan_code: RDP_RIGHT_SHIFT_SCAN_CODE,
        extended: true,
    })
    .expect("mapped");
    assert!(matches!(action, InputAction::Operations(_)));
}

#[test]
fn wheel_deltas_are_inverted_into_rotation_units() {
    let action = wire_input_to_action(RdpWireInput::MouseWheel {
        delta_x: 3.0,
        delta_y: 120.0,
        x: 10,
        y: 20,
    })
    .expect("mapped");
    let InputAction::Operations(operations) = action else {
        panic!("expected operations");
    };
    assert!(matches!(
        operations.first(),
        Some(IronRdpInputOperation::MouseMove(_))
    ));
    let horizontal = operations.iter().find_map(|operation| match operation {
        IronRdpInputOperation::WheelRotations(rotations) if !rotations.is_vertical => {
            Some(rotations.rotation_units)
        }
        _ => None,
    });
    let vertical = operations.iter().find_map(|operation| match operation {
        IronRdpInputOperation::WheelRotations(rotations) if rotations.is_vertical => {
            Some(rotations.rotation_units)
        }
        _ => None,
    });
    assert_eq!(horizontal, Some(-3));
    assert_eq!(vertical, Some(-120));
}

#[test]
fn unicode_input_presses_and_releases_each_char() {
    let action = wire_input_to_action(RdpWireInput::Unicode {
        text: "ab".to_string(),
    })
    .expect("mapped");
    let InputAction::Operations(operations) = action else {
        panic!("expected operations");
    };
    assert_eq!(operations.len(), 4);
    assert!(matches!(
        operations[0],
        IronRdpInputOperation::UnicodeKeyPressed('a')
    ));
    assert!(matches!(
        operations[1],
        IronRdpInputOperation::UnicodeKeyReleased('a')
    ));
}

#[test]
fn mouse_buttons_map_wire_names_and_unknown_buttons_are_dropped() {
    let action = wire_input_to_action(RdpWireInput::MouseButton {
        button: "right".to_string(),
        pressed: true,
        x: 1,
        y: 2,
    })
    .expect("mapped");
    let InputAction::Operations(operations) = action else {
        panic!("expected operations");
    };
    assert!(matches!(
        operations[1],
        IronRdpInputOperation::MouseButtonPressed(IronRdpMouseButton::Right)
    ));
    let action = wire_input_to_action(RdpWireInput::MouseButton {
        button: "side".to_string(),
        pressed: true,
        x: 1,
        y: 2,
    })
    .expect("mapped");
    let InputAction::Operations(operations) = action else {
        panic!("expected operations");
    };
    assert!(operations.is_empty());
}

#[test]
fn release_all_maps_to_database_release() {
    // ReleaseAll → None → send_wire_input 走 database.release_all()。
    assert!(wire_input_to_action(RdpWireInput::ReleaseAll).is_none());
}

#[test]
fn input_database_roundtrip_keeps_key_state_consistent() {
    // key-down + key-up 经数据库路径各产出 fast-path 键盘事件。
    let mut database = IronRdpInputDatabase::new();
    let down = apply_wire_input(
        &mut database,
        RdpWireInput::KeyDown {
            scan_code: 0x2a,
            extended: false,
        },
    );
    assert_eq!(down.len(), 1);
    let up = apply_wire_input(
        &mut database,
        RdpWireInput::KeyUp {
            scan_code: 0x2a,
            extended: false,
        },
    );
    assert_eq!(up.len(), 1);
    // ReleaseAll 之后的下一次输入照常（状态已清空）。
    let released = apply_wire_input(&mut database, RdpWireInput::ReleaseAll);
    assert!(released.is_empty());
}

fn apply_wire_input(
    database: &mut IronRdpInputDatabase,
    input: RdpWireInput,
) -> SmallVec<[IronRdpFastPathInputEvent; 2]> {
    match wire_input_to_action(input) {
        Some(InputAction::Operations(operations)) => database.apply(operations),
        Some(InputAction::FastPath(event)) => smallvec::smallvec![event],
        None => database.release_all(),
    }
}

// —— 资源上界常量（契约钉在断言上）——————————————————————

#[test]
fn bounds_are_pinned() {
    assert_eq!(MAX_CLIPBOARD_TEXT_BYTES, 16 * 1024 * 1024);
    assert_eq!(CLIPBOARD_CHUNK_JSON_BUDGET, 7 * 1024 * 1024);
    assert_eq!(MAX_UNICODE_TEXT_CHARS, 4096);
    assert_eq!(MAX_HOST_LEN, 255);
    assert_eq!(MAX_USERNAME_LEN, 128);
    assert_eq!(MAX_DOMAIN_LEN, 128);
    assert_eq!(KNOWN_CERTS_MAX_ENTRIES, 1024);
    assert_eq!(MAX_TOTAL_RECONNECTS, 50);
    assert_eq!(DEFAULT_RECONNECT_ATTEMPTS, 5);
    assert_eq!(MAX_RECONNECT_ATTEMPTS, 10);
    assert_eq!(CERTIFICATE_PROMPT_TIMEOUT, Duration::from_secs(120));
    assert_eq!(COMMAND_CHANNEL_CAPACITY, 256);
    assert_eq!(MAX_DESKTOP_WIDTH, 3840);
    assert_eq!(MAX_DESKTOP_HEIGHT, 2160);
}

// —— C1：入站剪贴板入口长度门（vendored 层缓解）————————————————

#[test]
fn clipboard_payload_gate_rejects_before_decode() {
    // 入口门：原始载荷超限在 UTF-16 → String 物化之前拒绝。
    assert!(validate_clipboard_payload_len(0).is_ok());
    assert!(validate_clipboard_payload_len(MAX_CLIPBOARD_TEXT_BYTES).is_ok());
    let error = validate_clipboard_payload_len(MAX_CLIPBOARD_TEXT_BYTES + 1)
        .expect_err("must reject oversized raw payload");
    assert!(error.contains("16 MiB"), "{error}");
}

// —— C2：剪贴板事件分片 ————————————————————————————————————————

#[test]
fn clipboard_chunks_keeps_fitting_text_whole() {
    let text = "hello".to_string();
    assert_eq!(clipboard_chunks(&text), vec!["hello"]);
    // 恰好压线：7 MiB 纯 ASCII 单事件。
    let text = "x".repeat(CLIPBOARD_CHUNK_JSON_BUDGET);
    assert_eq!(clipboard_chunks(&text).len(), 1);
}

#[test]
fn clipboard_chunks_splits_oversized_text_and_reassembles() {
    // 10 MiB 纯 ASCII：JSON 事件必然超 SDK 8 MiB，必须分片。
    let text = "x".repeat(10 * 1024 * 1024);
    let chunks = clipboard_chunks(&text);
    assert!(chunks.len() > 1, "expected multiple chunks");
    for chunk in &chunks {
        assert!(
            json_escaped_len(chunk) <= CLIPBOARD_CHUNK_JSON_BUDGET,
            "chunk exceeds the event budget"
        );
    }
    let reassembled: String = chunks.concat();
    assert_eq!(reassembled, text);
}

#[test]
fn clipboard_chunks_accounts_for_json_escape_inflation() {
    // 2 MiB 制表符：原始字节 < 7 MiB，但 JSON 转义后 12 MiB > 8 MiB ——
    // 同样必须分片（否则仍被 SDK 静默丢弃）。
    let text = "\t".repeat(2 * 1024 * 1024);
    let chunks = clipboard_chunks(&text);
    assert!(chunks.len() > 1, "control chars inflate 6x and must split");
    for chunk in &chunks {
        assert!(
            json_escaped_len(chunk) <= CLIPBOARD_CHUNK_JSON_BUDGET,
            "chunk exceeds the event budget"
        );
    }
    assert_eq!(chunks.concat(), text);
}

#[test]
fn clipboard_chunks_never_splits_a_multibyte_char() {
    // 多字节字符只能整体进某一分片（char boundary 切分）。
    let text = "é".repeat(4 * 1024 * 1024); // 2 bytes each → 8 MiB
    let chunks = clipboard_chunks(&text);
    assert!(chunks.len() > 1);
    for chunk in &chunks {
        assert!(chunk.chars().all(|c| c == 'é'));
    }
    assert_eq!(chunks.concat(), text);
}

// —— D3：重连累计总预算状态机 ————————————————————————————————————

#[test]
fn reconnect_budget_resets_ladder_but_never_total_on_active() {
    let mut budget = ReconnectBudget::new();
    // 非活动失败：梯子 5 步耗尽（NyaTerm 默认）。
    for _ in 0..5 {
        assert!(budget.allows(5, true));
        budget.charge();
    }
    assert!(!budget.allows(5, true), "ladder must exhaust at 5");
    // 活动成功重置梯子步长——但总预算不重置（D3：恶意服务器不能靠
    // active-后-传输错误循环把客户端变成无限重拨机）。
    budget.on_active_generation();
    assert!(budget.allows(5, true), "ladder step reset on active");
    // 继续循环：total 只增不减，第 50 次重连后总预算耗尽。
    for _ in 0..(MAX_TOTAL_RECONNECTS - 5 - 1) {
        budget.charge();
        budget.on_active_generation();
        assert!(budget.allows(5, true));
    }
    budget.charge();
    budget.on_active_generation();
    assert!(
        !budget.allows(5, true),
        "cumulative budget must close the gate at {MAX_TOTAL_RECONNECTS}"
    );
}

#[test]
fn reconnect_budget_gate_closes_on_non_retryable_failures() {
    let mut budget = ReconnectBudget::new();
    assert!(!budget.allows(5, false), "non-retryable never reconnects");
    budget.charge();
    assert!(!budget.allows(5, false));
}

// —— E5：输入面上界 ————————————————————————————————————————————

#[test]
fn scan_code_above_u8_is_rejected_not_truncated() {
    // 0x136 是报告点名的截断码点（截断后恰为 0x36 右 Shift）：必须整体
    // 拒绝而不是静默截断。
    assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({
        "kind": "key-down", "scanCode": 0x136
    }))
    .is_err());
    assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({
        "kind": "key-up", "scanCode": 256
    }))
    .is_err());
    // u8 范围内的合法值照常。
    assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({
        "kind": "key-down", "scanCode": 255
    }))
    .is_ok());
}

#[tokio::test]
async fn unicode_input_over_the_char_limit_is_rejected() {
    let runtime = RdpSessionRuntime::new();
    let oversized = "a".repeat(MAX_UNICODE_TEXT_CHARS + 1);
    let error = runtime
        .input("s1", RdpWireInput::Unicode { text: oversized })
        .await
        .expect_err("must reject oversized unicode text");
    assert!(error.contains("character limit"), "{error}");
    // 恰好 4096 字符：上限校验通过（错误变为“会话不存在”）。
    let at_limit = "a".repeat(MAX_UNICODE_TEXT_CHARS);
    let error = runtime
        .input("s1", RdpWireInput::Unicode { text: at_limit })
        .await
        .expect_err("session lookup still fails");
    assert!(error.contains("not found"), "{error}");
}

// —— B4：known-certs 写盘并发安全 + 插入序淘汰 ——————————————————

#[test]
fn prune_oldest_entries_drops_the_genuinely_oldest() {
    let mut store = HashMap::new();
    for (key, inserted_at) in [("a", 30_u64), ("b", 10), ("c", 20), ("d", 10)] {
        store.insert(
            key.to_string(),
            KnownCertEntry {
                fingerprint: format!("SHA256:{key}"),
                inserted_at,
            },
        );
    }
    prune_oldest_entries(&mut store, 2);
    assert_eq!(store.len(), 2);
    // 最旧的 2 条按 inserted_at 淘汰：b/d 同秒并列（10），按 key 字典序
    // b 先走，随后 d；a(30)/c(20) 保留。
    assert!(!store.contains_key("b"), "oldest tie (b) must go first");
    assert!(!store.contains_key("d"));
    assert!(store.contains_key("a"));
    assert!(store.contains_key("c"));
}

#[test]
fn known_cert_store_loads_legacy_flat_shape() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let store = KnownCertStore::new(data_dir.path());
    std::fs::write(&store.path, r#"{"rdp.local:3389":"SHA256:legacy"}"#).expect("write v1 shape");
    assert_eq!(
        store.check("rdp.local", 3389, "SHA256:legacy"),
        KnownCertStatus::Match
    );
    // 迁移写盘后再读仍是 V2 信封。
    store
        .remember_at("other.local", 3389, "SHA256:new", 42)
        .expect("remember");
    let text = std::fs::read_to_string(&store.path).expect("read");
    assert!(text.contains("\"entries\""), "{text}");
    assert_eq!(
        store.check("rdp.local", 3389, "SHA256:legacy"),
        KnownCertStatus::Match
    );
}

#[test]
fn known_cert_store_evicts_by_insertion_order() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let store = KnownCertStore::new(data_dir.path());
    store.remember_at("old.local", 3389, "SHA256:old", 1).ok();
    store
        .remember_at("new.local", 3389, "SHA256:new", 2)
        .expect("remember");
    // 压到淘汰线上：最旧（inserted_at=1）必须先走，与 key 字典序无关
    //（"old.local" 的字典序反而最小——旧实现会先淘汰它）。
    for index in 0..KNOWN_CERTS_MAX_ENTRIES {
        store
            .remember_at(
                &format!("host{index}.local"),
                3389,
                &format!("SHA256:{index:04}"),
                100 + index as u64,
            )
            .expect("remember");
    }
    assert_eq!(
        store.check("old.local", 3389, "SHA256:old"),
        KnownCertStatus::Unknown,
        "the genuinely oldest entry must be evicted first"
    );
    assert_eq!(
        store.check("new.local", 3389, "SHA256:new"),
        KnownCertStatus::Unknown,
        "second-oldest goes next — by insertion time, not key order"
    );
    let entries = store.load_entries();
    assert_eq!(entries.len(), KNOWN_CERTS_MAX_ENTRIES);
}

#[test]
fn known_cert_store_concurrent_remembers_leave_valid_file() {
    // B4 TOCTOU：每个 remember 用唯一 tmp 名，并发写不再互相覆盖中间态
    //（残留窗口：最后 rename 者整体胜出，最坏丢一条 → 重新 prompt，
    // fail-closed）。
    let data_dir = std::sync::Arc::new(tempfile::tempdir().expect("tempdir"));
    let handles: Vec<_> = (0..8)
        .map(|index| {
            let store = KnownCertStore::new(data_dir.path());
            std::thread::spawn(move || {
                store.remember_at(
                    &format!("host{index}.local"),
                    3389,
                    &format!("SHA256:{index:02}"),
                    index as u64,
                )
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("thread").expect("remember");
    }
    // 产物必须是合法 JSON（坏中间态会让整个 store 变空 → 全部遗忘）。
    let store = KnownCertStore::new(data_dir.path());
    let entries = store.load_entries();
    assert!(
        !entries.is_empty(),
        "concurrent writes must not corrupt the store"
    );
    // 无残留 tmp 文件（全部被 rename 掉）。
    let leftovers: Vec<_> = std::fs::read_dir(data_dir.path())
        .expect("dir")
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.ends_with(".tmp"))
                .unwrap_or(false)
        })
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn cert_key_is_case_insensitive() {
    // B4 次要：`RDP.local` 与 `rdp.local` 必须是同一条目，否则大小写
    // 翻转导致重复 prompt（fail-closed 但烦人）。
    assert_eq!(cert_key("RDP.local", 3389), cert_key("rdp.local", 3389));
    let mut store = HashMap::new();
    store.insert(cert_key("RDP.local", 3389), "SHA256:aa".to_string());
    assert_eq!(
        known_cert_status(&store, "rdp.local", 3389, "SHA256:aa"),
        KnownCertStatus::Match
    );
}

// —— B6：start 请求脱敏 + wire 身份上界 ————————————————————————

#[test]
fn start_request_debug_redacts_the_password() {
    let request: RdpStartRequest = serde_json::from_value(serde_json::json!({
        "workbenchId": "w1", "host": "rdp.local", "username": "admin",
        "password": "hunter2"
    }))
    .expect("parse");
    let rendered = format!("{request:?}");
    assert!(rendered.contains("<set>"), "{rendered}");
    assert!(!rendered.contains("hunter2"), "{rendered}");
    let request: RdpStartRequest = serde_json::from_value(serde_json::json!({
        "workbenchId": "w1", "host": "rdp.local", "username": "admin"
    }))
    .expect("parse");
    assert!(format!("{request:?}").contains("None"));
}

#[tokio::test]
async fn start_rejects_oversized_wire_identities() {
    let runtime = RdpSessionRuntime::new();
    let data_dir = tempfile::tempdir().expect("tempdir");
    let build = |host: String, username: String, domain: Option<String>| RdpStartRequest {
        workbench_id: "w1".to_string(),
        connection_id: None,
        host,
        port: Some(3389),
        username,
        password: None,
        domain,
        width: None,
        height: None,
        use_nla: None,
        certificate_policy: None,
        clipboard: None,
        reconnect_attempts: None,
    };
    // host 256 字节（含 1 字节 trim 后仍超）。
    let error = runtime
        .start(
            build("a".repeat(MAX_HOST_LEN + 1), "user".into(), None),
            test_emitter(),
            data_dir.path(),
        )
        .await
        .expect_err("oversized host");
    assert!(error.contains("host exceeds"), "{error}");
    // username 129 字符。
    let error = runtime
        .start(
            build("rdp.local".into(), "u".repeat(MAX_USERNAME_LEN + 1), None),
            test_emitter(),
            data_dir.path(),
        )
        .await
        .expect_err("oversized username");
    assert!(error.contains("username exceeds"), "{error}");
    // domain 129 字符。
    let error = runtime
        .start(
            build(
                "rdp.local".into(),
                "user".into(),
                Some("d".repeat(MAX_DOMAIN_LEN + 1)),
            ),
            test_emitter(),
            data_dir.path(),
        )
        .await
        .expect_err("oversized domain");
    assert!(error.contains("domain exceeds"), "{error}");
}

// —— start 幂等查重（reconnect 双 start 竞态修复）—————————————————

/// 构造一条测试用会话条目（不 spawn worker），供幂等查重测试直接播种
/// 进 sessions 表，得到确定性的"已存在活会话"前置态。
fn test_session_entry(workbench_id: &str, host: &str, data_dir: &Path) -> Arc<RdpSessionEntry> {
    Arc::new(RdpSessionEntry {
        workbench_id: workbench_id.to_string(),
        host: host.to_string(),
        port: 3389,
        username: "user".to_string(),
        domain: String::new(),
        password: None,
        width: AtomicU16::new(1280),
        height: AtomicU16::new(800),
        use_nla: true,
        cert_policy: CertPolicy::Prompt,
        clipboard_enabled: true,
        reconnect_attempts: DEFAULT_RECONNECT_ATTEMPTS,
        created_at_secs: unix_now_secs(),
        generation: Arc::new(AtomicU64::new(0)),
        frame_state: tokio::sync::Mutex::new(RdpFrameState::default()),
        close_requested: AtomicBool::new(false),
        cert_wait: Arc::new(AtomicBool::new(false)),
        command_sender: tokio::sync::Mutex::new(None),
        clipboard_stage: Arc::new(ClipboardStage::default()),
        broker: Arc::new(CertPromptBroker::new()),
        known_certs: KnownCertStore::new(data_dir),
    })
}

fn idempotent_start_request(workbench_id: &str, host: &str) -> RdpStartRequest {
    RdpStartRequest {
        workbench_id: workbench_id.to_string(),
        connection_id: None,
        host: host.to_string(),
        port: Some(3389),
        username: "user".to_string(),
        password: None,
        domain: None,
        width: None,
        height: None,
        use_nla: None,
        certificate_policy: None,
        clipboard: None,
        reconnect_attempts: None,
    }
}

#[tokio::test]
async fn start_reuses_live_session_for_same_workbench() {
    let runtime = RdpSessionRuntime::new();
    let data_dir = tempfile::tempdir().expect("tempdir");
    // 播种同 workbenchId 的活会话（10.255.255.1 不可达，确保播种条目
    // 不会被真实 worker 的失败路径移除，前置态确定）。
    let seeded_id = uuid::Uuid::new_v4().to_string();
    runtime.sessions.write().await.insert(
        seeded_id.clone(),
        test_session_entry("w1", "10.255.255.1", data_dir.path()),
    );
    // 第二次 rdp/start（同 workbenchId）必须命中幂等：复用既有 sessionId。
    let started = runtime
        .start(
            idempotent_start_request("w1", "10.255.255.1"),
            test_emitter(),
            data_dir.path(),
        )
        .await
        .expect("idempotent start");
    assert_eq!(started["sessionId"].as_str(), Some(seeded_id.as_str()));
    assert_eq!(started["host"].as_str(), Some("10.255.255.1"));
    // 未新建第二个会话。
    assert_eq!(runtime.sessions.read().await.len(), 1);
}

#[tokio::test]
async fn start_creates_fresh_session_once_previous_one_closed() {
    let runtime = RdpSessionRuntime::new();
    let data_dir = tempfile::tempdir().expect("tempdir");
    let seeded_id = uuid::Uuid::new_v4().to_string();
    runtime.sessions.write().await.insert(
        seeded_id.clone(),
        test_session_entry("w1", "10.255.255.1", data_dir.path()),
    );
    // 终态（close 移除表项）后，同 workbenchId 的 start 照常新建，
    // 不得命中幂等复用。
    runtime.close(&seeded_id).await.expect("close");
    assert!(runtime.sessions.read().await.is_empty());
    let started = runtime
        .start(
            idempotent_start_request("w1", "10.255.255.1"),
            test_emitter(),
            data_dir.path(),
        )
        .await
        .expect("fresh start");
    let fresh_id = started["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    assert_ne!(fresh_id, seeded_id);
    assert!(runtime.sessions.read().await.contains_key(&fresh_id));
}

// —— vendored 链红线（NTLMv1/LM 不可用、连接器默认 NTLM）———————

#[test]
fn vendored_sspi_marks_ntlmv1_and_lm_as_unsupported() {
    // 清单 §3-A【硬】禁 NTLMv1/LM：vendored sspi 源码明示二者不受支持
    // （fail-closed by construction）。源码文本断言把该事实钉在测试上，
    // vendored 链升级漂移时立即失败。
    let ntlm = include_str!("../../vendor/sspi/src/ntlm/mod.rs");
    assert!(ntlm.contains("NTLMv1 Session Security, deprecated, insecure and not supported by us"));
    assert!(ntlm.contains("LM Session Security, deprecated, insecure and not supported by us"));
    // 连接器默认走 ClientMode::Ntlm（本模块不构造 Kerberos 配置，
    // Kerberos 属范围外）。
    let credssp = include_str!("../../vendor/ironrdp-connector/src/credssp.rs");
    assert!(credssp.contains("ClientMode::Ntlm(sspi::ntlm::NtlmConfig::default())"));
}

// —— 客户端标识 ————————————————————————————————————————————

#[test]
fn client_build_encodes_the_package_version() {
    assert_eq!(client_build(), 706); // 0.7.6：(0*100+7)*100+6；patch 段含非数字后缀按 0 计
}

#[test]
fn client_name_falls_back_without_hostname() {
    // 仅验证不 panic 且非空（环境变量在本机存在与否不定）。
    assert!(!client_name().is_empty());
}
