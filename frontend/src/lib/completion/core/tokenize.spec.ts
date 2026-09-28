import { describe, expect, it } from "vitest";
import { splitCommandLine } from "./tokenize";

// 冻结语义回归：splitCommandLine 自 lib/completions/spec.ts 上移（最终架构
// legacy 退役后的公共依赖），本文件保证语义与原实现逐字一致。
describe("splitCommandLine（冻结）", () => {
  it("普通空白切分", () => {
    const r = splitCommandLine("git commit -m msg");
    expect(r.tokens.map((t) => t.text)).toEqual(["git", "commit", "-m", "msg"]);
    expect(r.trailingSpace).toBe(false);
    expect(r.terminated).toBe(false);
  });

  it("尾随空白 = 正在敲空 token（空行 trailingSpace 为 false，空前缀由 partial 兜底）", () => {
    expect(splitCommandLine("git ").trailingSpace).toBe(true);
    expect(splitCommandLine("git").trailingSpace).toBe(false);
    expect(splitCommandLine("").tokens).toEqual([]);
    expect(splitCommandLine("").trailingSpace).toBe(false);
  });

  it("单引号内空格不切分、全字面", () => {
    const r = splitCommandLine("echo 'a b  c'");
    expect(r.tokens[1]).toMatchObject({ text: "a b  c", quoted: true });
  });

  it("双引号保留空格、支持转义", () => {
    expect(splitCommandLine('echo "a\\ b"').tokens[1]?.text).toBe("a b");
  });

  it("引号外反斜杠转义", () => {
    expect(splitCommandLine("echo a\\ b").tokens[1]?.text).toBe("a b");
  });

  it("显式空 token ''", () => {
    expect(splitCommandLine("git ''").tokens[1]).toMatchObject({ text: "", quoted: true });
  });

  it("裸 -- 终结符关闭 flag 解析（终结符本身入列）", () => {
    const r = splitCommandLine("git log -- --foo");
    expect(r.terminated).toBe(true);
    expect(r.tokens[2]).toMatchObject({ text: "--", isFlag: false, terminator: true });
    expect(r.tokens[3]).toMatchObject({ text: "--foo", isFlag: false });
  });

  it("行尾悬空反斜杠按字面保留", () => {
    expect(splitCommandLine("echo x\\").tokens[1]?.text).toBe("x\\");
  });

  it("flag 判定（- 与裸 -- 除外）", () => {
    expect(splitCommandLine("cmd -x --yy -").tokens.slice(1).map((t) => t.isFlag)).toEqual([true, true, false]);
  });
});
