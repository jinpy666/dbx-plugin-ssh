// 跨表面终端外观同步纯逻辑：canonical 归一、字体解析、防自写回落状态机。
import { describe, expect, it } from "vitest";
import {
  canonicalAppearanceRaw,
  createAppearanceSyncModel,
  parseFontSync,
  type AppearanceSyncSnapshot,
} from "./appearanceSync";
import { defaultTerminalAppearanceState, type TerminalAppearanceState } from "./terminalAppearance";
import type { TerminalFontOverride } from "./terminalFont";

function snapshot(overrides: Partial<AppearanceSyncSnapshot> = {}): AppearanceSyncSnapshot {
  return { appearance: null, fontFamily: null, fontSize: null, ...overrides };
}

const FONT_A: TerminalFontOverride = { fontFamily: "'JetBrains Mono', monospace", fontSize: 14 };

describe("canonicalAppearanceRaw", () => {
  it("normalizes key order and clamped values into a stable string", () => {
    const reference = defaultTerminalAppearanceState();
    const reordered = JSON.stringify({
      customThemes: [],
      font: { size: null, family: null },
      customSchemes: [],
      settings: { ...reference.settings, lineHeight: 99 },
    });
    const expected = JSON.stringify({
      ...reference,
      settings: { ...reference.settings, lineHeight: 3 },
    });
    expect(canonicalAppearanceRaw(reordered)).toBe(expected);
  });

  it("returns null for missing or corrupt payloads", () => {
    expect(canonicalAppearanceRaw(null)).toBeNull();
    expect(canonicalAppearanceRaw(undefined)).toBeNull();
    expect(canonicalAppearanceRaw("not json")).toBeNull();
  });
});

describe("parseFontSync", () => {
  it("parses persisted values and normalizes blanks to follow-host nulls", () => {
    expect(parseFontSync("'Cascadia Mono', monospace", "13")).toEqual({ fontFamily: "'Cascadia Mono', monospace", fontSize: 13 });
    expect(parseFontSync("", "  ")).toEqual({ fontFamily: null, fontSize: null });
    expect(parseFontSync(null, "not-a-number")).toEqual({ fontFamily: null, fontSize: null });
  });

  it("clamps out-of-range sizes", () => {
    expect(parseFontSync(null, "999")!.fontSize).toBeLessThanOrEqual(40);
  });
});

describe("createAppearanceSyncModel", () => {
  function modelWith(appearanceState: TerminalAppearanceState, fontOverride: TerminalFontOverride = { fontFamily: null, fontSize: null }) {
    return createAppearanceSyncModel({ currentAppearance: () => appearanceState, currentFont: () => fontOverride });
  }

  it("adopts a remote appearance change and advances the confirmed value", () => {
    const current = defaultTerminalAppearanceState();
    const model = modelWith(current);
    const remote = JSON.stringify({
      ...current,
      settings: { ...current.settings, schemeSource: "custom", darkSchemeId: "dracula" },
    });
    const decision = model.tick(snapshot({ appearance: remote }));
    expect(decision.appearance?.settings.darkSchemeId).toBe("dracula");
    expect(decision.font).toBeNull();
    // 同一快照再读：已确认，不再采纳。
    expect(model.tick(snapshot({ appearance: remote })).appearance).toBeNull();
  });

  it("ignores corrupt payloads without advancing the confirmed value", () => {
    const current = defaultTerminalAppearanceState();
    const model = modelWith(current);
    expect(model.tick(snapshot({ appearance: "{broken" })).appearance).toBeNull();
    const remote = JSON.stringify({ ...current, settings: { ...current.settings, letterSpacing: 2 } });
    expect(model.tick(snapshot({ appearance: remote })).appearance?.settings.letterSpacing).toBe(2);
  });

  it("holds the gate while a local appearance write is unconfirmed, then releases", () => {
    const current = defaultTerminalAppearanceState();
    const model = modelWith(current);
    const localWrite = JSON.stringify({ ...current, settings: { ...current.settings, lineHeight: 1.4 } });
    // 模拟本端已改内存并写穿（桥尚未落地）：指纹取当前内存态。
    current.settings.lineHeight = 1.4;
    model.noteAppearanceWrite();
    // 桥仍回旧值：闸门不放，不采纳（防止改主题瞬间回落旧色）。
    expect(model.tick(snapshot({ appearance: JSON.stringify(defaultTerminalAppearanceState()) })).appearance).toBeNull();
    // 桥落地本端写入：解除闸门，且不重复采纳自己的写入。
    expect(model.tick(snapshot({ appearance: localWrite })).appearance).toBeNull();
    // 解除后远端新变化照常采纳。
    const remote2 = JSON.stringify({ ...current, settings: { ...current.settings, letterSpacing: 1 } });
    expect(model.tick(snapshot({ appearance: remote2 })).appearance?.settings.letterSpacing).toBe(1);
  });

  it("adopts font-only remote changes and reports unchanged appearance as null", () => {
    const current = defaultTerminalAppearanceState();
    const model = modelWith(current);
    const decision = model.tick(snapshot({ fontFamily: FONT_A.fontFamily, fontSize: String(FONT_A.fontSize) }));
    expect(decision.appearance).toBeNull();
    expect(decision.font).toEqual(FONT_A);
  });

  it("keeps the appearance gate from blocking font-only local zooms", () => {
    const appearanceState = defaultTerminalAppearanceState();
    let fontOverride: TerminalFontOverride = { fontFamily: null, fontSize: null };
    const model = createAppearanceSyncModel({ currentAppearance: () => appearanceState, currentFont: () => fontOverride });
    // 本端缩放：只写穿字体键（外观键内容不变），字体闸门进闸。
    fontOverride = { fontFamily: null, fontSize: 15 };
    model.noteFontWrite();
    // 桥仍回旧字号：字体闸门不放，不采纳。
    expect(model.tick(snapshot({ fontSize: "14" })).font).toBeNull();
    // 桥落地新字号：解除闸门，不重复采纳自己的写入。
    expect(model.tick(snapshot({ fontSize: "15" })).font).toBeNull();
    // 解除后远端再改字号照常采纳；外观键缺失也不影响字体采纳。
    expect(model.tick(snapshot({ fontSize: "16" })).font?.fontSize).toBe(16);
  });

  it("gates each key family independently so a font zoom never stalls appearance sync", () => {
    const current = defaultTerminalAppearanceState();
    const model = modelWith(current);
    // 外观写入在途（桥未落地），同时远端只改了字体：字体部分照常采纳。
    current.settings.letterSpacing = 2;
    model.noteAppearanceWrite();
    const decision = model.tick(snapshot({ fontFamily: FONT_A.fontFamily, fontSize: String(FONT_A.fontSize) }));
    expect(decision.appearance).toBeNull();
    expect(decision.font).toEqual(FONT_A);
    // 外观闸门仍不放：桥上的其它外观串不被采纳。
    const remote = JSON.stringify({ ...current, settings: { ...current.settings, letterSpacing: 1 } });
    expect(model.tick(snapshot({ appearance: remote })).appearance).toBeNull();
    // 桥落地本端写入（letterSpacing 2）解除闸门，随后远端新值恢复采纳。
    const localWrite = JSON.stringify(current);
    expect(model.tick(snapshot({ appearance: localWrite })).appearance).toBeNull();
    expect(model.tick(snapshot({ appearance: remote })).appearance?.settings.letterSpacing).toBe(1);
  });
});
