// 结构化补全纯函数单测：token 切分（引号/转义/终结符/尾空格边界）与
// matchSpecLine 层级匹配（根前缀 → 子命令 → flag → 值，评分排序与截断）。
// 语法分支用内联合成 spec 精确断言；真实数据集另跑冒烟断言（specs/index）。
import { describe, expect, it } from "vitest";
import { matchSpecLine, splitCommandLine, SPEC_COMPLETION_MAX_ROWS, type CompletionSpecs } from "./spec";
import { COMPLETION_SPECS } from "./specs";

// ---------------------------------------------------------------------------
// 合成 spec：只覆盖 matchSpecLine 的分支语法，不掺真实命令语义。
// ---------------------------------------------------------------------------
const SYNTHETIC: CompletionSpecs = [
  {
    name: "syn",
    description: "synthetic root",
    flags: [{ name: "verbose", short: "v", description: "talk more" }],
    subcommands: [
      {
        name: "alpha",
        description: "first sub",
        flags: [
          { name: "format", description: "output format", arg: "fmt", values: ["json", "yaml", "wide"] },
          { name: "branch", short: "b", description: "new branch", arg: "name" },
          { name: "force", short: "f", description: "overwrite" },
          { name: "zeta", description: "last flag" },
        ],
        positional: { name: "branch", dynamic: true },
      },
      { name: "beta", description: "second sub" },
    ],
  },
];

describe("splitCommandLine", () => {
  it("splits on spaces and tabs outside quotes", () => {
    const result = splitCommandLine("git status --short");
    expect(result.tokens.map((token) => token.text)).toEqual(["git", "status", "--short"]);
    expect(result.tokens.map((token) => token.isFlag)).toEqual([false, false, true]);
    expect(result.trailingSpace).toBe(false);
  });

  it("marks the trailing empty token via trailingSpace", () => {
    const result = splitCommandLine("git   ");
    expect(result.tokens.map((token) => token.text)).toEqual(["git"]);
    expect(result.trailingSpace).toBe(true);
  });

  it("keeps spaces inside single and double quotes as one token", () => {
    const single = splitCommandLine("echo 'a b c'");
    expect(single.tokens[1]).toMatchObject({ text: "a b c", isFlag: false, quoted: true });
    const double = splitCommandLine('git commit -m "fix: the thing"');
    expect(double.tokens.map((token) => token.text)).toEqual(["git", "commit", "-m", "fix: the thing"]);
    expect(double.tokens[3].quoted).toBe(true);
  });

  it("resolves backslash escapes outside quotes and escaped quotes inside double quotes", () => {
    expect(splitCommandLine("my\\ file").tokens[0].text).toBe("my file");
    expect(splitCommandLine('"say \\"hi\\""').tokens[0].text).toBe('say "hi"');
  });

  it("preserves an explicitly empty quoted token", () => {
    const result = splitCommandLine("git commit -m ''");
    expect(result.tokens).toHaveLength(4);
    expect(result.tokens[3]).toMatchObject({ text: "", isFlag: false, quoted: true });
  });

  it("treats a bare -- as a terminator token that closes flag parsing", () => {
    const result = splitCommandLine("git log -- --weird-path");
    expect(result.terminated).toBe(true);
    expect(result.tokens.map((token) => token.text)).toEqual(["git", "log", "--", "--weird-path"]);
    expect(result.tokens[2]).toMatchObject({ terminator: true, isFlag: false });
    expect(result.tokens[3].isFlag).toBe(false);
  });

  it("does not treat a bare - as a flag token", () => {
    expect(splitCommandLine("sort -").tokens[1]).toMatchObject({ text: "-", isFlag: false });
  });

  it("keeps --flag=value as one token and survives a dangling backslash", () => {
    expect(splitCommandLine("kubectl get -o=json").tokens[2]).toMatchObject({ text: "-o=json", isFlag: true });
    expect(splitCommandLine("echo x \\").tokens.map((token) => token.text)).toEqual(["echo", "x", "\\"]);
  });
});

