// 快捷键注册表纯逻辑单测：平台默认键位、code 归一化（大小写/标点/Shift 可分辨）、
// 组合串解析与规范化、显示格式化、持久化容错、匹配与冲突检测。
// 存储统一注入假实现；默认存储（pluginStore）回环单列一节。
import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  ACTION_IDS,
  TERMINAL_HOTKEYS_KEY,
  TERMINAL_HOTKEY_ACTIONS,
  actionById,
  combosUsedByOthers,
  defaultTerminalHotkeys,
  findHotkeyConflicts,
  formatHotkeyDisplay,
  hotkeysEqual,
  keyComboFromEvent,
  keyTokenFromCode,
  loadTerminalHotkeys,
  matchTerminalHotkey,
  persistTerminalHotkeys,
  sanitizeKeyCombo,
  sanitizeTerminalHotkeys,
  type TerminalHotkeyBindings,
} from "./terminalHotkeys";

const event = (code: string, patch: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe("TERMINAL_HOTKEY_ACTIONS", () => {
  it("动作 id 唯一且每个动作都有两种平台默认键位", () => {
    const ids = TERMINAL_HOTKEY_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of TERMINAL_HOTKEY_ACTIONS) {
      expect(action.apple.length).toBeGreaterThan(0);
      expect(action.other.length).toBeGreaterThan(0);
      expect(action.labelKey.startsWith("terminalHotkeys.")).toBe(true);
    }
  });

  it("默认键位自身不含冲突（Apple 与非 Apple 分别校验）", () => {
    expect(findHotkeyConflicts(defaultTerminalHotkeys(true))).toEqual([]);
    expect(findHotkeyConflicts(defaultTerminalHotkeys(false))).toEqual([]);
  });

  it("不占用会干扰远端 shell 的裸键位（Ctrl+A / Ctrl+C / Ctrl+F 均未绑定）", () => {
    const other = defaultTerminalHotkeys(false);
    const bound = Object.values(other).flat();
    // Ctrl+C 必须留给 SIGINT，Ctrl+A 留给 readline 行首，Ctrl+F 留给 readline 前进。
    expect(bound).not.toContain("Ctrl+C");
    expect(bound).not.toContain("Ctrl+A");
    expect(bound).not.toContain("Ctrl+F");
    expect(other["copy"]).toEqual(["Ctrl+Shift+C"]);
    expect(other["paste"]).toEqual(["Ctrl+V", "Ctrl+Shift+V"]);
  });

  it("macOS 复制/粘贴走 ⌘ 系，把 Ctrl+C 完整交还远端", () => {
    const apple = defaultTerminalHotkeys(true);
    expect(apple["copy"]).toEqual(["Meta+C"]);
    expect(apple["paste"]).toEqual(["Meta+V"]);
    expect(Object.values(apple).flat()).not.toContain("Ctrl+C");
  });

  it("actionById 命中已知动作、未知返回 undefined", () => {
    expect(actionById("search")?.id).toBe("search");
    expect(actionById("nope")).toBeUndefined();
  });
});

describe("keyTokenFromCode", () => {
  it("字母 / 数字 / 功能键 / 小键盘映射为显示记号", () => {
    expect(keyTokenFromCode("KeyA")).toBe("A");
    expect(keyTokenFromCode("Digit0")).toBe("0");
    expect(keyTokenFromCode("F5")).toBe("F5");
    expect(keyTokenFromCode("Numpad3")).toBe("Num3");
  });

  it("标点映射为字面符号（Shift 改写不影响 code）", () => {
    expect(keyTokenFromCode("Equal")).toBe("=");
    expect(keyTokenFromCode("Minus")).toBe("-");
    expect(keyTokenFromCode("PageUp")).toBe("PageUp");
    expect(keyTokenFromCode("ArrowUp")).toBe("Up");
  });

  it("纯修饰键与未知 code 返回 null（不可作为绑定）", () => {
    expect(keyTokenFromCode("ControlLeft")).toBeNull();
    expect(keyTokenFromCode("MetaRight")).toBeNull();
    expect(keyTokenFromCode("ShiftLeft")).toBeNull();
    expect(keyTokenFromCode("AltRight")).toBeNull();
    expect(keyTokenFromCode("")).toBeNull();
    expect(keyTokenFromCode("LaunchMail")).toBeNull();
  });
});

