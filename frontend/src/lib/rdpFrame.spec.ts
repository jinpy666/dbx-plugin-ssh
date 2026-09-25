// rdpFrame 纯逻辑单测：帧解码（复用 vncFrame 44 字节 patch 头，含跨端 golden
// 向量）、rdp/input 键鼠映射、rdp/session/state 状态机、rdp-certificate 挑战
// 分支。全部纯函数，不连 sidecar。
import { describe, expect, it } from "vitest";
import {
  buildRdpKeyDownEvent,
  buildRdpKeyUpEvent,
  decodeRdpFramePatch,
  initialRdpSessionState,
  isRdpCertificateChallenge,
  mapDomButtonToRdpButton,
  mapKeyboardEventToRdpScanCode,
  RDP_CERT_CHALLENGE_KIND,
  RDP_CERT_PROMPT_WINDOW_SECS,
  rdpCertRemainingSecs,
  rdpCertStatusKey,
  rdpErrorKindKey,
  reduceRdpSessionState,
  type RdpInputEvent,
  type RdpSessionStateView,
} from "./rdpFrame";

describe("decodeRdpFramePatch", () => {
  // 与 VNC 同一 44 字节 patch 头（PROTOCOL「二进制通道」：rdp/frame 与
  // vnc/frame 同格式，前端解码器直接复用）——golden 向量沿用 vncFrame.spec
  // 与 backend/src/vnc_session.rs 的跨端断言，任何一侧单独变化即测试失败。
  const GOLDEN_FRAME_HEX = "2a00000000000000080000000800000002000000010000000400000004000000100000000200000040000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

  it("decodes the shared patch header via the vnc decoder", () => {
    const frame = new Uint8Array((GOLDEN_FRAME_HEX.match(/.{2}/g) ?? []).map((byte) => Number.parseInt(byte, 16)));
    const patch = decodeRdpFramePatch(frame);
    expect(patch.sequence).toBe(42);
    expect(patch.desktopWidth).toBe(8);
    expect(patch.desktopHeight).toBe(8);
    expect(patch.x).toBe(2);
    expect(patch.y).toBe(1);
    expect(patch.width).toBe(4);
    expect(patch.height).toBe(4);
    expect(patch.stride).toBe(16);
    expect(patch.pixelFormat).toBe("RGBA8888");
    expect(Array.from(patch.payload)).toEqual(Array.from({ length: 0x40 }, (_, i) => i));
  });

  it("rejects malformed frames with the same contract as vnc/frame", () => {
    expect(() => decodeRdpFramePatch(new Uint8Array(43))).toThrow("too short");
    // 合法 44 字节头但声明 payload 长度与实际不符。
    const frame = new Uint8Array(48);
    const view = new DataView(frame.buffer);
    view.setBigUint64(0, 1n, true);
    view.setUint32(8, 4, true);
    view.setUint32(12, 4, true);
    view.setUint32(24, 1, true);
    view.setUint32(28, 1, true);
    view.setUint32(32, 4, true);
    view.setUint32(36, 2, true);
    view.setUint32(40, 8, true); // 声明 8 字节 payload，实际只有 4。
    expect(() => decodeRdpFramePatch(frame)).toThrow("mismatch");
  });
});

