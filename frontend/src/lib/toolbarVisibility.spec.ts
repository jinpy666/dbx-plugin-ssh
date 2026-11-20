// 工具栏按钮可配置隐藏（issue #309）：单键 JSON 存 pluginStore，模式照抄
// aiSettings.ts。默认全显示（与现状零差异）；未知 id 丢弃；非法/损坏值逐项
// 回退为显示。
import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  TOOLBAR_BUTTONS,
  TOOLBAR_HIDDEN_DEFAULTS,
  TOOLBAR_VISIBILITY_STORE_KEY,
  isToolbarButtonVisible,
  loadToolbarVisibility,
  sanitizeToolbarVisibility,
} from "./toolbarVisibility";

describe("TOOLBAR_BUTTONS", () => {
  it("每项都有 id 与复用的既有 i18n labelKey，id 唯一", () => {
    const ids = TOOLBAR_BUTTONS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of TOOLBAR_BUTTONS) {
      expect(typeof b.id).toBe("string");
      expect(b.labelKey.length).toBeGreaterThan(0);
    }
  });
});

describe("sanitizeToolbarVisibility", () => {
  it("缺省回默认：全部显示", () => {
    expect(sanitizeToolbarVisibility(undefined)).toEqual(TOOLBAR_HIDDEN_DEFAULTS);
    expect(sanitizeToolbarVisibility({})).toEqual(TOOLBAR_HIDDEN_DEFAULTS);
  });

  it("显式 false 保留，true/非法值回显示；未知 id 丢弃", () => {
    const input = { [TOOLBAR_BUTTONS[0].id]: false, recording: false, settings: false };
    const output = sanitizeToolbarVisibility(input);
    expect(output[TOOLBAR_BUTTONS[0].id]).toBe(false);
    // recording 是合法 id：false 保留。
    expect(output.recording).toBe(false);
    // 未知 id 不进结果对象。
    expect(Object.keys(output).sort()).toEqual(Object.keys(TOOLBAR_HIDDEN_DEFAULTS).sort());
  });

  it("非对象输入回默认", () => {
    expect(sanitizeToolbarVisibility("junk")).toEqual(TOOLBAR_HIDDEN_DEFAULTS);
    expect(sanitizeToolbarVisibility(null)).toEqual(TOOLBAR_HIDDEN_DEFAULTS);
  });
});

describe("loadToolbarVisibility", () => {
  afterEach(() => {
    pluginStore.removeItem(TOOLBAR_VISIBILITY_STORE_KEY);
  });

  it("空档回默认；合法档读回隐藏项", () => {
    expect(loadToolbarVisibility()).toEqual(TOOLBAR_HIDDEN_DEFAULTS);
    pluginStore.setItem(TOOLBAR_VISIBILITY_STORE_KEY, JSON.stringify({ recording: false }));
    expect(loadToolbarVisibility().recording).toBe(false);
  });

  it("损坏 JSON 不抛、回默认", () => {
    pluginStore.setItem(TOOLBAR_VISIBILITY_STORE_KEY, "{broken");
    expect(loadToolbarVisibility()).toEqual(TOOLBAR_HIDDEN_DEFAULTS);
  });
});

describe("isToolbarButtonVisible", () => {
  it("未登记的 id 视为显示（常显按钮不进清单）", () => {
    expect(isToolbarButtonVisible({}, "settings")).toBe(true);
    expect(isToolbarButtonVisible({ recording: false }, "recording")).toBe(false);
    expect(isToolbarButtonVisible({ recording: true }, "recording")).toBe(true);
  });
});
