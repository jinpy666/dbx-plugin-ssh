// 终端行为偏好（对标 Tabby「Terminal」页）纯逻辑单测：默认值保持既有行为、
// 逐字段归一化/钳制、旧 select-copy 键迁移、右键四档解析、粘贴变换、存储容错。
// 存储统一注入假实现；默认存储（pluginStore）回环单列一节。
import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  BELL_MODES,
  LEGACY_SELECT_COPY_KEY,
  LINK_MODIFIERS,
  RIGHT_CLICK_MODES,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  TERMINAL_BEHAVIOR_DEFAULTS,
  TERMINAL_BEHAVIOR_KEY,
  WORD_SEPARATOR_MAX_LENGTH,
  behaviorEquals,
  isLinkModifierSatisfied,
  loadTerminalBehavior,
  persistTerminalBehavior,
  resolveRightClickBehavior,
  sanitizeTerminalBehavior,
  terminalBehaviorOptionPatch,
  transformPasteText,
  type TerminalBehaviorSettings,
} from "./terminalBehavior";

const settings = (patch: Partial<TerminalBehaviorSettings> = {}): TerminalBehaviorSettings => ({ ...TERMINAL_BEHAVIOR_DEFAULTS, ...patch });

describe("TERMINAL_BEHAVIOR_DEFAULTS", () => {
  it("逐字段复现加入设置项之前的既有行为", () => {
    // 这些值刻意与 Tabby 的出厂默认保持一致，或（有分歧处）保持本插件原行为。
    expect(TERMINAL_BEHAVIOR_DEFAULTS.scrollbackLines).toBe(25_000);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.rightClick).toBe("paste");
    expect(TERMINAL_BEHAVIOR_DEFAULTS.copyOnSelect).toBe(true);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.bracketedPaste).toBe(true);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.warnOnMultilinePaste).toBe(true);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.scrollOnInput).toBe(true);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.altIsMeta).toBe(false);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.linkModifier).toBe("none");
    expect(TERMINAL_BEHAVIOR_DEFAULTS.replaceNewlinesWithSpaces).toBe(false);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.trimWhitespaceOnPaste).toBe(false);
    expect(TERMINAL_BEHAVIOR_DEFAULTS.bell).toBe("off");
  });

  it("默认词分隔串与 Tabby/xterm 一致", () => {
    expect(TERMINAL_BEHAVIOR_DEFAULTS.wordSeparator).toBe(" ()[]{}\\'\"");
  });
});

describe("sanitizeTerminalBehavior", () => {
  it("非对象输入整体回落默认", () => {
    expect(sanitizeTerminalBehavior(undefined)).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
    expect(sanitizeTerminalBehavior(null)).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
    expect(sanitizeTerminalBehavior("nope")).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
    expect(sanitizeTerminalBehavior(42)).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
  });

  it("scrollback 钳制到 [min, max] 并取整", () => {
    expect(sanitizeTerminalBehavior({ scrollbackLines: 1_000 }).scrollbackLines).toBe(1_000);
    expect(sanitizeTerminalBehavior({ scrollbackLines: 1 }).scrollbackLines).toBe(SCROLLBACK_MIN);
    expect(sanitizeTerminalBehavior({ scrollbackLines: 10 ** 9 }).scrollbackLines).toBe(SCROLLBACK_MAX);
    expect(sanitizeTerminalBehavior({ scrollbackLines: 1_234.7 }).scrollbackLines).toBe(1_235);
    expect(sanitizeTerminalBehavior({ scrollbackLines: Number.NaN }).scrollbackLines).toBe(TERMINAL_BEHAVIOR_DEFAULTS.scrollbackLines);
  });

  it("枚举非法值逐项回落，不影响同批其它字段", () => {
    const result = sanitizeTerminalBehavior({ rightClick: "explode", bell: "loud", linkModifier: "hyper", scrollbackLines: 500 });
    expect(result.rightClick).toBe(TERMINAL_BEHAVIOR_DEFAULTS.rightClick);
    expect(result.bell).toBe(TERMINAL_BEHAVIOR_DEFAULTS.bell);
    expect(result.linkModifier).toBe(TERMINAL_BEHAVIOR_DEFAULTS.linkModifier);
    expect(result.scrollbackLines).toBe(500);
  });

  it("枚举合法值全部保留", () => {
    for (const mode of RIGHT_CLICK_MODES) expect(sanitizeTerminalBehavior({ rightClick: mode }).rightClick).toBe(mode);
    for (const bell of BELL_MODES) expect(sanitizeTerminalBehavior({ bell }).bell).toBe(bell);
    for (const modifier of LINK_MODIFIERS) expect(sanitizeTerminalBehavior({ linkModifier: modifier }).linkModifier).toBe(modifier);
  });

  it("布尔值只认显式布尔：显式 false 保留，非布尔回落默认", () => {
    const result = sanitizeTerminalBehavior({ copyOnSelect: false, bracketedPaste: false, warnOnMultilinePaste: "no", scrollOnInput: 0 });
    expect(result.copyOnSelect).toBe(false);
    expect(result.bracketedPaste).toBe(false);
    expect(result.warnOnMultilinePaste).toBe(true);
    expect(result.scrollOnInput).toBe(true);
  });

  it("词分隔串超长截断，非字符串回落默认", () => {
    const long = "x".repeat(200);
    expect(sanitizeTerminalBehavior({ wordSeparator: long }).wordSeparator).toHaveLength(WORD_SEPARATOR_MAX_LENGTH);
    expect(sanitizeTerminalBehavior({ wordSeparator: 7 }).wordSeparator).toBe(TERMINAL_BEHAVIOR_DEFAULTS.wordSeparator);
  });

  it("旧 select-copy 键仅在对象未携带该字段时生效", () => {
    expect(sanitizeTerminalBehavior({}, false).copyOnSelect).toBe(false);
    expect(sanitizeTerminalBehavior({}, true).copyOnSelect).toBe(true);
    // 对象自带值优先于旧键（迁移后不再被旧键覆盖）。
    expect(sanitizeTerminalBehavior({ copyOnSelect: false }, true).copyOnSelect).toBe(false);
    expect(sanitizeTerminalBehavior({ copyOnSelect: true }, false).copyOnSelect).toBe(true);
  });

  it("未传旧键时回落默认 true", () => {
    expect(sanitizeTerminalBehavior({}).copyOnSelect).toBe(true);
  });
});

