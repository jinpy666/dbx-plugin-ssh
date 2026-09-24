// 键位路由与右键语义已迁往可编辑设置：键位在 terminalHotkeys.spec.ts，
// 右键/粘贴/响铃等终端行为在 terminalBehavior.spec.ts。本文件只覆盖不可配置的
// 门禁与搜索辅助逻辑。
import { describe, expect, it } from "vitest";
import { canAcceptFileDrop, canAcceptTerminalDrop, createTerminalCopyCache, isApplePlatform, isTerminalSelectAllShortcut, normalizeDropTargetDir, resolveDropTargetDir, resolveTerminalKeyAction, resolveTerminalPasteText, resolveTerminalRightClickAction, sanitizeSearchOptions, sanitizeSelectCopyEnabled, terminalSearchSeedFromSelection } from "./terminalInteraction";

describe("terminal interaction preferences (select-to-copy / right-click-paste)", () => {
  it("defaults select-to-copy to enabled and only honors an explicit 'false'", () => {
    expect(sanitizeSelectCopyEnabled(null)).toBe(true);
    expect(sanitizeSelectCopyEnabled("")).toBe(true);
    expect(sanitizeSelectCopyEnabled("true")).toBe(true);
    expect(sanitizeSelectCopyEnabled("garbage")).toBe(true);
    expect(sanitizeSelectCopyEnabled("false")).toBe(false);
  });

  it("routes plain right-click to paste only while the mode is on", () => {
    expect(resolveTerminalRightClickAction({ selectCopy: true, shiftKey: false })).toBe("paste");
    // Shift+right-click keeps the context menu reachable even in paste mode.
    expect(resolveTerminalRightClickAction({ selectCopy: true, shiftKey: true })).toBe("menu");
    // Mode off: right-click always opens the menu (historical behavior).
    expect(resolveTerminalRightClickAction({ selectCopy: false, shiftKey: false })).toBe("menu");
    expect(resolveTerminalRightClickAction({ selectCopy: false, shiftKey: true })).toBe("menu");
  });
});

describe("right-click paste fallback chain (sandboxed-host clipboard)", () => {
  it("prefers the system clipboard, then the plugin-view copy cache, then the live selection", () => {
    expect(resolveTerminalPasteText({ clipboardText: "cb", cachedText: "cache", selectionText: "sel" })).toBe("cb");
    expect(resolveTerminalPasteText({ clipboardText: null, cachedText: "cache", selectionText: "sel" })).toBe("cache");
    expect(resolveTerminalPasteText({ clipboardText: null, cachedText: "", selectionText: "sel" })).toBe("sel");
    // No source at all: the caller shows the use-shortcut guidance.
    expect(resolveTerminalPasteText({})).toBeNull();
    expect(resolveTerminalPasteText({ clipboardText: "", cachedText: "", selectionText: "" })).toBeNull();
  });

  it("keeps whitespace-only copies as real paste candidates", () => {
    // Copying indentation is legitimate; only the empty string means "absent".
    expect(resolveTerminalPasteText({ cachedText: "  " })).toBe("  ");
  });
});

describe("plugin-view terminal copy cache", () => {
  it("stores the latest copy, caps to the tail, and never clobbers with an empty write", () => {
    const cache = createTerminalCopyCache(16);
    cache.set("first");
    expect(cache.get()).toBe("first");
    cache.set("second-copy");
    expect(cache.get()).toBe("second-copy");
    cache.set("x".repeat(20));
    expect(cache.get()).toBe("x".repeat(16));
    cache.set("");
    expect(cache.get()).toBe("x".repeat(16));
    cache.clear();
    expect(cache.get()).toBe("");
  });
});

describe("terminal keyboard shortcuts (copy/paste routing)", () => {
  it("routes Ctrl/Cmd+Shift+C with a selection to copy and without one to none", () => {
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "c", hasSelection: true })).toBe("copy");
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "C", hasSelection: true })).toBe("copy");
    // No selection: nothing to copy; the chord must not reach the remote shell either.
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "c", hasSelection: false })).toBe("none");
    // Plain Ctrl+Shift+C without the modifier is untouched.
    expect(resolveTerminalKeyAction({ mod: false, shiftKey: true, key: "c", hasSelection: true })).toBe("none");
  });

  it("routes select-all to Cmd+A on Apple platforms and Ctrl+Shift+A elsewhere", () => {
    // Apple: bare Cmd+A selects; Ctrl+Shift+A also matches (harmless superset).
    expect(isTerminalSelectAllShortcut({ mod: true, shiftKey: false, metaKey: true, key: "a", applePlatform: true })).toBe(true);
    expect(isTerminalSelectAllShortcut({ mod: true, shiftKey: true, metaKey: false, key: "a", applePlatform: true })).toBe(true);
    // Non-Apple: bare Ctrl+A must reach readline (line start), only +Shift selects.
    expect(isTerminalSelectAllShortcut({ mod: true, shiftKey: false, metaKey: false, key: "a", applePlatform: false })).toBe(false);
    expect(isTerminalSelectAllShortcut({ mod: true, shiftKey: true, metaKey: false, key: "a", applePlatform: false })).toBe(true);
    // Meta+A on non-Apple (Super+A) is left to the desktop, and other keys never match.
    expect(isTerminalSelectAllShortcut({ mod: true, shiftKey: false, metaKey: true, key: "a", applePlatform: false })).toBe(false);
    expect(isTerminalSelectAllShortcut({ mod: true, shiftKey: false, metaKey: true, key: "v", applePlatform: true })).toBe(false);
  });

