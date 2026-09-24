// VNC 帧补丁解码 + 键鼠输入映射（nyaterm-parity P2 2d）。
//
// decodeVncFramePatch 对齐 sidecar 44 字节 patch 头（sequence u64 LE +
// desktop W/H + x/y/w/h + stride + pixel_format + payload_len，各 u32 LE，
// RGBA8888 线制值 2）——与 NyaTerm remoteDesktopFrame.ts 同一协议，字节序
// 与校验规则一致；键盘/指针映射改写自 NyaTerm vncInput.ts（MIT）。
// 全部为纯函数：不触 DOM/桥接，便于单测。

export type VncPixelFormat = "RGBA8888";

export interface VncFramePatch {
  /** 单调递增（sidecar 跨重连持续递增），乱序补丁直接丢弃。 */
  sequence: number;
  desktopWidth: number;
  desktopHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 字节/行；恒为 width*4（RGBA 紧排），保留字段以对齐线制协议。 */
  stride: number;
  pixelFormat: VncPixelFormat;
  /** RGBA 像素数据（不含 44 字节头）。 */
  payload: Uint8Array;
}

/** 输入事件线制形态（与 sidecar vnc/input 的 JSON 契约一致）。 */
export type VncInputEvent =
  | { kind: "key"; keysym: number; pressed: boolean }
  | { kind: "pointer"; x: number; y: number; buttonMask: number }
  | { kind: "release-all" };

const HEADER_BYTES = 44;
const FORMAT_RGBA8888 = 2;
const BYTES_PER_PIXEL = 4;

function checkedProduct(left: number, right: number, label: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new Error(`VNC frame patch ${label} overflows`);
  }
  return product;
}

function checkedSum(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`VNC frame patch ${label} overflows`);
  }
  return sum;
}

/** 解码并校验一个 44 字节头的帧补丁；任何字段不合法都抛错（调用方丢弃该帧）。 */
export function decodeVncFramePatch(buffer: ArrayBuffer | Uint8Array): VncFramePatch {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error("VNC frame patch is too short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le32 = (offset: number) => view.getUint32(offset, true);
  const sequence = Number(view.getBigUint64(0, true));
  const desktopWidth = le32(8);
  const desktopHeight = le32(12);
  const x = le32(16);
  const y = le32(20);
  const width = le32(24);
  const height = le32(28);
  const stride = le32(32);
  const format = le32(36);
  const payloadLength = le32(40);
  const expectedLength = checkedSum(HEADER_BYTES, payloadLength, "payload length");
  if (bytes.byteLength !== expectedLength) {
    throw new Error("VNC frame patch payload length mismatch");
  }
  if (desktopWidth === 0 || desktopHeight === 0) {
    throw new Error("VNC frame patch desktop size is empty");
  }
  if (width === 0 || height === 0) {
    throw new Error("VNC frame patch rectangle is empty");
  }
  const rowBytes = checkedProduct(width, BYTES_PER_PIXEL, "row size");
  if (stride < rowBytes) {
    throw new Error("VNC frame patch stride is too small");
  }
  const requiredPayloadLength = checkedProduct(stride, height, "payload size");
  if (payloadLength < requiredPayloadLength) {
    throw new Error("VNC frame patch payload is too small for stride and height");
  }
  const right = checkedSum(x, width, "horizontal bounds");
  const bottom = checkedSum(y, height, "vertical bounds");
  if (right > desktopWidth || bottom > desktopHeight) {
    throw new Error("VNC frame patch rectangle exceeds desktop bounds");
  }
  if (format !== FORMAT_RGBA8888) {
    throw new Error(`Unsupported VNC pixel format ${format}`);
  }
  return {
    sequence,
    desktopWidth,
    desktopHeight,
    x,
    y,
    width,
    height,
    stride,
    pixelFormat: "RGBA8888",
    payload: bytes.slice(HEADER_BYTES, HEADER_BYTES + payloadLength),
  };
}

// —— X keysym 映射（改写自 NyaTerm vncInput.ts）——————————————————

const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Menu: 0xff67,
  NumLock: 0xff7f,
  Delete: 0xffff,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  CapsLock: 0xffe5,
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  SuperLeft: 0xffeb,
  SuperRight: 0xffec,
  ScrollLock: 0xff14,
  F1: 0xffbe,
} as const;