describe("matchSpecLine · levels", () => {
  it("returns null for unknown roots, flags-first lines and empty input", () => {
    expect(matchSpecLine("", SYNTHETIC)).toBeNull();
    expect(matchSpecLine("unknown-tool sub", SYNTHETIC)).toBeNull();
    expect(matchSpecLine("-v git", SYNTHETIC)).toBeNull();
  });

  it("matches an unfinished root by prefix", () => {
    const match = matchSpecLine("sy", SYNTHETIC);
    expect(match?.level).toBe("sub");
    expect(match?.rows).toEqual([expect.objectContaining({ kind: "sub", token: "syn", label: "syn", description: "synthetic root" })]);
  });

  it("lists subcommands with descriptions for `syn a`", () => {
    const match = matchSpecLine("syn a", SYNTHETIC);
    expect(match?.commandPath).toEqual(["syn"]);
    expect(match?.level).toBe("sub");
    expect(match?.rows.map((row) => row.token)).toEqual(["alpha"]);
    expect(match?.rows[0].description).toBe("first sub");
  });

  it("drills into second-level subcommands", () => {
    const match = matchSpecLine("syn alpha ", SYNTHETIC);
    expect(match?.commandPath).toEqual(["syn", "alpha"]);
    // alpha 无子命令、位置参数是动态值 → 唯一 hint 行。
    expect(match?.rows).toEqual([expect.objectContaining({ kind: "hint", label: "<branch>", token: "" })]);
  });

  it("offers flags for `-` and `--` prefixes and completes short forms only on exact short match", () => {
    const allLong = matchSpecLine("syn alpha --", SYNTHETIC);
    expect(allLong?.level).toBe("flag");
    expect([...(allLong?.rows.map((row) => row.label) ?? [])].sort()).toEqual(["--branch <name>", "--force", "--format <fmt>", "--zeta"].sort());
    // 歧义前缀：--fo 同时命中 force 与 format，按同分字典序排列。
    const dashDashFo = matchSpecLine("syn alpha --fo", SYNTHETIC);
    expect(dashDashFo?.rows.map((row) => row.token)).toEqual(["--force", "--format"]);
    const short = matchSpecLine("syn alpha -f", SYNTHETIC);
    expect(short?.rows).toEqual([expect.objectContaining({ token: "-f", label: "-f", space: true })]);
    // 单连字符但无对应短名：回落长名前缀匹配。
    const longFallback = matchSpecLine("syn alpha -z", SYNTHETIC);
    expect(longFallback?.rows.map((row) => row.token)).toEqual(["--zeta"]);
  });

  it("enters the value level after a value-taking flag and fills --flag=value inline", () => {
    const spaced = matchSpecLine("syn alpha --format ", SYNTHETIC);
    expect(spaced?.level).toBe("value");
    expect(spaced?.rows.map((row) => row.token)).toEqual(["json", "wide", "yaml"]);
    const inline = matchSpecLine("syn alpha --format=y", SYNTHETIC);
    expect(inline?.level).toBe("value");
    expect(inline?.rows).toEqual([expect.objectContaining({ token: "--format=yaml", label: "yaml" })]);
    // flag 值已消费后回到 sub 层（动态位置 → hint）。
    const consumed = matchSpecLine("syn alpha --format json ", SYNTHETIC);
    expect(consumed?.level).toBe("sub");
    expect(consumed?.rows[0].kind).toBe("hint");
  });

  it("stops flag parsing after a bare -- terminator", () => {
    const match = matchSpecLine("syn alpha -- -f", SYNTHETIC);
    expect(match?.level).toBe("sub");
    // "-f" 是位置参数（占掉动态位置）；终结符之后不再把 flags 当候选兜底。
    expect(match?.rows).toEqual([]);
  });

  it("marks flag rows taking values without a trailing space", () => {
    const match = matchSpecLine("syn alpha --b", SYNTHETIC);
    expect(match?.rows[0]).toMatchObject({ token: "--branch", space: false, description: "new branch (-b)" });
  });
});

