import { describe, expect, it } from "vitest";
import { canAcceptTerminalDrop, normalizeDropTargetDir, resolveTerminalKeyAction, resolveTerminalRightClickAction, sanitizeSearchOptions, sanitizeSelectCopyEnabled, terminalSearchSeedFromSelection } from "./terminalInteraction";

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

describe("terminal keyboard shortcuts (copy/paste routing)", () => {
  it("routes Ctrl/Cmd+Shift+C with a selection to copy and without one to none", () => {
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "c", hasSelection: true })).toBe("copy");
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "C", hasSelection: true })).toBe("copy");
    // No selection: nothing to copy; the chord must not reach the remote shell either.
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "c", hasSelection: false })).toBe("none");
    // Plain Ctrl+Shift+C without the modifier is untouched.
    expect(resolveTerminalKeyAction({ mod: false, shiftKey: true, key: "c", hasSelection: true })).toBe("none");
  });

  it("routes plain Ctrl/Cmd+C with a selection to copy (Windows Terminal / iTerm2 semantics)", () => {
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: false, key: "c", hasSelection: true })).toBe("copy");
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: false, key: "C", hasSelection: true })).toBe("copy");
  });

  it("keeps plain Ctrl/Cmd+C without a selection as shell input (SIGINT)", () => {
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: false, key: "c", hasSelection: false })).toBe("none");
  });

  it("routes both Ctrl+V and Ctrl/Cmd+Shift+V to paste", () => {
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: false, key: "v", hasSelection: false })).toBe("paste");
    expect(resolveTerminalKeyAction({ mod: true, shiftKey: true, key: "V", hasSelection: false })).toBe("paste");
    expect(resolveTerminalKeyAction({ mod: false, shiftKey: true, key: "v", hasSelection: false })).toBe("none");
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
    expect(canAcceptTerminalDrop({ connected: true, canWrite: true, transferBusy: false })).toBe(true);
    expect(canAcceptTerminalDrop({ connected: false, canWrite: true, transferBusy: false })).toBe(false);
    expect(canAcceptTerminalDrop({ connected: true, canWrite: false, transferBusy: false })).toBe(false);
    expect(canAcceptTerminalDrop({ connected: true, canWrite: true, transferBusy: true })).toBe(false);
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
