// vendored parser 冒烟（全离线）：bundled parser.js（上游 amazon-q 状态机 +
// shell-parser）配对真实 withfig/autocomplete 语料（manifest allowlist 内的
// git spec）。验收语义：shell 别名展开 / 嵌套子命令 / `--` 终结 / --flag=value
// 复合 token / 变参。语义全部来自上游代码，本文件只驱动。
// @vitest-environment happy-dom（parser 产物模块顶层向 window 注册调试钩子）

import { describe, expect, it } from "vitest";

// @ts-expect-error — vendored parser 是无类型 JS 产物（见 vendor README / NOTICE）
import * as parserModule from "../../../../vendor/autocomplete-engine/parser.js";
// 生成的 manifest 为带 @ts-nocheck 的 TS 生成物，可直接解析
import generatedManifest from "../../../../vendor/fig-specs/spec-manifest.generated";

interface EngineLike {
  TokenType: Record<string, string>;
  SuggestionFlag: Record<string, number>;
  getInitialState: (spec: unknown, text?: string, location?: unknown) => unknown;
  updateState: (state: never, token: string, isFinalToken?: boolean) => never;
  getResultFromState: (state: never) => {
    searchTerm: string;
    suggestionFlags: number;
    currentArg: { name?: string | string[] } | null;
    completionObj: { name?: string[]; subcommands?: Record<string, unknown> };
  };
  getCommand: (line: string, aliases: Record<string, string>, cursorIndex?: number) => {
    tokens: Array<{ text: string; node: { startIndex: number; endIndex: number } }>;
  } | null;
  convertSubcommand: (spec: unknown, initializeDefault: unknown) => Record<string, unknown>;
  initializeDefault: (spec: unknown) => unknown;
}

const engine = parserModule as unknown as EngineLike;
const manifest = generatedManifest as Record<string, unknown>;

/** 驱动一行输入，返回上游 getResultFromState 摘要（镜像 figCompletionSource）。 */
function drive(gitSpec: Record<string, unknown>, line: string) {
  const command = engine.getCommand(line, {}, line.length);
  if (!command || command.tokens.length === 0) throw new Error(`no command for ${line}`);
  let state = engine.getInitialState(gitSpec, command.tokens[0].text, {
    name: command.tokens[0].text,
    type: "global",
  });
  for (let i = 1; i < command.tokens.length - 1; i += 1) {
    state = engine.updateState(state as never, command.tokens[i].text);
  }
  const last = command.tokens[command.tokens.length - 1];
  let final: unknown;
  try {
    final = engine.updateState(state as never, last.text, true);
  } catch {
    final = {
      ...(state as Record<string, unknown>),
      annotations: [
        ...((state as { annotations: unknown[] }).annotations ?? []),
        { type: engine.TokenType.None, text: last.text },
      ],
    };
  }
  const result = engine.getResultFromState(final as never);
  const flags: string[] = [];
  if (result.suggestionFlags & engine.SuggestionFlag.Subcommands) flags.push("subcommands");
  if (result.suggestionFlags & engine.SuggestionFlag.Options) flags.push("options");
  if (result.suggestionFlags & engine.SuggestionFlag.Args) flags.push("args");
  return { result, flags, tokens: command.tokens };
}

describe("vendored parser 冒烟（真实 git 语料）", () => {
  const gitSpec = engine.convertSubcommand(manifest.git, engine.initializeDefault);

  it("git spec 经 convertSubcommand 归一化（record 化 + 缺省补齐）", () => {
    expect(Array.isArray(gitSpec.name) ? gitSpec.name[0] : gitSpec.name).toBe("git");
    const subs = gitSpec.subcommands as Record<string, unknown>;
    expect(Object.keys(subs).length).toBeGreaterThan(10);
    expect(subs.commit).toBeTruthy();
    expect(gitSpec.options).toBeTypeOf("object");
    expect(gitSpec.persistentOptions).toBeTypeOf("object");
  });

  it("嵌套子命令：git commit → completionObj 切到 commit", () => {
    const { result } = drive(gitSpec, "git commit ");
    const names = Array.isArray(result.completionObj.name)
      ? result.completionObj.name
      : [result.completionObj.name];
    expect(names[0]).toBe("commit");
  });

  it("`--` 终结：git status -- <空> → 只剩 args 建议（options/subcommands 关闭）", () => {
    const { flags } = drive(gitSpec, "git status -- ");
    expect(flags).toEqual(["args"]);
  });

  it("--flag=value 复合 token：git commit --message=x → searchTerm 落在选项参数 x", () => {
    const { result } = drive(gitSpec, "git commit --message=x");
    expect(result.searchTerm).toBe("x");
  });

  it("行尾 token 边界为 buffer 绝对偏移（含行尾空 token）", () => {
    const { tokens } = drive(gitSpec, "git checkout -b ");
    const last = tokens[tokens.length - 1];
    expect(last.text).toBe("");
    expect(last.node.startIndex).toBe("git checkout -b ".length);
    expect(last.node.endIndex).toBe(last.node.startIndex);
  });

  it("shell 别名展开（上游 shell-parser substituteAlias）", () => {
    const command = engine.getCommand("gst ", { gst: "git status" }, 4);
    expect(command).not.toBeNull();
    const texts = (command?.tokens ?? []).map((t) => t.text);
    expect(texts[0]).toBe("git");
    expect(texts[1]).toBe("status");
  });

  it("变参位持续可消费：git add a b c 后仍在 arg 位", () => {
    const { flags, result } = drive(gitSpec, "git add a b c ");
    expect(flags).toContain("args");
    const name = Array.isArray(result.currentArg?.name)
      ? result.currentArg?.name[0]
      : result.currentArg?.name;
    expect(typeof name === "string" || name === null).toBe(true);
  });
});
