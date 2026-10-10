// RDP 远程桌面（nyaterm-parity P3-4，RDP-3 前端）帧解码 + 键鼠输入映射 +
// 会话状态机（纯逻辑，无 DOM/桥接依赖，便于单测）。
//
// 帧补丁与 vnc/frame **同一** 44 字节 patch 头 + RGBA 负载（RDP-2 在 sidecar
// 复用了 vnc_session::encode_frame_patch 的同构封装；字段表/校验不变式/
// golden 向量见 docs/PROTOCOL.zh-CN.md「VNC 帧补丁」小节与 RDP 节）——解码器
// 直接复用 decodeVncFramePatch，不复制实现。输入映射对齐 NyaTerm
// `src/core/rdp.rs` 的扫描码语义（XT set 1 + extended 标志，右 Shift 0x36
// 非扩展），线制形状与 sidecar `RdpWireInput`（rdp_session.rs）逐字段一致。
// 会话状态机压缩 `rdp/session/state` 事件为连接卡/覆盖层的视图状态。

import { decodeVncFramePatch, type VncFramePatch } from "./vncFrame";

export type RdpFramePatch = VncFramePatch;

/** 解码 RDP 帧补丁：与 vnc/frame 同一 44 字节头，校验规则同 VNC（超契约直接复用）。 */
export function decodeRdpFramePatch(buffer: ArrayBuffer | Uint8Array): RdpFramePatch {
  return decodeVncFramePatch(buffer);
}

// —— rdp/input 线制形状（与 sidecar RdpWireInput 契约一致；camelCase 别名由
//    sidecar 接受，这里直接发文档字段名）———————————————————————————

export type RdpMouseButton = "left" | "middle" | "right" | "back" | "forward";

export type RdpInputEvent =
  | { kind: "key-down" | "key-up"; scanCode: number; extended: boolean }
  | { kind: "unicode"; text: string }
  | { kind: "mouse-move"; x: number; y: number }
  | { kind: "mouse-button"; button: RdpMouseButton; pressed: boolean; x: number; y: number }
  | { kind: "mouse-wheel"; deltaX: number; deltaY: number; x: number; y: number }
  | { kind: "release-all" };

/** `rdp/pointer` 事件线制形状（sidecar 发出，光标形状 → 画布 CSS cursor）。 */
export type RdpPointerEvent =
  | { type: "default" }
  | { type: "hidden" }
  | { type: "position"; x: number; y: number }
  | { type: "bitmap"; width: number; height: number; hotspotX: number; hotspotY: number; rgbaBase64: string };

/** XT set 1 扫描码 + extended 标志（event.code 为物理键位，与布局无关）。 */
export interface RdpScanCode {
  scanCode: number;
  extended: boolean;
}

// 物理键位 → XT set 1 扫描码。值取 NyaTerm rdp 输入数据库同源的标准键盘表。
const SCAN_CODES: Readonly<Record<string, number>> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  // 右 Shift 是 0x36 非扩展（sidecar 对它走直发 fast-path，NyaTerm 修复）。
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  F11: 0x57,
  F12: 0x58,
  IntlBackslash: 0x56,
  IntlRo: 0x73,
  IntlYen: 0x7d,
};

// E0 前缀（extended）键位：光标/编辑区/右修饰键/小键盘复制键。
const EXTENDED_SCAN_CODES: Readonly<Record<string, number>> = {
  Insert: 0x52,
  Delete: 0x53,
  Home: 0x47,
  End: 0x4f,
  PageUp: 0x49,
  PageDown: 0x51,
  ArrowUp: 0x48,
  ArrowLeft: 0x4b,
  ArrowDown: 0x50,
  ArrowRight: 0x4d,
  ControlRight: 0x1d,
  AltRight: 0x38,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d,
  NumpadEnter: 0x1c,
  NumpadDivide: 0x35,
  PrintScreen: 0x37,
};

/** DOM 键盘事件 → RDP 扫描码；无法映射（IME 组合键等）返回 null，调用方走 unicode 兜底。 */
export function mapKeyboardEventToRdpScanCode(event: Pick<KeyboardEvent, "code">): RdpScanCode | null {
  const extended = EXTENDED_SCAN_CODES[event.code];
  if (extended !== undefined) return { scanCode: extended, extended: true };
  const base = SCAN_CODES[event.code];
  if (base !== undefined) return { scanCode: base, extended: false };
  return null;
}

/**
 * DOM 键盘事件 → rdp/input 事件序列：可映射键给 press（release 由 keyup 生成）；
 * 不可映射的单字符键（中文 IME 候选等）落 unicode 通道，由 sidecar 按字符
 * press+release 展开（与 vncFrame 的 composition 兜底同思路）。
 */
export function buildRdpKeyDownEvent(event: Pick<KeyboardEvent, "key" | "code">): RdpInputEvent | null {
  const scan = mapKeyboardEventToRdpScanCode(event);
  if (scan) return { kind: "key-down", scanCode: scan.scanCode, extended: scan.extended };
  if (Array.from(event.key).length === 1) return { kind: "unicode", text: event.key };
  return null;
}