describe("keyComboFromEvent", () => {
  it("修饰键固定按 Meta/Ctrl/Alt/Shift 顺序规范输出", () => {
    expect(keyComboFromEvent(event("KeyF", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+F");
    expect(keyComboFromEvent(event("KeyF", { shiftKey: true, ctrlKey: true, metaKey: true, altKey: true }))).toBe("Meta+Ctrl+Alt+Shift+F");
  });

  it("是否按住 Shift 产生不同组合（Ctrl+A 与 Ctrl+Shift+A 可分辨）", () => {
    expect(keyComboFromEvent(event("KeyA", { ctrlKey: true }))).toBe("Ctrl+A");
    expect(keyComboFromEvent(event("KeyA", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+A");
  });

  it("等号键带 Shift 时仍是 Ctrl+Shift+=（不塌成 '+'）", () => {
    expect(keyComboFromEvent(event("Equal", { ctrlKey: true }))).toBe("Ctrl+=");
    expect(keyComboFromEvent(event("Equal", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+=");
  });

  it("纯修饰键按下不产生组合", () => {
    expect(keyComboFromEvent(event("ControlLeft", { ctrlKey: true }))).toBeNull();
  });
});

describe("sanitizeKeyCombo", () => {
  it("别名与大小写归一为规范形态", () => {
    expect(sanitizeKeyCombo("ctrl+shift+f")).toBe("Ctrl+Shift+F");
    expect(sanitizeKeyCombo("Cmd+V")).toBe("Meta+V");
    expect(sanitizeKeyCombo("⌘+⇧+F")).toBe("Meta+Shift+F");
    expect(sanitizeKeyCombo("Alt+PageUp")).toBe("Alt+PageUp");
    expect(sanitizeKeyCombo("Ctrl+keyf")).toBe("Ctrl+F");
    expect(sanitizeKeyCombo("Ctrl+digit0")).toBe("Ctrl+0");
  });

  it("乱序输入重排为标准顺序", () => {
    expect(sanitizeKeyCombo("Shift+Ctrl+F")).toBe("Ctrl+Shift+F");
  });

  it("重复修饰键去重", () => {
    expect(sanitizeKeyCombo("Ctrl+Ctrl+F")).toBe("Ctrl+F");
  });

  it("缺少修饰键的裸键被拒绝（否则会吞掉正常输入）", () => {
    expect(sanitizeKeyCombo("F")).toBeNull();
    expect(sanitizeKeyCombo("A")).toBeNull();
    expect(sanitizeKeyCombo("PageUp")).toBeNull();
  });

  it("非法输入与双主键被拒绝", () => {
    expect(sanitizeKeyCombo(null)).toBeNull();
    expect(sanitizeKeyCombo("")).toBeNull();
    expect(sanitizeKeyCombo("   ")).toBeNull();
    expect(sanitizeKeyCombo("Ctrl+")).toBeNull();
    expect(sanitizeKeyCombo("Ctrl+Banana")).toBeNull();
    expect(sanitizeKeyCombo("Ctrl+F+G")).toBeNull();
    expect(sanitizeKeyCombo(42)).toBeNull();
  });
});

describe("formatHotkeyDisplay", () => {
  it("Apple 平台用符号拼接", () => {
    expect(formatHotkeyDisplay("Meta+Shift+F", true)).toBe("⌘⇧F");
    expect(formatHotkeyDisplay("Ctrl+Alt+=", true)).toBe("⌃⌥=");
  });

  it("其它平台保留 + 连接的可读形态", () => {
    expect(formatHotkeyDisplay("Ctrl+Shift+F", false)).toBe("Ctrl+Shift+F");
    expect(formatHotkeyDisplay("Shift+PageUp", false)).toBe("Shift+PageUp");
  });
});

describe("sanitizeTerminalHotkeys", () => {
  it("未知动作被丢弃", () => {
    const result = sanitizeTerminalHotkeys({ "not-an-action": ["Ctrl+Q"] }, true);
    expect(Object.keys(result)).toEqual([...ACTION_IDS]);
    expect((result as Record<string, unknown>)["not-an-action"]).toBeUndefined();
  });

  it("动作内非法组合被丢弃，合法项保留", () => {
    const result = sanitizeTerminalHotkeys({ search: ["Ctrl+F", "garbage", "F"] }, true);
    expect(result.search).toEqual(["Ctrl+F"]);
  });

  it("数组内重复组合去重", () => {
    expect(sanitizeTerminalHotkeys({ search: ["Ctrl+F", "ctrl+f"] }, true).search).toEqual(["Ctrl+F"]);
  });

  it("显式空数组表示解绑，不会回填默认", () => {
    expect(sanitizeTerminalHotkeys({ search: [] }, true).search).toEqual([]);
  });

  it("字段缺失或类型错误时回填平台默认", () => {
    expect(sanitizeTerminalHotkeys({}, true).search).toEqual(["Meta+F"]);
    expect(sanitizeTerminalHotkeys({ search: "Ctrl+F" }, true).search).toEqual(["Meta+F"]);
    expect(sanitizeTerminalHotkeys(undefined, false).copy).toEqual(["Ctrl+Shift+C"]);
  });
});

describe("loadTerminalHotkeys / persistTerminalHotkeys", () => {
  it("读取已存键位并规范化", () => {
    const storage = { getItem: (key: string) => (key === TERMINAL_HOTKEYS_KEY ? JSON.stringify({ clear: ["ctrl+shift+k"] }) : null) };
    expect(loadTerminalHotkeys(false, storage).clear).toEqual(["Ctrl+Shift+K"]);
  });

  it("键缺失 / JSON 损坏 / 存储抛错均回落平台默认且不抛", () => {
    expect(loadTerminalHotkeys(true, { getItem: () => null })).toEqual(defaultTerminalHotkeys(true));
    expect(loadTerminalHotkeys(true, { getItem: () => "{" })).toEqual(defaultTerminalHotkeys(true));
    expect(
      loadTerminalHotkeys(true, {
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toEqual(defaultTerminalHotkeys(true));
  });

  it("写入 JSON；存储抛错时静默", () => {
    const written = new Map<string, string>();
    persistTerminalHotkeys(defaultTerminalHotkeys(false), { setItem: (key, value) => void written.set(key, value) });
    expect(JSON.parse(written.get(TERMINAL_HOTKEYS_KEY) ?? "{}").copy).toEqual(["Ctrl+Shift+C"]);
    expect(() =>
      persistTerminalHotkeys(defaultTerminalHotkeys(false), {
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
    pluginStore.removeItem(TERMINAL_HOTKEYS_KEY);
  });

  it("不注入 storage 时读写经 pluginStore 回环", () => {
    const bindings = sanitizeTerminalHotkeys({ clear: ["ctrl+shift+k"] }, false);
    persistTerminalHotkeys(bindings);
    expect(JSON.parse(pluginStore.getItem(TERMINAL_HOTKEYS_KEY) ?? "{}").clear).toEqual(["Ctrl+Shift+K"]);
    expect(loadTerminalHotkeys(false).clear).toEqual(["Ctrl+Shift+K"]);
  });

  it("无持久化值时回平台默认（node/无桥环境下默认档为内存，不抛 SecurityError）", () => {
    expect(loadTerminalHotkeys(true)).toEqual(defaultTerminalHotkeys(true));
  });
});

describe("matchTerminalHotkey", () => {
  it("命中默认键位返回动作 id", () => {
    const bindings = defaultTerminalHotkeys(false);
    expect(matchTerminalHotkey(bindings, "Ctrl+Shift+C")).toBe("copy");
    expect(matchTerminalHotkey(bindings, "Ctrl+V")).toBe("paste");
    expect(matchTerminalHotkey(bindings, "Ctrl+Shift+K")).toBe("clear");
  });

  it("解绑的动作不再命中", () => {
    const bindings = sanitizeTerminalHotkeys({ copy: [] }, false);
    expect(matchTerminalHotkey(bindings, "Ctrl+Shift+C")).toBeNull();
  });

  it("未绑定的组合返回 null（按键继续下发远端）", () => {
    expect(matchTerminalHotkey(defaultTerminalHotkeys(false), "Ctrl+C")).toBeNull();
    expect(matchTerminalHotkey(defaultTerminalHotkeys(false), "Ctrl+A")).toBeNull();
  });

  it("同一组合被多动作占用时按动作表顺序取第一个", () => {
    const bindings = sanitizeTerminalHotkeys({ copy: ["Ctrl+Shift+C"], "select-all": ["Ctrl+Shift+C"] }, false);
    expect(matchTerminalHotkey(bindings, "Ctrl+Shift+C")).toBe("copy");
    expect(findHotkeyConflicts(bindings)).toEqual([{ combo: "Ctrl+Shift+C", actions: ["copy", "select-all"] }]);
  });
});

describe("combosUsedByOthers", () => {
  it("只返回其它动作占用的组合且去重", () => {
    const bindings = defaultTerminalHotkeys(false);
    const used = combosUsedByOthers(bindings, "copy");
    expect(used).not.toContain("Ctrl+Shift+C");
    expect(used).toContain("Ctrl+V");
  });
});

describe("hotkeysEqual", () => {
  it("逐动作逐项比较", () => {
    const a = defaultTerminalHotkeys(true);
    expect(hotkeysEqual(a, defaultTerminalHotkeys(true))).toBe(true);
    expect(hotkeysEqual(a, defaultTerminalHotkeys(false))).toBe(false);
    const modified: TerminalHotkeyBindings = { ...a, search: [] };
    expect(hotkeysEqual(a, modified)).toBe(false);
    const reordered: TerminalHotkeyBindings = { ...a, "zoom-in": [...a["zoom-in"]].reverse() };
    expect(hotkeysEqual(a, reordered)).toBe(false);
  });
});