describe("mapKeyboardEventToRdpScanCode", () => {
  it("maps base keys with non-extended scancodes", () => {
    expect(mapKeyboardEventToRdpScanCode({ code: "KeyA" })).toEqual({ scanCode: 0x1e, extended: false });
    expect(mapKeyboardEventToRdpScanCode({ code: "Enter" })).toEqual({ scanCode: 0x1c, extended: false });
    expect(mapKeyboardEventToRdpScanCode({ code: "Digit1" })).toEqual({ scanCode: 0x02, extended: false });
    // 右 Shift 走 0x36 非扩展（sidecar 直发 fast-path 的 NyaTerm 修复）。
    expect(mapKeyboardEventToRdpScanCode({ code: "ShiftRight" })).toEqual({ scanCode: 0x36, extended: false });
    expect(mapKeyboardEventToRdpScanCode({ code: "ShiftLeft" })).toEqual({ scanCode: 0x2a, extended: false });
  });

  it("marks cursor/editor/right-modifier keys extended", () => {
    expect(mapKeyboardEventToRdpScanCode({ code: "ArrowUp" })).toEqual({ scanCode: 0x48, extended: true });
    expect(mapKeyboardEventToRdpScanCode({ code: "Delete" })).toEqual({ scanCode: 0x53, extended: true });
    expect(mapKeyboardEventToRdpScanCode({ code: "ControlRight" })).toEqual({ scanCode: 0x1d, extended: true });
    expect(mapKeyboardEventToRdpScanCode({ code: "AltRight" })).toEqual({ scanCode: 0x38, extended: true });
    expect(mapKeyboardEventToRdpScanCode({ code: "NumpadEnter" })).toEqual({ scanCode: 0x1c, extended: true });
    expect(mapKeyboardEventToRdpScanCode({ code: "F12" })).toEqual({ scanCode: 0x58, extended: false });
  });

  it("returns null for unmappable codes", () => {
    expect(mapKeyboardEventToRdpScanCode({ code: "MediaPlay" })).toBeNull();
    expect(mapKeyboardEventToRdpScanCode({ code: "" })).toBeNull();
  });
});

describe("buildRdpKeyDownEvent / buildRdpKeyUpEvent", () => {
  it("maps printable keys to key-down with scancode", () => {
    expect(buildRdpKeyDownEvent({ key: "a", code: "KeyA" })).toEqual({ kind: "key-down", scanCode: 0x1e, extended: false });
  });

  it("falls back to the unicode channel for single-character IME keys", () => {
    // 物理键位（code）可映射时始终走扫描码——IME 候选字符不改物理键位。
    expect(buildRdpKeyDownEvent({ key: "中", code: "KeyZ" })).toEqual({ kind: "key-down", scanCode: 0x2c, extended: false });
    // 无扫描码的单字符键（组合输入、非标准布局残留）落 unicode 通道。
    expect(buildRdpKeyDownEvent({ key: "中", code: "" })).toEqual({ kind: "unicode", text: "中" });
    expect(buildRdpKeyUpEvent({ key: "中", code: "" })).toBeNull();
  });

  it("drops multi-character unmappable keys entirely", () => {
    expect(buildRdpKeyDownEvent({ key: "Dead", code: "Dead" })).toBeNull();
    expect(buildRdpKeyDownEvent({ key: "AudioVolumeMute", code: "" })).toBeNull();
  });

  it("emits key-up only for scancode-backed keys", () => {
    expect(buildRdpKeyUpEvent({ key: "ArrowDown", code: "ArrowDown" })).toEqual({ kind: "key-up", scanCode: 0x50, extended: true });
  });
});

describe("mapDomButtonToRdpButton", () => {
  it("maps DOM button ids onto RDP button names", () => {
    expect(mapDomButtonToRdpButton(0)).toBe("left");
    expect(mapDomButtonToRdpButton(1)).toBe("middle");
    expect(mapDomButtonToRdpButton(2)).toBe("right");
    expect(mapDomButtonToRdpButton(3)).toBe("back");
    expect(mapDomButtonToRdpButton(4)).toBe("forward");
    expect(mapDomButtonToRdpButton(7)).toBeNull();
  });
});

describe("reduceRdpSessionState", () => {
  const idle = initialRdpSessionState();

  function drive(events: Array<Parameters<typeof reduceRdpSessionState>[1]>): RdpSessionStateView {
    return events.reduce(reduceRdpSessionState, idle);
  }

  it("walks connecting → connected on the first desktop frame", () => {
    const view = drive([{ state: "connecting" }, { state: "connected" }]);
    expect(view.state).toBe("running");
    expect(view.error).toBe("");
    expect(view.errorKind).toBe("");
  });

  it("carries reconnect attempt progress into the reconnecting view", () => {
    const view = drive([{ state: "connected" }, { state: "reconnecting", attempt: 2, maxAttempts: 5 }]);
    expect(view.state).toBe("reconnecting");
    expect(view.attempt).toBe(2);
    expect(view.maxAttempts).toBe(5);
  });

  it("maps terminal error events onto the closed overlay with kind and text", () => {
    const view = drive([{ state: "connecting" }, { state: "error", errorKind: "authentication", error: "RDP authentication failed" }]);
    expect(view.state).toBe("closed");
    expect(view.errorKind).toBe("authentication");
    expect(view.error).toBe("RDP authentication failed");
  });

  it("maps graceful close onto the same closed overlay without error text", () => {
    const view = drive([{ state: "connected" }, { state: "closed" }]);
    expect(view.state).toBe("closed");
    expect(view.error).toBe("");
    expect(view.errorKind).toBe("");
  });

  it("keeps unknown states unchanged (old sidecar tolerance)", () => {
    const view = reduceRdpSessionState(idle, { state: "parked" });
    expect(view).toEqual(idle);
  });

  it("resets error fields on a fresh connecting attempt", () => {
    const view = drive([{ state: "error", errorKind: "tls", error: "handshake" }, { state: "connecting" }]);
    expect(view.state).toBe("connecting");
    expect(view.error).toBe("");
    expect(view.errorKind).toBe("");
    expect(view.attempt).toBe(0);
  });
});

