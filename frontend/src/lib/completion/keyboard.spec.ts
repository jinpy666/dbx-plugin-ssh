// 键盘所有权规则表驱动单测（FIG wave-1 Lane A'，契约 §2.2）：菜单显示 ≠
// 键盘所有权。Enter 恒放行 shell、动态 hint 行（generator 位置）/ loading 态
// Tab 放行、Esc 关闭、菜单关时按键归还 shell——表内全组合固化，缺一不可
// （回退红线）。
import { describe, expect, it } from "vitest";
import { resolveCompletionKey, type CompletionKeyboardState } from "./keyboard";
import type { CompletionItemKind } from "./core/types";

function state(overrides: Partial<CompletionKeyboardState> = {}): CompletionKeyboardState {
  return { menuOpen: true, hasItems: true, activeItemKind: "subcommand", loading: false, ...overrides };
}

const STATIC_KINDS: CompletionItemKind[] = ["command", "subcommand", "option", "argument", "file", "directory", "history"];

describe("resolveCompletionKey · 菜单开 + 静态候选", () => {
  for (const kind of STATIC_KINDS) {
    it(`Enter 放行 / Tab 接受 / ↑↓ 移动 / Esc 关闭（kind=${kind}）`, () => {
      const current = state({ activeItemKind: kind });
      expect(resolveCompletionKey(current, "Enter")).toBe("passthrough");
      expect(resolveCompletionKey(current, "Tab")).toBe("accept");
      expect(resolveCompletionKey(current, "ArrowDown")).toBe("next");
      expect(resolveCompletionKey(current, "ArrowUp")).toBe("prev");
      expect(resolveCompletionKey(current, "Escape")).toBe("close");
    });
  }

  it("option 与 argument kind 同样 Tab 接受（git checkout - 与 -o 值层）", () => {
    expect(resolveCompletionKey(state({ activeItemKind: "option" }), "Tab")).toBe("accept");
    expect(resolveCompletionKey(state({ activeItemKind: "argument" }), "Tab")).toBe("accept");
  });
});

describe("resolveCompletionKey · 菜单开 + 动态 hint / loading / 无候选", () => {
  it("hint 高亮：Enter/Tab 放行 shell，↑↓ 仍移动，Esc 关闭", () => {
    const current = state({ activeItemKind: "hint" });
    expect(resolveCompletionKey(current, "Enter")).toBe("passthrough");
    expect(resolveCompletionKey(current, "Tab")).toBe("passthrough");
    expect(resolveCompletionKey(current, "ArrowDown")).toBe("next");
    expect(resolveCompletionKey(current, "ArrowUp")).toBe("prev");
    expect(resolveCompletionKey(current, "Escape")).toBe("close");
  });

  it("loading 态：即便高亮静态候选，Tab 也放行（动态结果未回）", () => {
    const current = state({ activeItemKind: "subcommand", loading: true });
    expect(resolveCompletionKey(current, "Tab")).toBe("passthrough");
    expect(resolveCompletionKey(current, "Enter")).toBe("passthrough");
    expect(resolveCompletionKey(current, "ArrowDown")).toBe("next");
    expect(resolveCompletionKey(current, "Escape")).toBe("close");
  });

  it("无高亮（activeItemKind=null）：Tab 放行", () => {
    expect(resolveCompletionKey(state({ activeItemKind: null }), "Tab")).toBe("passthrough");
  });

  it("无候选（hasItems=false）：↑↓ 无动作，Tab/Enter 放行，Esc 关闭", () => {
    const current = state({ hasItems: false, activeItemKind: null });
    expect(resolveCompletionKey(current, "ArrowDown")).toBe("none");
    expect(resolveCompletionKey(current, "ArrowUp")).toBe("none");
    expect(resolveCompletionKey(current, "Tab")).toBe("passthrough");
    expect(resolveCompletionKey(current, "Enter")).toBe("passthrough");
    expect(resolveCompletionKey(current, "Escape")).toBe("close");
  });
});

describe("resolveCompletionKey · 菜单关", () => {
  const closed = state({ menuOpen: false, activeItemKind: null, hasItems: false });

  it("Enter/Tab/↑↓ 一律归还 shell", () => {
    expect(resolveCompletionKey(closed, "Enter")).toBe("passthrough");
    expect(resolveCompletionKey(closed, "Tab")).toBe("passthrough");
    expect(resolveCompletionKey(closed, "ArrowUp")).toBe("passthrough");
    expect(resolveCompletionKey(closed, "ArrowDown")).toBe("passthrough");
  });

  it("Escape 为 none（无事可关，交由其它浮层/面板处理）", () => {
    expect(resolveCompletionKey(closed, "Escape")).toBe("none");
  });
});

describe("resolveCompletionKey · 无关按键", () => {
  it("菜单开/关均返回 none", () => {
    expect(resolveCompletionKey(state(), "a")).toBe("none");
    expect(resolveCompletionKey(state(), "ArrowLeft")).toBe("none");
    expect(resolveCompletionKey(state({ menuOpen: false }), "F5")).toBe("none");
  });
});
