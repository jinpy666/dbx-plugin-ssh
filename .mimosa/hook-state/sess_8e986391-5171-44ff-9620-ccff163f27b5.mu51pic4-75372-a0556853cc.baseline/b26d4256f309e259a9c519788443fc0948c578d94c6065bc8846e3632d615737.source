// @vitest-environment happy-dom
// 剪贴板兜底链（host 桥 → navigator.clipboard → execCommand 隐藏 textarea）：
// 工作台 iframe 是沙箱 opaque origin，宿主桥 clipboard 是 optional 且现网宿主
// 未提供——任何一条路径缺失都不能让复制/粘贴整体失效。
import { describe, expect, it, vi } from "vitest";

import { readClipboardText, writeClipboardText, type ClipboardPort } from "./clipboardBridge";

function port(overrides: Partial<ClipboardPort> = {}): ClipboardPort {
  return {
    readText: vi.fn(async () => "from-port"),
    writeText: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("writeClipboardText fallback chain", () => {
  it("prefers the host bridge and skips later paths when it succeeds", async () => {
    const bridge = port();
    const native = port();
    const execCommand = vi.fn(() => true);
    await expect(writeClipboardText("text", { bridge, nativeClipboard: native, execCommand })).resolves.toBe("bridge");
    expect(bridge.writeText).toHaveBeenCalledWith("text");
    expect(native.writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls through to navigator.clipboard when the bridge is missing or rejects", async () => {
    const native = port();
    await expect(writeClipboardText("text", { nativeClipboard: native, execCommand: vi.fn(() => true) })).resolves.toBe("native");
    expect(native.writeText).toHaveBeenCalledWith("text");

    const brokenBridge = port({ writeText: vi.fn(async () => { throw new Error("bridge unavailable"); }) });
    await expect(writeClipboardText("text", { bridge: brokenBridge, nativeClipboard: native, execCommand: vi.fn(() => true) })).resolves.toBe("native");
  });

  it("uses the hidden-textarea execCommand path when the bridge and navigator are unavailable", async () => {
    const execCommand = vi.fn(() => true);
    await expect(writeClipboardText("text", { execCommand })).resolves.toBe("execCommand");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea[data-dbx-clipboard]")).toBeNull();
  });

  it("treats an execCommand rejection as a failed path", async () => {
    const execCommand = vi.fn(() => { throw new Error("not implemented"); });
    await expect(writeClipboardText("text", { execCommand })).rejects.toThrow();
  });

  it("rejects only after every path failed", async () => {
    const bridge = port({ writeText: vi.fn(async () => { throw new Error("no"); }) });
    const native = port({ writeText: vi.fn(async () => { throw new Error("no"); }) });
    const execCommand = vi.fn(() => false);
    await expect(writeClipboardText("text", { bridge, nativeClipboard: native, execCommand })).rejects.toThrow("clipboard write unavailable");
  });
});

describe("readClipboardText fallback chain", () => {
  it("prefers the host bridge, then navigator.clipboard", async () => {
    const bridge = port();
    await expect(readClipboardText({ bridge })).resolves.toBe("from-port");

    const native = port();
    await expect(readClipboardText({ nativeClipboard: native })).resolves.toBe("from-port");
    expect(native.readText).toHaveBeenCalled();
  });

  it("falls through a rejecting bridge to navigator.clipboard", async () => {
    const brokenBridge = port({ readText: vi.fn(async () => { throw new Error("no"); }) });
    const native = port();
    await expect(readClipboardText({ bridge: brokenBridge, nativeClipboard: native })).resolves.toBe("from-port");
  });

  it("rejects when neither the bridge nor navigator.clipboard can read", async () => {
    await expect(readClipboardText({})).rejects.toThrow("clipboard read unavailable");
  });
});