describe("rdpErrorKindKey", () => {
  it("accepts the seven documented kinds and rejects the rest", () => {
    for (const kind of ["transport", "tls", "certificate", "authentication", "negotiation", "session", "clipboard"]) {
      expect(rdpErrorKindKey(kind)).toBe(kind);
    }
    expect(rdpErrorKindKey("unknown")).toBe("");
    expect(rdpErrorKindKey(undefined)).toBe("");
    expect(rdpErrorKindKey(42)).toBe("");
  });
});

describe("rdp certificate challenge branch", () => {
  it("recognizes rdp-certificate challenges by kind and challengeId", () => {
    expect(isRdpCertificateChallenge({ kind: RDP_CERT_CHALLENGE_KIND, challengeId: "c-1", fingerprint: "SHA256:ab" })).toBe(true);
    expect(isRdpCertificateChallenge({ kind: "host-key", challengeId: "c-2" })).toBe(false);
    expect(isRdpCertificateChallenge({ kind: RDP_CERT_CHALLENGE_KIND })).toBe(false);
    expect(isRdpCertificateChallenge(null)).toBe(false);
    expect(isRdpCertificateChallenge(undefined)).toBe(false);
  });

  it("maps knownHostStatus onto i18n key suffixes with unknown fallback", () => {
    expect(rdpCertStatusKey("match")).toBe("match");
    expect(rdpCertStatusKey("changed")).toBe("changed");
    expect(rdpCertStatusKey("unknown")).toBe("unknown");
    expect(rdpCertStatusKey("weird")).toBe("unknown");
    expect(rdpCertStatusKey(undefined)).toBe("unknown");
  });

  it("counts down the 120s confirmation window without drift", () => {
    expect(RDP_CERT_PROMPT_WINDOW_SECS).toBe(120);
    const receivedAt = 1_000_000;
    expect(rdpCertRemainingSecs(receivedAt, receivedAt)).toBe(120);
    expect(rdpCertRemainingSecs(receivedAt, receivedAt + 59_500)).toBe(61);
    expect(rdpCertRemainingSecs(receivedAt, receivedAt + 120_000)).toBe(0);
    expect(rdpCertRemainingSecs(receivedAt, receivedAt + 999_999)).toBe(0);
  });
});

// 输入事件形状回归：锁死 rdp/input 的线制字段名（与 sidecar RdpWireInput 对齐，
// camelCase 扫描码/滚轮别名由 sidecar 接受）。
describe("rdp input wire shapes", () => {
  it("keeps every kind on the documented wire shape", () => {
    const events: RdpInputEvent[] = [
      { kind: "key-down", scanCode: 0x1e, extended: false },
      { kind: "key-up", scanCode: 0x1e, extended: false },
      { kind: "unicode", text: "中" },
      { kind: "mouse-move", x: 10, y: 20 },
      { kind: "mouse-button", button: "left", pressed: true, x: 10, y: 20 },
      { kind: "mouse-wheel", deltaX: -12.5, deltaY: 34.5, x: 1, y: 2 },
      { kind: "release-all" },
    ];
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds).toEqual(new Set(["key-down", "key-up", "unicode", "mouse-move", "mouse-button", "mouse-wheel", "release-all"]));
  });
});
