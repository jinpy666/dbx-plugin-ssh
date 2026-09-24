// 终端外观偏好纯逻辑单测：设置归一化、持久化容错、亮暗槽位解析、底色来源
// 策略、xterm 选项补丁、内边距变量与主题命中判定。存储统一注入假实现；
// 默认存储（pluginStore）回环单列一节。
import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  CUSTOM_SCHEME_LIMIT,
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  TERMINAL_APPEARANCE_KEY,
  TERMINAL_APPEARANCE_PRESETS,
  TERMINAL_OPTION_DEFAULTS,
  activeProfileId,
  allAppearanceProfiles,
  applySchemeToTerminalTheme,
  defaultTerminalAppearanceState,
  findScheme,
  loadTerminalAppearance,
  persistTerminalAppearance,
  resolveActiveScheme,
  sanitizeAppearanceSettings,
  sanitizeCustomScheme,
  sanitizeTerminalAppearanceState,
  terminalOptionPatch,
  terminalPaddingVars,
  type TerminalAppearanceState,
} from "./terminalAppearance";
import { ANSI_COLOR_NAMES, builtinSchemeById, type TerminalColorScheme } from "./terminalScheme";

function memoryStorage(seed?: Record<string, string>) {
  const store = new Map(Object.entries(seed ?? {}));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    dump: () => Object.fromEntries(store),
  };
}

// 默认存储是共享单例（node 环境为内存档）：默认存储用例写键后清理。
afterEach(() => {
  pluginStore.removeItem(TERMINAL_APPEARANCE_KEY);
});

const CUSTOM_SCHEME: TerminalColorScheme = {
  id: "my-scheme",
  name: "My Scheme",
  foreground: "#eeeeee",
  background: "#111111",
  cursor: "#ff0000",
  colors: ANSI_COLOR_NAMES.map((_, index) => `#00000${index.toString(16)}`),
  selectionBackground: "#333333",
  source: "custom",
};

function stateWith(settings: Partial<TerminalAppearanceState["settings"]>, schemes: TerminalColorScheme[] = []): TerminalAppearanceState {
  return {
    settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS, ...settings },
    font: { family: null, size: null },
    customSchemes: schemes,
    customThemes: [],
  };
}

describe("设置归一化", () => {
  it("越界数值钳制到合法区间，整数项取整", () => {
    const settings = sanitizeAppearanceSettings({
      fontWeight: 2000,
      fontWeightBold: 50,
      lineHeight: 9,
      letterSpacing: -40,
      paddingX: 999,
      paddingY: -3,
      minimumContrastRatio: 99,
    });
    expect(settings.fontWeight).toBe(900);
    expect(settings.fontWeightBold).toBe(100);
    expect(settings.lineHeight).toBe(3);
    expect(settings.letterSpacing).toBe(-5);
    expect(settings.paddingX).toBe(32);
    expect(settings.paddingY).toBe(0);
    expect(settings.minimumContrastRatio).toBe(21);
  });

  it("非法枚举与缺省回默认（默认路径与既有行为一致）", () => {
    const settings = sanitizeAppearanceSettings({ schemeSource: "weird", cursorStyle: "fish", cursorInactiveStyle: "nope" });
    expect(settings.schemeSource).toBe("host");
    expect(settings.cursorStyle).toBe("bar");
    expect(settings.cursorInactiveStyle).toBe("outline");
    // 未设置的行高/字间距保持 null = xterm 既有默认（1.15 / 0）。
    expect(settings.lineHeight).toBeNull();
    expect(settings.letterSpacing).toBeNull();
    expect(settings.cursorBlink).toBe(true);
    expect(settings.drawBoldTextInBrightColors).toBe(true);
  });

  it("布尔项显式 false 时保留 false（不是回默认 true）", () => {
    const settings = sanitizeAppearanceSettings({ cursorBlink: false, drawBoldTextInBrightColors: false });
    expect(settings.cursorBlink).toBe(false);
    expect(settings.drawBoldTextInBrightColors).toBe(false);
  });

  it("空白字符串槽位归一为 null", () => {
    const settings = sanitizeAppearanceSettings({ darkSchemeId: "   ", lightSchemeId: "nord" });
    expect(settings.darkSchemeId).toBeNull();
    expect(settings.lightSchemeId).toBe("nord");
  });
});