/** keyup → rdp/input：有扫描码的键发 key-up；unicode 键无需 release（sidecar 成对展开）。 */
export function buildRdpKeyUpEvent(event: Pick<KeyboardEvent, "key" | "code">): RdpInputEvent | null {
  const scan = mapKeyboardEventToRdpScanCode(event);
  if (scan) return { kind: "key-up", scanCode: scan.scanCode, extended: scan.extended };
  return null;
}

/** DOM MouseEvent.button → RDP 鼠标键名（0/1/2/3/4 = left/middle/right/back/forward）。 */
export function mapDomButtonToRdpButton(button: number): RdpMouseButton | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}

// —— 会话状态机（rdp/session/state → 连接卡/覆盖层视图状态）—————————————————

/** `rdp/session/state` 的 errorKind 枚举（PROTOCOL「RDP 远程桌面会话」节）。 */
export type RdpErrorKind = "transport" | "tls" | "certificate" | "authentication" | "negotiation" | "session" | "clipboard";

const ERROR_KINDS: ReadonlySet<string> = new Set(["transport", "tls", "certificate", "authentication", "negotiation", "session", "clipboard"]);

/** errorKind → i18n 键尾（rdp.error.<kind>）；未知 kind 返回空串（走原始 error 文本）。 */
export function rdpErrorKindKey(errorKind: unknown): string {
  return typeof errorKind === "string" && ERROR_KINDS.has(errorKind) ? errorKind : "";
}

/** 覆盖层视图状态：idle=无会话；closed 含 error/errorKind（closed 与 error 事件同落此态）。 */
export interface RdpSessionStateView {
  state: "idle" | "connecting" | "running" | "reconnecting" | "closed";
  error: string;
  errorKind: string;
  attempt: number;
  maxAttempts: number;
}

export function initialRdpSessionState(): RdpSessionStateView {
  return { state: "idle", error: "", errorKind: "", attempt: 0, maxAttempts: 0 };
}

/**
 * 纯 reducer：把一条 `rdp/session/state` 事件折进视图状态。
 * - connected 在首个桌面帧到达时由 sidecar 发布 → running；
 * - reconnecting 携带 attempt/maxAttempts（退避梯子进度）→ reconnecting；
 * - closed（graceful disconnect）与 error（终态失败）都落 closed 覆盖层，
 *   error 带 errorKind/error 文本；未知 state 保持不变（容忍旧 sidecar）。
 */
export function reduceRdpSessionState(
  current: RdpSessionStateView,
  event: { state?: unknown; errorKind?: unknown; error?: unknown; attempt?: unknown; maxAttempts?: unknown },
): RdpSessionStateView {
  const error = typeof event.error === "string" ? event.error : "";
  const errorKind = rdpErrorKindKey(event.errorKind);
  const attempt = typeof event.attempt === "number" && Number.isFinite(event.attempt) ? event.attempt : current.attempt;
  const maxAttempts = typeof event.maxAttempts === "number" && Number.isFinite(event.maxAttempts) ? event.maxAttempts : current.maxAttempts;
  switch (event.state) {
    case "connecting":
      return { state: "connecting", error: "", errorKind: "", attempt: 0, maxAttempts: 0 };
    case "connected":
      return { state: "running", error: "", errorKind: "", attempt: 0, maxAttempts: 0 };
    case "reconnecting":
      return { state: "reconnecting", error: "", errorKind: "", attempt, maxAttempts };
    case "closed":
    case "error":
      return { state: "closed", error, errorKind, attempt: 0, maxAttempts: 0 };
    default:
      return current;
  }
}

// —— 证书确认（connection/challenge kind=rdp-certificate）———————————————

export const RDP_CERT_CHALLENGE_KIND = "rdp-certificate";
/** sidecar 确认窗：120s，超时 fail-closed（应答被拒），前端同步倒计时只是视觉镜像。 */
export const RDP_CERT_PROMPT_WINDOW_SECS = 120;

/** 判定一条 connection/challenge 事件是否 RDP 证书确认（kind + challengeId 齐备）。 */
export function isRdpCertificateChallenge(params: Record<string, unknown> | null | undefined): boolean {
  return !!params && params.kind === RDP_CERT_CHALLENGE_KIND && typeof params.challengeId === "string" && params.challengeId.length > 0;
}

/** knownHostStatus → i18n 键尾（rdp.cert.status.<s>）；非法值回落 unknown。 */
export function rdpCertStatusKey(knownHostStatus: unknown): "match" | "changed" | "unknown" {
  return knownHostStatus === "match" || knownHostStatus === "changed" ? knownHostStatus : "unknown";
}

/** 证书确认剩余秒数（按 receivedAt + 120s 绝对期限计算，tick 无漂移）。 */
export function rdpCertRemainingSecs(receivedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((receivedAtMs + RDP_CERT_PROMPT_WINDOW_SECS * 1000 - nowMs) / 1000));
}
