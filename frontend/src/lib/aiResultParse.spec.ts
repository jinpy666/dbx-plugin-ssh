// aiResultParse 单测（AI 体验改造 v2）：直连生成的「命令 + Why」契约解析，
// `#` 搜索与失败修复共用。三态钉死：标准两行 / 只有一行 / 空串。
import { describe, expect, it } from "vitest";
import { AI_RESULT_WHY_PREFIX, parseAiResultText } from "./aiResultParse";

describe("parseAiResultText", () => {
  it("标准两行：首行命令 + Why 行", () => {
    expect(parseAiResultText("ls -S\nWhy: sorts by size, largest first.")).toEqual({
      command: "ls -S",
      why: "Why: sorts by size, largest first.",
    });
  });

  it("只有一行（无 Why）：why 空串，展示退化为仅命令行", () => {
    expect(parseAiResultText("df -h /srv")).toEqual({ command: "df -h /srv", why: "" });
  });

  it("空串 / 纯空白 → null（调用方按异常回退）", () => {
    expect(parseAiResultText("")).toBeNull();
    expect(parseAiResultText("   \n  \n")).toBeNull();
  });

  it("CRLF 与首行前导空白归一；Why 标记行内允许缩进", () => {
    expect(parseAiResultText("  ls -S\r\nWhy: x")).toEqual({ command: "ls -S", why: "Why: x" });
    expect(parseAiResultText("ls\n  Why: y")).toEqual({ command: "ls", why: "Why: y" });
  });

  it("Why 之后的杂行不污染结果；Why 缺失而后续有普通行同样忽略", () => {
    expect(parseAiResultText("ls -S\nWhy: a\nextra chatter")).toEqual({ command: "ls -S", why: "Why: a" });
    expect(parseAiResultText("ls -S\nextra chatter")).toEqual({ command: "ls -S", why: "" });
  });

  it("Why 标记大小写按 prompt 契约精确匹配（小写 why 不算 Why 行）", () => {
    expect(parseAiResultText("ls -S\nwhy: lowercase")).toEqual({ command: "ls -S", why: "" });
    expect(AI_RESULT_WHY_PREFIX).toBe("Why:");
  });
});