describe("自定义方案归一化", () => {
  it("合法方案保留 id 与色值", () => {
    const scheme = sanitizeCustomScheme(CUSTOM_SCHEME, []);
    expect(scheme).toEqual(CUSTOM_SCHEME);
  });

  it("缺 id 时按名称生成并避让既有 id", () => {
    const scheme = sanitizeCustomScheme({ ...CUSTOM_SCHEME, id: undefined }, ["my-scheme"]);
    expect(scheme?.id).toBe("my-scheme-2");
  });

  it("色值缺失/色数不足/非法 hex 一律拒绝", () => {
    expect(sanitizeCustomScheme({ ...CUSTOM_SCHEME, foreground: "red" }, [])).toBeNull();
    expect(sanitizeCustomScheme({ ...CUSTOM_SCHEME, colors: ["#000000"] }, [])).toBeNull();
    expect(sanitizeCustomScheme({ ...CUSTOM_SCHEME, colors: [...CUSTOM_SCHEME.colors.slice(0, 15), "nope"] }, [])).toBeNull();
    expect(sanitizeCustomScheme(null, [])).toBeNull();
  });
});

describe("状态持久化", () => {
  it("缺键返回默认态", () => {
    const state = loadTerminalAppearance(memoryStorage());
    expect(state).toEqual(defaultTerminalAppearanceState());
    expect(state.settings.schemeSource).toBe("host");
  });

  it("JSON 损坏时回默认而不抛错", () => {
    expect(loadTerminalAppearance(memoryStorage({ [TERMINAL_APPEARANCE_KEY]: "{not json" })))
      .toEqual(defaultTerminalAppearanceState());
  });

  it("存储不可用时读回默认、写入静默失败", () => {
    const throwing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => undefined,
    };
    expect(loadTerminalAppearance(throwing)).toEqual(defaultTerminalAppearanceState());
    expect(() => persistTerminalAppearance(defaultTerminalAppearanceState(), throwing)).not.toThrow();
  });

  it("写入后可原样读回（含自定义方案与主题）", () => {
    const storage = memoryStorage();
    const state: TerminalAppearanceState = {
      settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS, schemeSource: "custom", darkSchemeId: "dracula", lineHeight: 1.4 },
      font: { family: "'Fira Code', monospace", size: 15 },
      customSchemes: [CUSTOM_SCHEME],
      customThemes: [{
        id: "my-theme", name: "My Theme", builtin: false,
        settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS, schemeSource: "custom", darkSchemeId: "nord" },
        font: { family: null, size: 14 },
      }],
    };
    persistTerminalAppearance(state, storage);
    expect(loadTerminalAppearance(storage)).toEqual(state);
  });

  it("不注入 storage 时读写经默认 pluginStore 回环", () => {
    const state = stateWith({ schemeSource: "custom", darkSchemeId: "dracula", lineHeight: 1.4 }, [CUSTOM_SCHEME]);
    persistTerminalAppearance(state);
    expect(pluginStore.getItem(TERMINAL_APPEARANCE_KEY)).not.toBeNull();
    expect(loadTerminalAppearance()).toEqual(state);
  });

  it("自定义方案数量超限时截断", () => {
    const many = Array.from({ length: CUSTOM_SCHEME_LIMIT + 10 }, (_, index) => ({ ...CUSTOM_SCHEME, id: `scheme-${index}` }));
    const state = sanitizeTerminalAppearanceState({ customSchemes: many });
    expect(state.customSchemes).toHaveLength(CUSTOM_SCHEME_LIMIT);
  });
});

describe("方案槽位解析", () => {
  it("schemeSource=host 时不启用方案（默认路径零行为变化）", () => {
    const state = stateWith({ schemeSource: "host", darkSchemeId: "dracula" });
    expect(resolveActiveScheme(state.settings, state.customSchemes, "dark")).toBeNull();
  });

  it("按宿主亮暗选择对应槽位，槽位为空则不启用", () => {
    const state = stateWith({ schemeSource: "custom", darkSchemeId: "dracula", lightSchemeId: "solarized-light" });
    expect(resolveActiveScheme(state.settings, state.customSchemes, "dark")?.id).toBe("dracula");
    expect(resolveActiveScheme(state.settings, state.customSchemes, "light")?.id).toBe("solarized-light");
    const onlyDark = stateWith({ schemeSource: "custom", darkSchemeId: "dracula" });
    expect(resolveActiveScheme(onlyDark.settings, onlyDark.customSchemes, "light")).toBeNull();
  });

  it("自定义方案优先于同名内置 id，未知 id 返回 null", () => {
    const custom = { ...CUSTOM_SCHEME, id: "dracula" };
    expect(findScheme([custom], "dracula")).toBe(custom);
    expect(findScheme([], "dracula")?.name).toBe("Dracula");
    expect(findScheme([], "no-such-scheme")).toBeNull();
    expect(findScheme([], null)).toBeNull();
  });
});

