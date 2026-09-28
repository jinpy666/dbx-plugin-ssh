// fig spec 静态 adapter 单测（Lane C）：全部离线，走 fixtures/git.fig.json。
// 覆盖 lane 细则 §5 要求的能力面：别名、persistent、variadic、`--` 终结、
// 内联 `=` 值层、深度子命令；外加与 legacy parser 的同行候选对比
//（信息性用例：允许 fig 更丰富，断言 fig ⊇ legacy 的静态部分）。
import { describe, expect, it } from "vitest";
import { resolveFigLine } from "./adapter";
import type { FigSpecRoot } from "./types";
import gitFixture from "./fixtures/git.fig.json";
import { matchSpecLine } from "../../completions/spec";
import { gitSpec } from "../../completions/specs/git";

const specs: readonly FigSpecRoot[] = [gitFixture as FigSpecRoot];

const labels = (line: string): string[] => {
  const result = resolveFigLine(line, specs);
  expect(result).not.toBeNull();
  return result!.items.map((item) => item.edit.text);
};

describe("resolveFigLine", () => {
  it("根命令前缀：`gi` → git（kind=command，source=fig-spec）", () => {
    const result = resolveFigLine("gi", specs);
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({ label: "git", kind: "command", source: "fig-spec" });
    expect(result?.items[0].edit).toEqual({ text: "git", replaceStart: 0, replaceEnd: 2 });
    expect(result?.context).toEqual({ command: null, commandPath: [], tokenStart: 0, tokenEnd: 2 });
  });

  it("无 spec 命中 / flag 开头的根前缀 → null", () => {
    expect(resolveFigLine("foo bar", specs)).toBeNull();
    expect(resolveFigLine("", specs)).toBeNull();
    expect(resolveFigLine("-", specs)).toBeNull();
  });

  it("子命令前缀过滤 + token 边界（`git ch`）", () => {
    const result = resolveFigLine("git ch", specs);
    expect(result?.items.map((i) => i.edit.text).sort()).toEqual(["checkout", "cherry-pick"]);
    expect(result?.items.every((i) => i.kind === "subcommand")).toBe(true);
    expect(result?.context).toEqual({ command: "git", commandPath: ["git"], tokenStart: 4, tokenEnd: 6 });
  });

  it("别名命中候选：`git co` → checkout（别名）与 commit（主名前缀）并列", () => {
    expect(labels("git co").sort()).toEqual(["checkout", "commit"]);
  });

  it("完整 token 的别名下钻：`git co -` 进入 checkout 的 flag 层", () => {
    const got = labels("git co -");
    expect(got).toContain("--force-branch");
    expect(got).toContain("-B");
    const result = resolveFigLine("git co -", specs);
    expect(result?.context.commandPath).toEqual(["git", "checkout"]);
  });

  it("persistent option 沿子命令树下传，非 persistent 根 option 不下传", () => {
    const atSub = labels("git checkout -");
    expect(atSub).toContain("-C"); // persistent
    expect(atSub).toContain("--no-pager"); // persistent
    expect(atSub).toContain("--git-dir"); // persistent
    expect(atSub).not.toContain("--version"); // 根非 persistent
    expect(atSub).not.toContain("--help"); // 根非 persistent

    const atRoot = labels("git -");
    expect(atRoot).toContain("--version");
    expect(atRoot).toContain("--help");
    expect(atRoot).not.toContain("--force"); // 子命令 option 不上浮
  });

  it("flag 层短/长名都以原样参与候选并带 <arg> 占位展示", () => {
    const result = resolveFigLine("git checkout --br", specs);
    const optionItems = result?.items.filter((i) => i.kind === "option") ?? [];
    expect(optionItems.map((i) => i.label)).toEqual(["--branch <name>"]);
    const both = resolveFigLine("git checkout --force", specs);
    expect(both?.items.map((i) => i.label).sort()).toEqual(["--force", "--force-branch <name>"]);
    expect(optionItems.every((i) => i.edit.text.startsWith("--"))).toBe(true);
  });

  it("repeatable option 不因已出现而消失；非 repeatable 用过即隐藏", () => {
    const repeatable = labels("git commit --trailer a=1 --trailer b=2 -");
    expect(repeatable).toContain("--trailer");

    const once = labels("git commit -m msg -");
    expect(once).not.toContain("-m");
    expect(once).not.toContain("--message");
    expect(once).toContain("--amend");
  });

  it("值层（等待值的 option）：静态 suggestions 过滤 / 自由值出 hint", () => {
    // 同分按 label 字典序（与 legacy 排序口径一致）
    expect(labels("git log --pretty ")).toEqual(["full", "medium", "oneline", "raw", "short"]);
    expect(labels("git log --pretty s")).toEqual(["short"]);

    const hint = resolveFigLine("git checkout -b ", specs);
    expect(hint?.items).toHaveLength(1);
    expect(hint?.items[0]).toMatchObject({ kind: "hint", label: "<name>" });
    expect(hint?.items[0].edit.text).toBe("");
  });

  it("内联 `--flag=value` 值层：候选整体替换当前 token，前缀取 = 后半段", () => {
    const result = resolveFigLine("git log --pretty=", specs);
    expect(result?.items.map((i) => i.edit.text)).toEqual([
      "--pretty=full",
      "--pretty=medium",
      "--pretty=oneline",
      "--pretty=raw",
      "--pretty=short",
    ]);
    expect(labels("git log --pretty=f")).toEqual(["--pretty=full"]);
    expect(resolveFigLine("git checkout --unknown=", specs)).toBeNull();
  });

  it("variadic args：多个位置 token 后持续补同一参数", () => {
    const one = resolveFigLine("git add src/", specs);
    const three = resolveFigLine("git add src/ lib/ docs/", specs);
    expect(one?.items.map((i) => i.label)).toEqual(["<pathspec>"]);
    expect(three?.items.map((i) => i.label)).toEqual(["<pathspec>"]);
    expect(three?.items.every((i) => i.kind === "hint")).toBe(true);
  });

  it("非 variadic 位置参数只提示第一个；后续位置沿 args 链推进", () => {
    expect(resolveFigLine("git remote add ", specs)?.items.map((i) => i.label)).toEqual(["<name>"]);
    expect(resolveFigLine("git remote add origin ", specs)?.items.map((i) => i.label)).toEqual(["<url>"]);
    // args 链耗尽后不再出位置候选；对齐 legacy：空层拿 option 兜底
    const exhausted = resolveFigLine("git remote add origin https://x.git extra ", specs);
    expect(exhausted?.items.some((i) => i.kind === "hint" || i.kind === "argument")).toBe(false);
    expect(exhausted?.items.every((i) => i.kind === "option")).toBe(true);
  });

  it("`--` 终结符：其后不再出 flag / 子命令，只剩位置参数", () => {
    const after = labels("git checkout -- ");
    expect(after.every((text) => !text.startsWith("-"))).toBe(true);
    const result = resolveFigLine("git checkout -- ", specs);
    expect(result?.items.some((i) => i.kind === "hint" || i.kind === "argument")).toBe(true);
    // 正在敲的半截 `--` 仍按 flag 层出候选（与 legacy 语义一致）
    expect(labels("git checkout --")).toContain("--force-branch");
  });

  it("子命令树无深度限制：git → remote → set-url 三层下钻（legacy 只有两层）", () => {
    const result = resolveFigLine("git remote set-url ", specs);
    expect(result?.context.commandPath).toEqual(["git", "remote", "set-url"]);
    expect(result?.items.map((i) => i.label)).toEqual(["<name>"]);

    const deep = resolveFigLine("git remote set-url --add ", specs);
    expect(deep?.items.map((i) => i.label)).toEqual(["<name>"]);
  });

  it("深层别名下钻：`git remote rm `（remove 的别名）", () => {
    const result = resolveFigLine("git remote rm ", specs);
    expect(result?.context.commandPath).toEqual(["git", "remote", "remove"]);
    expect(result?.items.map((i) => i.label)).toEqual(["<name>"]);
  });

  it("id 稳定唯一、排序确定（score 降序 + label 字典序）", () => {
    const a = resolveFigLine("git ch", specs);
    const b = resolveFigLine("git ch", specs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a?.items.map((i) => i.id)).size).toBe(a?.items.length);
  });

  it("信息性对比：fig 与 legacy 对 git 同行输入，fig 静态候选 ⊇ legacy", () => {
    const lines = ["git ch", "git checkout -", "git remote ", "git checkout --br"];
    for (const line of lines) {
      const legacy = matchSpecLine(line, [gitSpec]);
      const fig = resolveFigLine(line, specs);
      if (!legacy) continue;
      expect(fig).not.toBeNull();
      const legacyTokens = new Set(legacy.rows.filter((row) => row.kind !== "hint").map((row) => row.token));
      const figTokens = new Set(fig!.items.filter((item) => item.kind !== "hint").map((item) => item.edit.text));
      for (const token of legacyTokens) {
        expect(figTokens.has(token), `line=${line} legacy token=${token} 缺失于 fig`).toBe(true);
      }
    }
  });
});
