// #243 契约：预览弹窗的滚动条豁免规则不得使用 thin 等「标准滚动条属性非 auto」
// 的取值——Chromium ≥121 / 新版 WebKit 会因此禁用 ::-webkit-scrollbar 自定义
// 样式，滚回系统 overlay 滚动条（macOS 闲置时不可见）。0.7.11 的 thin 就是
// 这样把修复打回原形的。这里直接读 style.css 锁住取值。
// @ts-expect-error — Node built-in types are not included in the frontend tsconfig.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

// 扫描所有规则块，返回选择器组里含目标选择器的块的声明列表。
// 先剥离注释：选择器组上方的契约注释会把第一个选择器和注释粘在同一段里。
const cssBody = css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string[] {
  const blocks = [...cssBody.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  return blocks
    .filter((m: RegExpMatchArray) => m[1].split(",").some((s) => s.trim() === selector))
    .flatMap((m) => m[2].split(";").map((s: string) => s.trim()).filter(Boolean));
}

describe("style.css 预览滚动条豁免（#243）", () => {
  const previewScrollers = [
    ".ssh-preview .cm-scroller",
    ".ssh-preview-hex",
    ".ssh-preview .wb-md-render",
  ];

  it("豁免规则存在（防止选择器被改丢后测试空转）", () => {
    expect(css).toContain(".ssh-preview .cm-scroller");
    expect(css).toContain("::-webkit-scrollbar-thumb");
  });

  for (const selector of previewScrollers) {
    it(`${selector} 只能用 scrollbar-width: auto，且不得设置 scrollbar-color`, () => {
      const decls = declarationsFor(selector);
      expect(decls.length, `未找到 ${selector} 的规则块`).toBeGreaterThan(0);
      for (const decl of decls) {
        if (decl.startsWith("scrollbar-width")) {
          expect(decl).toBe("scrollbar-width: auto");
        }
        expect(decl.startsWith("scrollbar-color"), `scrollbar-color 会禁用 ::-webkit-scrollbar 自定义：${decl}`).toBe(false);
      }
    });
  }
});