describe("主题合成", () => {
  const base = {
    background: "#131416",
    foreground: "#d7d7db",
    cursor: "#d7d7db",
    cursorAccent: "#131416",
    selectionBackground: "#5f6f8a88",
    black: "#1f2937",
  };

  it("未启用方案时原样返回宿主主题", () => {
    const state = stateWith({});
    expect(applySchemeToTerminalTheme(base, state.settings, state.customSchemes, "dark")).toBe(base);
  });

  it("backgroundSource=scheme 时前景/背景/光标全部取自方案", () => {
    const state = stateWith({ schemeSource: "custom", darkSchemeId: "dracula", backgroundSource: "scheme" });
    const theme = applySchemeToTerminalTheme(base, state.settings, state.customSchemes, "dark");
    expect(theme.background).toBe("#1e1f29");
    expect(theme.foreground).toBe("#f8f8f2");
    expect(theme.cursor).toBe("#bbbbbb");
    expect(theme.black).toBe("#000000");
  });

  it("backgroundSource=host 时保留宿主底色但 ANSI 取自方案（Tabby 的 theme 语义）", () => {
    const state = stateWith({ schemeSource: "custom", darkSchemeId: "dracula", backgroundSource: "host" });
    const theme = applySchemeToTerminalTheme(base, state.settings, state.customSchemes, "dark");
    expect(theme.background).toBe(base.background);
    expect(theme.foreground).toBe(base.foreground);
    expect(theme.cursorAccent).toBe(base.background);
    expect(theme.black).toBe("#000000");
    expect(theme.red).toBe("#ff5555");
  });
});

describe("xterm 选项补丁与内边距", () => {
  it("未设置时落回既有默认（1.15 行高 / bar 光标 / 0 字间距）", () => {
    expect(terminalOptionPatch(DEFAULT_TERMINAL_APPEARANCE_SETTINGS)).toEqual(TERMINAL_OPTION_DEFAULTS);
  });

  it("设置生效并保持数值型字重", () => {
    const patch = terminalOptionPatch({
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      fontWeight: 500,
      lineHeight: 1.4,
      letterSpacing: 1,
      cursorStyle: "block",
      cursorBlink: false,
      minimumContrastRatio: 4.5,
    });
    expect(patch.fontWeight).toBe(500);
    expect(patch.lineHeight).toBe(1.4);
    expect(patch.letterSpacing).toBe(1);
    expect(patch.cursorStyle).toBe("block");
    expect(patch.cursorBlink).toBe(false);
    expect(patch.minimumContrastRatio).toBe(4.5);
  });

  it("内边距变量：未设置时不写变量（回落 style.css 内置值）", () => {
    expect(terminalPaddingVars(DEFAULT_TERMINAL_APPEARANCE_SETTINGS))
      .toEqual({ left: null, right: null, top: null, bottom: null });
  });

  it("内边距变量：只改一边时另一边保持内置默认", () => {
    expect(terminalPaddingVars({ ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS, paddingX: 16 }))
      .toEqual({ left: "16px", right: "16px", top: "5px", bottom: "8px" });
    expect(terminalPaddingVars({ ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS, paddingY: 12 }))
      .toEqual({ left: "10px", right: "0px", top: "12px", bottom: "12px" });
  });
});

describe("主题命中判定", () => {
  it("默认配置命中「跟随 DBX 宿主」预设", () => {
    const state = defaultTerminalAppearanceState();
    expect(activeProfileId(state)).toBe("preset-host");
  });

  it("套用预设后命中该预设，改动任一字段即失配", () => {
    const dracula = TERMINAL_APPEARANCE_PRESETS.find((preset) => preset.id === "preset-dracula")!;
    const state: TerminalAppearanceState = {
      ...defaultTerminalAppearanceState(),
      settings: { ...dracula.settings },
      font: { ...dracula.font },
    };
    expect(activeProfileId(state)).toBe("preset-dracula");
    expect(activeProfileId({ ...state, settings: { ...state.settings, lineHeight: 1.9 } })).toBeNull();
    expect(activeProfileId({ ...state, font: { ...state.font, size: 22 } })).toBeNull();
  });

  it("预设引用的内置方案都存在（防止目录演进后悬空）", () => {
    for (const preset of TERMINAL_APPEARANCE_PRESETS) {
      for (const id of [preset.settings.darkSchemeId, preset.settings.lightSchemeId]) {
        if (id) expect(builtinSchemeById(id), `${preset.id} references missing scheme ${id}`).toBeDefined();
      }
    }
  });

  it("用户主题追加在预设之后（同名不合并）", () => {
    const state: TerminalAppearanceState = {
      ...defaultTerminalAppearanceState(),
      customThemes: [{ id: "mine", name: "presetHost", builtin: false, settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS }, font: { family: null, size: null } }],
    };
    const profiles = allAppearanceProfiles(state);
    expect(profiles.map((profile) => profile.id)).toEqual([...TERMINAL_APPEARANCE_PRESETS.map((preset) => preset.id), "mine"]);
  });
});