const SPECIAL_KEYSYMS: Readonly<Record<string, number>> = {
  Backspace: XK.BackSpace,
  Tab: XK.Tab,
  Enter: XK.Return,
  Escape: XK.Escape,
  Home: XK.Home,
  ArrowLeft: XK.Left,
  ArrowUp: XK.Up,
  ArrowRight: XK.Right,
  ArrowDown: XK.Down,
  PageUp: XK.PageUp,
  PageDown: XK.PageDown,
  End: XK.End,
  Insert: XK.Insert,
  ContextMenu: XK.Menu,
  NumLock: XK.NumLock,
  Delete: XK.Delete,
  CapsLock: XK.CapsLock,
  ScrollLock: XK.ScrollLock,
};

/** 修饰键按物理键位（event.code）区分左右，避免服务端粘键。 */
const CODE_KEYSYMS: Readonly<Record<string, number>> = {
  ShiftLeft: XK.ShiftLeft,
  ShiftRight: XK.ShiftRight,
  ControlLeft: XK.ControlLeft,
  ControlRight: XK.ControlRight,
  AltLeft: XK.AltLeft,
  AltRight: XK.AltRight,
  MetaLeft: XK.SuperLeft,
  MetaRight: XK.SuperRight,
};

/** RFB 指针事件按钮位掩码（RFC 6143 7.5.5）。 */
export const VNC_POINTER_BUTTON = {
  left: 1,
  middle: 2,
  right: 4,
  wheelUp: 8,
  wheelDown: 16,
  wheelLeft: 32,
  wheelRight: 64,
} as const;

/** Unicode 码点 → keysym：Latin-1 直映，BMP 之上走 0x01000000 偏移。 */
export function unicodeCodePointToVncKeysym(codePoint: number): number | null {
  if (!Number.isInteger(codePoint) || codePoint < 0x20 || codePoint > 0x10ffff) return null;
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
}

/** DOM 键盘事件 → X keysym；无法映射返回 null（调用方跳过该键）。 */
export function mapKeyboardEventToVncKeysym(event: Pick<KeyboardEvent, "key" | "code">): number | null {
  const codeKeysym = CODE_KEYSYMS[event.code];
  if (codeKeysym !== undefined) return codeKeysym;

  const specialKeysym = SPECIAL_KEYSYMS[event.key];
  if (specialKeysym !== undefined) return specialKeysym;

  if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) {
    return XK.F1 + Number(event.key.slice(1)) - 1;
  }

  const codePoints = Array.from(event.key);
  if (codePoints.length !== 1) return null;
  return unicodeCodePointToVncKeysym(codePoints[0].codePointAt(0) ?? -1);
}

/** 把一段文本展开为逐字符 press/release 事件（无剪贴板同步的服务端兜底输入）。 */
export function buildVncCompositionKeyEvents(text: string): VncInputEvent[] {
  const events: VncInputEvent[] = [];
  for (const character of Array.from(text)) {
    const keysym = unicodeCodePointToVncKeysym(character.codePointAt(0) ?? -1);
    if (keysym === null) continue;
    events.push({ kind: "key", keysym, pressed: true });
    events.push({ kind: "key", keysym, pressed: false });
  }
  return events;
}

/** DOM MouseEvent.buttons 位集 → RFB 按钮掩码。 */
export function pointerButtonMask(buttons: number): number {
  let mask = 0;
  if (buttons & 1) mask |= VNC_POINTER_BUTTON.left;
  if (buttons & 4) mask |= VNC_POINTER_BUTTON.middle;
  if (buttons & 2) mask |= VNC_POINTER_BUTTON.right;
  return mask;
}