describe("loadTerminalBehavior / persistTerminalBehavior", () => {
  it("读取已存设置", () => {
    const storage = { getItem: (key: string) => (key === TERMINAL_BEHAVIOR_KEY ? JSON.stringify({ bell: "audible", scrollbackLines: 800 }) : null) };
    const loaded = loadTerminalBehavior(storage);
    expect(loaded.bell).toBe("audible");
    expect(loaded.scrollbackLines).toBe(800);
  });

  it("仅存在旧键时完成静默迁移", () => {
    const storage = { getItem: (key: string) => (key === LEGACY_SELECT_COPY_KEY ? "false" : null) };
    expect(loadTerminalBehavior(storage).copyOnSelect).toBe(false);
  });

  it("键缺失 / JSON 损坏 / 存储抛错均回落默认且不抛", () => {
    expect(loadTerminalBehavior({ getItem: () => null })).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
    expect(loadTerminalBehavior({ getItem: () => "{" })).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
    expect(
      loadTerminalBehavior({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
  });

  it("写入主键并同步旧键（降级不丢选择即复制）", () => {
    const written = new Map<string, string>();
    persistTerminalBehavior(settings({ copyOnSelect: false }), { setItem: (key, value) => void written.set(key, value) });
    expect(JSON.parse(written.get(TERMINAL_BEHAVIOR_KEY) ?? "{}").copyOnSelect).toBe(false);
    expect(written.get(LEGACY_SELECT_COPY_KEY)).toBe("false");
  });

  it("存储抛错时静默（仅失去持久化）", () => {
    expect(() =>
      persistTerminalBehavior(TERMINAL_BEHAVIOR_DEFAULTS, {
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });
});

describe("默认存储走 pluginStore", () => {
  afterEach(() => {
    // 默认存储是共享单例（node 环境为内存档）：用后清键，避免污染后续用例。
    pluginStore.removeItem(TERMINAL_BEHAVIOR_KEY);
    pluginStore.removeItem(LEGACY_SELECT_COPY_KEY);
  });

  it("不注入 storage 时读写经 pluginStore 回环", () => {
    persistTerminalBehavior(settings({ bell: "audible", scrollbackLines: 800, copyOnSelect: false }));
    expect(JSON.parse(pluginStore.getItem(TERMINAL_BEHAVIOR_KEY) ?? "{}").scrollbackLines).toBe(800);
    // 旧 select-copy 镜像同样写入 store（键已在 PLUGIN_STORE_KEYS 声明）。
    expect(pluginStore.getItem(LEGACY_SELECT_COPY_KEY)).toBe("false");
    expect(loadTerminalBehavior()).toEqual(settings({ bell: "audible", scrollbackLines: 800, copyOnSelect: false }));
  });

  it("无持久化值时回默认（node/无桥环境下默认档为内存，不抛 SecurityError）", () => {
    expect(loadTerminalBehavior()).toEqual(TERMINAL_BEHAVIOR_DEFAULTS);
  });
});

describe("terminalBehaviorOptionPatch", () => {
  it("bracketedPaste 取反映射到 ignoreBracketedPasteMode", () => {
    expect(terminalBehaviorOptionPatch(settings({ bracketedPaste: true })).ignoreBracketedPasteMode).toBe(false);
    expect(terminalBehaviorOptionPatch(settings({ bracketedPaste: false })).ignoreBracketedPasteMode).toBe(true);
  });

  it("其余字段原样透传到 xterm 选项", () => {
    const patch = terminalBehaviorOptionPatch(settings({ scrollbackLines: 5_000, scrollOnInput: false, wordSeparator: "-_.", altIsMeta: true }));
    expect(patch).toEqual({ scrollback: 5_000, scrollOnUserInput: false, wordSeparator: "-_.", ignoreBracketedPasteMode: false, macOptionIsMeta: true });
  });

  it("默认设置产出与既有硬编码等价的选项", () => {
    expect(terminalBehaviorOptionPatch(TERMINAL_BEHAVIOR_DEFAULTS)).toEqual({
      scrollback: 25_000,
      scrollOnUserInput: true,
      wordSeparator: " ()[]{}\\'\"",
      ignoreBracketedPasteMode: false,
      macOptionIsMeta: false,
    });
  });
});

describe("resolveRightClickBehavior", () => {
  it("四种模式各自的动作", () => {
    expect(resolveRightClickBehavior(settings({ rightClick: "off" }), { hasSelection: false, shiftKey: false })).toBe("off");
    expect(resolveRightClickBehavior(settings({ rightClick: "menu" }), { hasSelection: false, shiftKey: false })).toBe("menu");
    expect(resolveRightClickBehavior(settings({ rightClick: "paste" }), { hasSelection: false, shiftKey: false })).toBe("paste");
  });

  it("clipboard 模式按有无选区在粘贴/复制间切换", () => {
    const clipboard = settings({ rightClick: "clipboard" });
    expect(resolveRightClickBehavior(clipboard, { hasSelection: true, shiftKey: false })).toBe("copy");
    expect(resolveRightClickBehavior(clipboard, { hasSelection: false, shiftKey: false })).toBe("paste");
  });

  it("Shift+右键在每种模式下都可达上下文菜单（既有逃生舱）", () => {
    for (const mode of RIGHT_CLICK_MODES) {
      expect(resolveRightClickBehavior(settings({ rightClick: mode }), { hasSelection: true, shiftKey: true })).toBe("menu");
    }
  });

  it("默认设置下右键仍是粘贴（保持既有默认观感）", () => {
    expect(resolveRightClickBehavior(TERMINAL_BEHAVIOR_DEFAULTS, { hasSelection: true, shiftKey: false })).toBe("paste");
  });
});

describe("transformPasteText", () => {
  it("默认不改动文本", () => {
    expect(transformPasteText("  ls -la\n", TERMINAL_BEHAVIOR_DEFAULTS)).toBe("  ls -la\n");
  });

  it("裁剪模式去掉首尾空白与换行", () => {
    expect(transformPasteText("\n  ls -la  \n", settings({ trimWhitespaceOnPaste: true }))).toBe("ls -la");
  });

  it("换行替换模式把 CRLF/CR/LF 统一压成空格", () => {
    expect(transformPasteText("a\r\nb\rc\nd", settings({ replaceNewlinesWithSpaces: true }))).toBe("a b c d");
  });

  it("两项同时开启时先裁剪再替换（不留首尾多余空格）", () => {
    expect(transformPasteText("\n a\nb \n", settings({ trimWhitespaceOnPaste: true, replaceNewlinesWithSpaces: true }))).toBe("a b");
  });
});

describe("isLinkModifierSatisfied", () => {
  const event = (patch: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...patch,
  });

  it("none 表示链接始终可点（既有行为）", () => {
    expect(isLinkModifierSatisfied(settings({ linkModifier: "none" }), event())).toBe(true);
    expect(isLinkModifierSatisfied(TERMINAL_BEHAVIOR_DEFAULTS, event())).toBe(true);
  });

  it("指定修饰键后必须按住该键", () => {
    expect(isLinkModifierSatisfied(settings({ linkModifier: "ctrl" }), event({ ctrlKey: true }))).toBe(true);
    expect(isLinkModifierSatisfied(settings({ linkModifier: "ctrl" }), event())).toBe(false);
    expect(isLinkModifierSatisfied(settings({ linkModifier: "alt" }), event({ altKey: true }))).toBe(true);
    expect(isLinkModifierSatisfied(settings({ linkModifier: "shift" }), event({ shiftKey: true }))).toBe(true);
    expect(isLinkModifierSatisfied(settings({ linkModifier: "meta" }), event({ metaKey: true }))).toBe(true);
    // 其它修饰键不误命中。
    expect(isLinkModifierSatisfied(settings({ linkModifier: "ctrl" }), event({ metaKey: true }))).toBe(false);
  });
});

describe("behaviorEquals", () => {
  it("同值相等，任一字段不同即不等", () => {
    expect(behaviorEquals(TERMINAL_BEHAVIOR_DEFAULTS, settings())).toBe(true);
    expect(behaviorEquals(TERMINAL_BEHAVIOR_DEFAULTS, settings({ bell: "visual" }))).toBe(false);
    expect(behaviorEquals(TERMINAL_BEHAVIOR_DEFAULTS, settings({ copyOnSelect: false }))).toBe(false);
  });
});