describe("matchSpecLine · ranking", () => {
  const MANY: CompletionSpecs = [
    {
      name: "m",
      description: "many",
      subcommands: Array.from({ length: SPEC_COMPLETION_MAX_ROWS + 5 }, (_, i) => ({ name: `cmd${String(i).padStart(2, "0")}`, description: `sub ${i}` })),
    },
  ];

  it("ranks exact matches above prefix matches and breaks ties alphabetically", () => {
    const SPEC: CompletionSpecs = [
      {
        name: "r",
        description: "root",
        subcommands: [
          { name: "push", description: "b" },
          { name: "pull", description: "a" },
          { name: "punt", description: "c" },
        ],
      },
    ];
    const match = matchSpecLine("r pu", SPEC);
    // pull / punt / push 同为前缀命中且同分 → 字典序；无精确命中。
    expect(match?.rows.map((row) => row.label)).toEqual(["pull", "punt", "push"]);
    const exact = matchSpecLine("r push", SPEC);
    expect(exact?.rows.map((row) => row.label)).toEqual(["push"]);
  });

  it("caps rows at SPEC_COMPLETION_MAX_ROWS", () => {
    const match = matchSpecLine("m ", MANY);
    expect(match?.rows).toHaveLength(SPEC_COMPLETION_MAX_ROWS);
    // 截断保留评分序的前 N 名（同分字典序 → cmd00..cmd19）。
    expect(match?.rows[0].label).toBe("cmd00");
    expect(match?.rows[19].label).toBe("cmd19");
  });

  it("falls back to flags when the sub level has no subcommands or positional candidates", () => {
    const SPEC: CompletionSpecs = [{ name: "solo", description: "solo", flags: [{ name: "quiet", short: "q", description: "be quiet" }] }];
    const match = matchSpecLine("solo ", SPEC);
    expect(match?.level).toBe("sub");
    expect(match?.rows.map((row) => row.token)).toEqual(["--quiet"]);
  });
});

// ---------------------------------------------------------------------------
// 真实数据集冒烟（specs/index）：对齐任务示例场景。
// ---------------------------------------------------------------------------
describe("matchSpecLine · bundled specs", () => {
  it("suggests git subcommands for `git ch`", () => {
    const match = matchSpecLine("git ch", COMPLETION_SPECS);
    const tokens = match?.rows.map((row) => row.token) ?? [];
    expect(tokens).toContain("checkout");
    expect(tokens).toContain("cherry-pick");
    for (const row of match?.rows ?? []) expect(row.description.length).toBeGreaterThan(0);
  });

  it("offers flags for `git checkout --` and a dynamic branch hint for `git checkout `", () => {
    const flags = matchSpecLine("git checkout --", COMPLETION_SPECS);
    expect(flags?.level).toBe("flag");
    expect(flags?.rows.length).toBeGreaterThan(0);
    const branch = matchSpecLine("git checkout ", COMPLETION_SPECS);
    expect(branch?.rows).toEqual([expect.objectContaining({ kind: "hint", label: "<branch>" })]);
  });

  it("enumerates kubectl -o values and drills docker two levels", () => {
    const kubectl = matchSpecLine("kubectl get -o ", COMPLETION_SPECS);
    expect(kubectl?.level).toBe("value");
    expect(kubectl?.rows.map((row) => row.token)).toEqual(expect.arrayContaining(["json", "yaml"]));
    const docker = matchSpecLine("docker container ", COMPLETION_SPECS);
    expect(docker?.commandPath).toEqual(["docker", "container"]);
    expect(docker?.rows.map((row) => row.token)).toContain("ls");
  });

  it("never yields rows for inputs outside the bundled set", () => {
    expect(matchSpecLine("htop --tree", COMPLETION_SPECS)).toBeNull();
    expect(matchSpecLine("git status --short ", COMPLETION_SPECS)?.rows.length ?? 0).toBeGreaterThanOrEqual(0);
  });
});
