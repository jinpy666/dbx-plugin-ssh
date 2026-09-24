import { describe, expect, it } from "vitest";
import {
  buildVncCompositionKeyEvents,
  decodeVncFramePatch,
  mapKeyboardEventToVncKeysym,
  pointerButtonMask,
  unicodeCodePointToVncKeysym,
  VNC_POINTER_BUTTON,
  type VncFramePatch,
} from "./vncFrame";

/** 按 sidecar 的 44 字节 patch 头编码（LE），构造线制帧。 */
function encodePatch(patch: Omit<VncFramePatch, "pixelFormat" | "payload"> & { payload?: Uint8Array }): Uint8Array {
  const payload = patch.payload ?? new Uint8Array(patch.stride * patch.height);
  const frame = new Uint8Array(44 + payload.length);
  const view = new DataView(frame.buffer);
  view.setBigUint64(0, BigInt(patch.sequence), true);
  view.setUint32(8, patch.desktopWidth, true);
  view.setUint32(12, patch.desktopHeight, true);
  view.setUint32(16, patch.x, true);
  view.setUint32(20, patch.y, true);
  view.setUint32(24, patch.width, true);
  view.setUint32(28, patch.height, true);
  view.setUint32(32, patch.stride, true);
  view.setUint32(36, 2, true); // RGBA8888
  view.setUint32(40, payload.length, true);
  frame.set(payload, 44);
  return frame;
}

describe("decodeVncFramePatch", () => {
  it("roundtrips a valid patch with every header field", () => {
    const payload = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 7]);
    const frame = encodePatch({
      sequence: 7,
      desktopWidth: 10,
      desktopHeight: 10,
      x: 2,
      y: 3,
      width: 1,
      height: 2,
      stride: 4,
      payload,
    });
    const patch = decodeVncFramePatch(frame);
    expect(patch.sequence).toBe(7);
    expect(patch.desktopWidth).toBe(10);
    expect(patch.desktopHeight).toBe(10);
    expect(patch.x).toBe(2);
    expect(patch.y).toBe(3);
    expect(patch.width).toBe(1);
    expect(patch.height).toBe(2);
    expect(patch.stride).toBe(4);
    expect(patch.pixelFormat).toBe("RGBA8888");
    expect(Array.from(patch.payload)).toEqual([1, 2, 3, 255, 4, 5, 6, 7]);
  });

  it("accepts an ArrayBuffer view with a byte offset", () => {
    const frame = encodePatch({ sequence: 1, desktopWidth: 4, desktopHeight: 4, x: 0, y: 0, width: 1, height: 1, stride: 4 });
    // 桥接层给的是带 byteOffset 的视图：解码必须按视图而非底层 buffer。
    const view = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(decodeVncFramePatch(view).width).toBe(1);
    expect(decodeVncFramePatch(new Uint8Array(frame).buffer as ArrayBuffer).sequence).toBe(1);
  });

  it("rejects short frames and payload length mismatches", () => {
    expect(() => decodeVncFramePatch(new Uint8Array(43))).toThrow("too short");
    const frame = encodePatch({ sequence: 1, desktopWidth: 4, desktopHeight: 4, x: 0, y: 0, width: 1, height: 1, stride: 4 });
    const truncated = frame.slice(0, frame.length - 1);
    expect(() => decodeVncFramePatch(truncated)).toThrow("mismatch");
  });

  it("rejects empty desktop or rectangle and bounds violations", () => {
    const bad = (mutate: (view: DataView) => void) => {
      const frame = encodePatch({ sequence: 1, desktopWidth: 10, desktopHeight: 10, x: 0, y: 0, width: 2, height: 2, stride: 8 });
      mutate(new DataView(frame.buffer));
      return () => decodeVncFramePatch(frame);
    };
    expect(bad((v) => v.setUint32(8, 0, true))).toThrow("desktop size");
    expect(bad((v) => v.setUint32(24, 0, true))).toThrow("rectangle is empty");
    expect(bad((v) => v.setUint32(32, 4, true))).toThrow("stride is too small");
    // stride 加大后 required payload 超过声明长度（帧总长不变，先过长度校验）。
    expect(bad((v) => v.setUint32(32, 12, true))).toThrow("payload is too small");
    expect(bad((v) => v.setUint32(16, 9, true))).toThrow("exceeds desktop bounds");
    expect(bad((v) => v.setUint32(36, 1, true))).toThrow("Unsupported VNC pixel format 1");
  });
});

describe("keysym mapping", () => {
  it("maps special keys and modifiers", () => {
    expect(mapKeyboardEventToVncKeysym({ key: "Enter", code: "Enter" })).toBe(0xff0d);
    expect(mapKeyboardEventToVncKeysym({ key: "Escape", code: "Escape" })).toBe(0xff1b);
    expect(mapKeyboardEventToVncKeysym({ key: "ArrowLeft", code: "ArrowLeft" })).toBe(0xff51);
    expect(mapKeyboardEventToVncKeysym({ key: "Delete", code: "Delete" })).toBe(0xffff);
    // 修饰键按物理键位区分左右。
    expect(mapKeyboardEventToVncKeysym({ key: "Shift", code: "ShiftLeft" })).toBe(0xffe1);
    expect(mapKeyboardEventToVncKeysym({ key: "Shift", code: "ShiftRight" })).toBe(0xffe2);
  });

  it("maps F1-F12 and printable characters", () => {
    expect(mapKeyboardEventToVncKeysym({ key: "F1", code: "F1" })).toBe(0xffbe);
    expect(mapKeyboardEventToVncKeysym({ key: "F12", code: "F12" })).toBe(0xffc9);
    expect(mapKeyboardEventToVncKeysym({ key: "a", code: "KeyA" })).toBe(0x61);
    expect(mapKeyboardEventToVncKeysym({ key: " ", code: "Space" })).toBe(0x20);
  });

  it("maps non-Latin unicode via the 0x01000000 offset", () => {
    expect(unicodeCodePointToVncKeysym(0x4e2d)).toBe(0x01004e2d);
    expect(mapKeyboardEventToVncKeysym({ key: "中", code: "KeyZ" })).toBe(0x01004e2d);
    expect(unicodeCodePointToVncKeysym(0x1f)).toBeNull();
    expect(mapKeyboardEventToVncKeysym({ key: "Dead", code: "Dead" })).toBeNull();
  });

  it("expands composition text into press/release pairs", () => {
    const events = buildVncCompositionKeyEvents("a中");
    expect(events).toEqual([
      { kind: "key", keysym: 0x61, pressed: true },
      { kind: "key", keysym: 0x61, pressed: false },
      { kind: "key", keysym: 0x01004e2d, pressed: true },
      { kind: "key", keysym: 0x01004e2d, pressed: false },
    ]);
  });
});

describe("pointerButtonMask", () => {
  it("maps DOM buttons onto RFB bits", () => {
    expect(pointerButtonMask(0)).toBe(0);
    expect(pointerButtonMask(1)).toBe(VNC_POINTER_BUTTON.left);
    expect(pointerButtonMask(2)).toBe(VNC_POINTER_BUTTON.right);
    expect(pointerButtonMask(4)).toBe(VNC_POINTER_BUTTON.middle);
    expect(pointerButtonMask(3)).toBe(VNC_POINTER_BUTTON.left | VNC_POINTER_BUTTON.right);
  });
});
