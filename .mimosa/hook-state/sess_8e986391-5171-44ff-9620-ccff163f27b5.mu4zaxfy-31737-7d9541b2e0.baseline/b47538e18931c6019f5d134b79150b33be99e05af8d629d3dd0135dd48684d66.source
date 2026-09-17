// 薄 spec：验证 shared/frontend/editorTheme 在本插件工具链下 import 解析与
// 行为成立（调色板、tag 展开、组合 tag 解析、HighlightStyle 构造与记忆化）。
import { describe, expect, it } from "vitest";
import {
  dbxSyntaxHighlight,
  EDITOR_TOKEN_COLORS,
  resolveSyntaxTag,
  syntaxTokenSpecs,
  type EditorHighlightRuntime,
} from "../../../shared/frontend/editorTheme";

// 最小假运行时：只记录 define 收到的 spec，供结构断言。tags 对普通成员返回
// 可识别占位对象，对修饰器组合返回解析函数（镜像 @lezer/highlight tags 形状）。
function fakeRuntime(): EditorHighlightRuntime & { definedSpecs: Array<Record<string, unknown>> } {
  const definedSpecs: Array<Record<string, unknown>> = [];
  const tagObject = (name: string) => ({ name });
  const known: Record<string, unknown> = {
    keyword: tagObject("keyword"),
    variableName: tagObject("variableName"),
    function: (tag: unknown) => tagObject(`function(${(tag as { name: string }).name})`),
    constant: (tag: unknown) => tagObject(`constant(${(tag as { name: string }).name})`),
  };
  const tags: Record<string, unknown> = new Proxy(known, {
    get: (target, name) => target[String(name)] ?? tagObject(String(name)),
  });
  return {
    definedSpecs,
    HighlightStyle: {
      define(specs) {
        definedSpecs.push(...specs.map((spec) => ({ ...spec })));
        return { kind: "highlightStyle" };
      },
    },
    syntaxHighlighting: (style) => ({ kind: "syntaxHighlighting", style }),
    tags,
  };
}

describe("editorTheme (shared/frontend)", () => {
  it("exposes light/dark palettes with the brightened GitHub Dark scheme", () => {
    // 暗色为提亮后的取值（替代原 basicSetup 浅底配色 / 标准 VS Code Dark+）
    expect(EDITOR_TOKEN_COLORS.dark.key).toBe("#4fc1ff");
    expect(EDITOR_TOKEN_COLORS.dark.string).toBe("#ffb86c");
    expect(EDITOR_TOKEN_COLORS.dark.number).toBe("#c3e88d");
    expect(EDITOR_TOKEN_COLORS.dark.null).toBe("#e5c07b");
    expect(EDITOR_TOKEN_COLORS.dark.punct).toBe("#dcdcdc");
    expect(EDITOR_TOKEN_COLORS.dark.prop).toBe("#7cc7ff");
    // 浅色保持 VS Code Light+ 同源；variable 跟随默认前景（null 不覆盖）
    expect(EDITOR_TOKEN_COLORS.light.key).toBe("#0000ff");
    expect(EDITOR_TOKEN_COLORS.light.variable).toBeNull();
  });

  it("expands tag groups into specs and skips null palette entries", () => {
    const dark = syntaxTokenSpecs("dark");
    expect(dark).toContainEqual({ tag: "keyword", color: "#4fc1ff", fontWeight: undefined });
    expect(dark).toContainEqual({ tag: "heading", color: "#56d4dd", fontWeight: "700" });
    // 浅色 variable 为 null → 不产出 variableName 条目
    expect(syntaxTokenSpecs("light").some((spec) => spec.tag === "variableName")).toBe(false);
    expect(syntaxTokenSpecs("dark").some((spec) => spec.tag === "variableName")).toBe(true);
  });

  it("resolves modifier tag expressions like function(variableName)", () => {
    const { tags } = fakeRuntime();
    expect(resolveSyntaxTag(tags, "keyword")).toEqual({ name: "keyword" });
    expect(resolveSyntaxTag(tags, "function(variableName)")).toEqual({ name: "function(variableName)" });
    expect(resolveSyntaxTag(tags, "constant(variableName)")).toEqual({ name: "constant(variableName)" });
    // 未知成员不抛错（返回 tags 集合的查询结果，装配端不做特判）
    expect(resolveSyntaxTag(tags, "nonexistent")).toEqual({ name: "nonexistent" });
  });

  it("builds one highlight extension per scheme and memoizes it", () => {
    const lightRuntime = fakeRuntime();
    const darkRuntime = fakeRuntime();
    const lightFirst = dbxSyntaxHighlight("light", lightRuntime);
    expect(lightFirst).toEqual({ kind: "syntaxHighlighting", style: { kind: "highlightStyle" } });
    // 收到的是解析后的完整 spec 面（含 keyword 子 tag 与修饰器组合 tag）
    const resolvedTagNames = lightRuntime.definedSpecs.map((spec) => (spec.tag as { name?: string }).name ?? String(spec.tag));
    expect(resolvedTagNames).toContain("controlKeyword");
    expect(resolvedTagNames).toContain("function(variableName)");
    expect(resolvedTagNames).toContain("constant(variableName)");

    // 同色系记忆化：不再触发第二次 define
    expect(dbxSyntaxHighlight("light", lightRuntime)).toBe(lightFirst);
    expect(lightRuntime.definedSpecs).toHaveLength(syntaxTokenSpecs("light").length);

    // 不同色系独立缓存
    dbxSyntaxHighlight("dark", darkRuntime);
    expect(darkRuntime.definedSpecs[0]?.color).toBe(EDITOR_TOKEN_COLORS.dark.key);
  });
});