describe("Apple platform detection", () => {
  it("detects Apple platforms from the user agent", () => {
    expect(isApplePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(true);
    expect(isApplePlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(isApplePlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });
});

describe("terminal search option persistence", () => {
  it("falls back to all-off defaults for missing or malformed storage", () => {
    expect(sanitizeSearchOptions(null)).toEqual({ caseSensitive: false, regex: false, wholeWord: false });
    expect(sanitizeSearchOptions("")).toEqual({ caseSensitive: false, regex: false, wholeWord: false });
    expect(sanitizeSearchOptions("not json {")).toEqual({ caseSensitive: false, regex: false, wholeWord: false });
    expect(sanitizeSearchOptions('{"caseSensitive":"yes"}')).toEqual({ caseSensitive: false, regex: false, wholeWord: false });
  });

  it("honors only strict true flags and drops unknown fields", () => {
    expect(sanitizeSearchOptions('{"caseSensitive":true,"wholeWord":true,"hacker":1}')).toEqual({ caseSensitive: true, regex: false, wholeWord: true });
    expect(sanitizeSearchOptions('{"regex":true}')).toEqual({ caseSensitive: false, regex: true, wholeWord: false });
  });
});

describe("terminal search seed from selection", () => {
  it("keeps the first line and clamps it to a bounded length", () => {
    expect(terminalSearchSeedFromSelection("")).toBe("");
    expect(terminalSearchSeedFromSelection("hello world")).toBe("hello world");
    expect(terminalSearchSeedFromSelection("first\r\nsecond")).toBe("first");
    expect(terminalSearchSeedFromSelection("first\nsecond\nthird")).toBe("first");
    expect(terminalSearchSeedFromSelection("a".repeat(500)).length).toBe(200);
  });
});

describe("terminal drop acceptance", () => {
  it("requires a connected, writable session with no file transfer protocol owning the stream", () => {
    expect(canAcceptTerminalDrop({ connected: true, canWrite: true, transferBusy: false, sftpPaneOpen: false })).toBe(true);
    expect(canAcceptTerminalDrop({ connected: false, canWrite: true, transferBusy: false, sftpPaneOpen: false })).toBe(false);
    expect(canAcceptTerminalDrop({ connected: true, canWrite: false, transferBusy: false, sftpPaneOpen: false })).toBe(false);
    expect(canAcceptTerminalDrop({ connected: true, canWrite: true, transferBusy: true, sftpPaneOpen: false })).toBe(false);
  });

  it("refuses terminal drops while the SFTP panel is open (the panel is the visible drop target)", () => {
    expect(canAcceptTerminalDrop({ connected: true, canWrite: true, transferBusy: false, sftpPaneOpen: true })).toBe(false);
  });
});

describe("shared file drop gate", () => {
  it("is the writable-session gate every drop channel shares, without the terminal-occupancy term", () => {
    expect(canAcceptFileDrop({ connected: true, canWrite: true })).toBe(true);
    expect(canAcceptFileDrop({ connected: false, canWrite: true })).toBe(false);
    expect(canAcceptFileDrop({ connected: true, canWrite: false })).toBe(false);
    // terminal gate degrades to the shared gate when nothing owns the stream
    expect(canAcceptTerminalDrop({ connected: true, canWrite: true, transferBusy: false, sftpPaneOpen: false })).toBe(canAcceptFileDrop({ connected: true, canWrite: true }));
  });
});

describe("terminal drop prompt target directory", () => {
  it("treats blank input as unusable so the confirm button stays disabled", () => {
    expect(normalizeDropTargetDir("")).toBeNull();
    expect(normalizeDropTargetDir("   ")).toBeNull();
    expect(normalizeDropTargetDir("\t / \n")).toBe("/");
  });

  it("collapses trailing slashes while keeping the bare root intact", () => {
    expect(normalizeDropTargetDir("/")).toBe("/");
    expect(normalizeDropTargetDir("//")).toBe("/");
    expect(normalizeDropTargetDir("/data/uploads/")).toBe("/data/uploads");
    expect(normalizeDropTargetDir("/data/uploads///")).toBe("/data/uploads");
  });

  it("keeps ordinary paths and inner slashes untouched", () => {
    expect(normalizeDropTargetDir("/var/log")).toBe("/var/log");
    expect(normalizeDropTargetDir("  /home/user/uploads  ")).toBe("/home/user/uploads");
  });
});

describe("terminal drop default target resolution", () => {
  it("uses the shell cwd tracked via OSC 7/633 whenever it is known", () => {
    expect(resolveDropTargetDir({ terminalCwd: "/home/u/work", sftpHome: "/home/u", fallback: "/var/data" })).toBe("/home/u/work");
    // Tracked cwd wins even when it differs from the remote home.
    expect(resolveDropTargetDir({ terminalCwd: "/tmp", sftpHome: "/home/u", fallback: "/" })).toBe("/tmp");
  });

  it("falls back to the remote home when the shell cwd was never reported", () => {
    // 面板关闭时 SFTP 目录不可见，未跟踪到 shell cwd（未发 OSC 7/633）就落主目录。
    expect(resolveDropTargetDir({ terminalCwd: undefined, sftpHome: "/home/u", fallback: "/var/data" })).toBe("/home/u");
    expect(resolveDropTargetDir({ terminalCwd: "", sftpHome: "/home/u", fallback: "/" })).toBe("/home/u");
  });

  it("keeps the caller's fallback when no better source exists (old sidecar, no home probe)", () => {
    expect(resolveDropTargetDir({ terminalCwd: undefined, sftpHome: undefined, fallback: "/var/data" })).toBe("/var/data");
    expect(resolveDropTargetDir({ terminalCwd: undefined, sftpHome: undefined, fallback: "/" })).toBe("/");
    expect(resolveDropTargetDir({ terminalCwd: "", sftpHome: "/", fallback: "/" })).toBe("/");
  });
});
});
