// FigCompletionSource fixture 断言（全离线）：手造 manifest 驱动全部分支
// （嵌套/loadSpec 链/持久选项/--/flag=value/generator 位置/异常吞掉/命令名
// 补全），另附真实 git 语料冒烟。编辑边界、source 标签与 pass-through 语义
// 对齐 fig/source.ts 冻结契约。
// @vitest-environment happy-dom（经 figCompletionSource 引入 parser 产物）

import { describe, expect, it } from "vitest";
import {
  FigCompletionSourceImpl,
  createFigCompletionSource,
} from "./figCompletionSource";
import type { FigSpecManifest, FigSourceRequest } from "./source";

const baseRequest = (line: string): FigSourceRequest => ({
  line,
  requestId: 7,
  revision: 42,
  sessionId: "sess-1",
  trigger: "typing",
});

// ---- 手造 Fig spec 语料（数据形态与 withfig 语料一致） ---------------------

const specCommit = {
  name: ["commit"],
  description: "record changes",
  subcommands: [],
  options: [
    { name: ["-m", "--message"], description: "message", args: [{ name: "msg", isOptional: true }] },
    { name: ["--amend"], description: "amend" },
  ],
  persistentOptions: [],
  args: [],
};
const specStatus = {
  name: ["status"],
  description: "show status",
  subcommands: [],
  options: [{ name: ["--short"], description: "short format" }],
  persistentOptions: [],
  args: [],
};
const specCheckout = {
  name: ["checkout", "co"],
  description: "switch branches",
  subcommands: [],
  options: [{ name: ["-b"], description: "new branch", args: [{ name: "branch" }] }],
  persistentOptions: [],
  args: [],
};
const fixtureMyGit = {
  name: ["mygit"],
  description: "fixture git",
  // 数组形态：验证上游 convertSubcommand 的 record 化路径；
  // 持久选项遵循 Fig 数据约定：options 数组内 isPersistent: true（上游
  // convertSubcommand 据此分流到 persistentOptions，独立字段会被忽略）。
  subcommands: [specCommit, specStatus, specCheckout],
  options: [
    { name: ["--no-pager"], description: "no pager" },
    { name: ["--verbose"], description: "verbose output", isPersistent: true },
  ],
  parserDirectives: {},
  args: [{ name: "alias", isOptional: true, suggestions: [{ name: "init-all", description: "init" }] }],
};
const fixtureVariadic = {
  name: ["mycat"],
  subcommands: [],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [
    {
      name: "files",
      isVariadic: true,
      suggestions: [
        { name: "a.txt" },
        { name: "b.log", type: "file" },
        { name: "build", type: "folder" },
      ],
    },
  ],
};
const fixtureGeneratorArg = {
  // currentArg.generators 非空 → 批次 1 pass-through
  name: ["mykubectl"],
  subcommands: [],
  options: [{ name: ["--context"] }],
  persistentOptions: [],
  parserDirectives: {},
  args: [{ name: "resource", generators: [{ template: "filepaths" }] }],
};
const fixtureBranchGen = {
  // 声明式 generator（script argv + splitOn + postProcess）→ 批次 2-1
  // collectGenerators 产槽位；静态 suggestions 照常先行（两段渲染）。
  name: ["mybranch"],
  subcommands: [],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [
    {
      name: "branch",
      isOptional: true,
      suggestions: [{ name: "HEAD", description: "detached" }],
      generators: [
        {
          script: ["git", "branch", "--format=%(refname:short)"],
          splitOn: "\n",
          postProcess: (out: string) =>
            out
              .split("\n")
              .filter((line) => line.length > 0)
              .map((name) => ({ name, description: "branch" })),
        },
      ],
    },
  ],
};
const fixtureMixedScripts = {
  // 非声明式 script 形态（字符串 shell / 函数 custom / 混型 / template）：
  // §16 allowShellScript=false + 批次 3 边界 → 不产槽位。
  name: ["myshell"],
  subcommands: [],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [
    {
      name: "x",
      isOptional: true,
      generators: [
        { script: "git branch | grep main" },
        { script: () => ["a"] },
        { script: ["git", 1] },
        { template: "filepaths" },
      ],
    },
  ],
};
const fixtureGenerateSpec = {
  // completionObj.generateSpec 函数 → 动态 spec 面 → pass-through
  name: ["mydyn"],
  subcommands: [],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [],
  generateSpec: (_tokens: unknown) => ({}),
};
const fixtureLoadSpecFn = {
  // loadSpec 函数形态（宿主/exec 语义）→ pass-through
  name: ["myfunc"],
  subcommands: [{ name: ["down"], subcommands: [], options: [], persistentOptions: [], args: [] }],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [],
  loadSpec: (token: string) => token,
};
const fixtureAws = {
  // 跨 spec loadSpec 字符串引用（aws/ec2 形态）
  name: ["myaws"],
  subcommands: [
    { name: ["ec2"], description: "ec2 root", loadSpec: "myaws/ec2" },
    { name: ["gone"], loadSpec: "myaws/missing" },
  ],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [],
};
const specEc2 = {
  name: ["ec2"],
  subcommands: [{ name: ["describe-instances"], description: "describe" }],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [],
};
const fixtureSudo = {
  // isCommand 参数位（sudo 形态）：末位命令名补全 + 中段 spec 换轨
  name: ["mysudo"],
  subcommands: [],
  options: [],
  persistentOptions: [],
  parserDirectives: {},
  args: [{ name: "command", isCommand: true, isOptional: true }],
};
const fixtureBroken = {
  // 枚举时访问 options 抛错 → resolve 顶层吞掉返 null
  name: ["mybroken"],
  get options(): Record<string, unknown> {
    throw new Error("poisoned options");
  },
  subcommands: {},
  persistentOptions: {},
  parserDirectives: {},
  args: [],
};
const fixtureManifest = {
  mygit: fixtureMyGit,
  mycat: fixtureVariadic,
  mykubectl: fixtureGeneratorArg,
  mybranch: fixtureBranchGen,
  myshell: fixtureMixedScripts,
  mydyn: fixtureGenerateSpec,
  myfunc: fixtureLoadSpecFn,
  myaws: fixtureAws,
  "myaws/ec2": specEc2,
  mysudo: fixtureSudo,
  mybroken: fixtureBroken,
} as unknown as FigSpecManifest;

const makeSource = () => new FigCompletionSourceImpl({ manifest: fixtureManifest });

const itemLabels = (response: { items: Array<{ label: string }> } | null) =>
  (response?.items ?? []).map((i) => i.label);

// ---- 用例 -------------------------------------------------------------------

describe("FigCompletionSource（fixture manifest）", () => {
  const source = makeSource();

  it("空行/纯空白 → pass-through", () => {
    expect(source.resolve(baseRequest(""))).toBeNull();
    expect(source.resolve(baseRequest("   "))).toBeNull();
  });

  it("无 spec 命中 → pass-through（不造假候选）", () => {
    expect(source.resolve(baseRequest("nosuchcmd --x"))).toBeNull();
  });

  it("嵌套子命令 + 数组形态 subcommands 归一化：mygit <空> → 全部子命令 + 持久选项", () => {
    const res = source.resolve(baseRequest("mygit "));
    expect(res).not.toBeNull();
    expect(res?.state).toBe("ready");
    expect(res?.requestId).toBe(7);
    expect(res?.revision).toBe(42);
    const labelsList = itemLabels(res);
    expect(labelsList).toContain("commit");
    expect(labelsList).toContain("status");
    expect(labelsList).toContain("checkout");
    expect(labelsList).toContain("--verbose"); // 持久选项在根位也可候选
    const commitItem = res?.items.find((i) => i.label === "commit");
    expect(commitItem?.kind).toBe("subcommand");
    expect(commitItem?.source).toBe("fig-spec");
    expect(commitItem?.description).toBe("record changes");
  });

  it("searchTerm 前缀过滤与行尾编辑边界（checkout 别名名数组取首个）", () => {
    const res = source.resolve(baseRequest("mygit che"));
    const labelsList = itemLabels(res);
    expect(labelsList).toEqual(["checkout"]);
    const item = res?.items[0];
    expect(item?.edit).toMatchObject({
      text: "checkout ",
      replaceStart: "mygit ".length,
      replaceEnd: "mygit che".length,
    });
    expect(item?.edit.cursorOffset).toBe("mygit checkout ".length);
    expect(res?.context?.tokenStart).toBe("mygit ".length);
    expect(res?.context?.tokenEnd).toBe("mygit che".length);
    expect(res?.context?.commandPath).toEqual(["mygit"]);
  });

  it("嵌套后选项来自子命令：mygit commit --am<空> → --amend；- 前缀含短/长选项", () => {
    const amend = itemLabels(source.resolve(baseRequest("mygit commit --am")));
    expect(amend).toEqual(["--amend"]);
    const dash = itemLabels(source.resolve(baseRequest("mygit commit -")));
    expect(dash).toContain("-m");
    expect(dash).toContain("--message");
    expect(dash).toContain("--verbose"); // 持久选项继承后仍参与 "-" 前缀过滤
  });

  it("persistent 选项继承：mygit commit <空> 仍可候选 --verbose", () => {
    const labelsList = itemLabels(source.resolve(baseRequest("mygit commit ")));
    expect(labelsList).toContain("--verbose");
    expect(labelsList).toContain("-m");
    expect(labelsList).not.toContain("status"); // 进入参数区后子命令关闭
  });

  it("`--` 终结后只建议 args：mygit status -- <空>", () => {
    const res = source.resolve(baseRequest("mygit status -- "));
    const labelsList = itemLabels(res);
    expect(labelsList).not.toContain("--short");
    expect(labelsList).not.toContain("--verbose");
  });

  it("变参 arg 静态建议 + kind 映射（file/folder→directory）", () => {
    const res = source.resolve(baseRequest("mycat "));
    const labelsList = itemLabels(res);
    expect(labelsList).toEqual(["a.txt", "b.log", "build"]);
    const kinds = res?.items.map((i) => i.kind);
    expect(kinds).toEqual(["argument", "file", "directory"]);
  });

  it("变参位持续：mycat a.txt <空> 仍建议文件集（searchTerm 为空）", () => {
    const res = source.resolve(baseRequest("mycat a.txt "));
    expect(itemLabels(res)).toEqual(["a.txt", "b.log", "build"]);
  });

  it("generator 声明参数位：不执行 generator；静态候选照常，全动态位 → null", () => {
    // "mykubectl "：静态面仍有 --context 可候选（来自 parser 语义，非 generator）
    const res = source.resolve(baseRequest("mykubectl "));
    expect(itemLabels(res)).toEqual(["--context"]);
    // "mykubectl get po"：静态面无候选的纯 generator 位 → pass-through
    expect(source.resolve(baseRequest("mykubectl get po"))).toBeNull();
  });

  it("generateSpec 动态 spec 面 → 返回 null", () => {
    expect(source.resolve(baseRequest("mydyn "))).toBeNull();
  });

  it("loadSpec 函数形态 → 返回 null", () => {
    expect(source.resolve(baseRequest("myfunc down"))).toBeNull();
  });

  it("跨 spec loadSpec 字符串：myaws ec2 <空> → 换轨到 myaws/ec2 子命令候选", () => {
    const res = source.resolve(baseRequest("myaws ec2 "));
    const labelsList = itemLabels(res);
    expect(labelsList).toContain("describe-instances");
    expect(res?.context?.command).toBe("ec2");
  });

  it("loadSpec 引用缺失 → 换轨失败 pass-through（末 token 触发换轨路径）", () => {
    expect(source.resolve(baseRequest("myaws gone "))).toBeNull();
  });

  it("isCommand 参数位：mysudo <空> → manifest 命令名补全（kind=command）", () => {
    const res = source.resolve(baseRequest("mysudo "));
    const labelsList = itemLabels(res);
    expect(labelsList.length).toBeGreaterThan(0);
    expect(labelsList).toContain("mygit");
    const item = res?.items.find((i) => i.label === "mygit");
    expect(item?.kind).toBe("command");
    expect(item?.edit.replaceStart).toBe(item?.edit.replaceEnd);
    expect(item?.edit.replaceStart).toBe("mysudo ".length);
  });

  it("isCommand 参数位换轨：mysudo mygit <空> → mygit 根候选", () => {
    const labelsList = itemLabels(source.resolve(baseRequest("mysudo mygit ")));
    expect(labelsList).toContain("commit");
    expect(labelsList).toContain("--no-pager");
  });

  it("命令名补全：单 token 前缀命中 manifest（含精确名）", () => {
    const res = source.resolve(baseRequest("mygi"));
    expect(itemLabels(res)).toEqual(["mygit"]);
    const item = res?.items[0];
    expect(item?.kind).toBe("command");
    expect(item?.edit).toMatchObject({ text: "mygit ", replaceStart: 0, replaceEnd: 4 });
  });

  it("异常吞掉：spec 枚举抛错 → null（绝不上抛）", () => {
    expect(source.resolve(baseRequest("mybroken --x"))).toBeNull();
    expect(source.resolve(baseRequest("mybroken "))).toBeNull();
  });

  it("真实 git 语料冒烟（经 source 全链路）：git che → checkout", () => {
    const real = createFigCompletionSource();
    const res = real.resolve(baseRequest("git che"));
    expect(itemLabels(res)).toContain("checkout");
    const status = real.resolve(baseRequest("git status -- "));
    const labelsList = itemLabels(status);
    expect(labelsList).not.toContain("--short");
  });
});

describe("FigCompletionSource 防御性收敛", () => {
  it("manifest 注入空对象 → 一切 pass-through 而不抛", () => {
    const empty = createFigCompletionSource({ manifest: {} });
    expect(empty.resolve(baseRequest("git "))).toBeNull();
    expect(empty.resolve(baseRequest("g"))).toBeNull();
  });

  it("异常行（引号未闭合等）不外抛", () => {
    const source = makeSource();
    expect(source.resolve(baseRequest('mygit commit -m "未闭合'))).not.toBeUndefined();
    expect(source.resolve(baseRequest("mygit 'a b"))).not.toBeUndefined();
  });
});

describe("FigCompletionSource · 声明式 generator 槽位（批次 2-1 collectGenerators）", () => {
  const source = makeSource();

  it("script argv/splitOn/postProcess + 位置上下文产出槽位", () => {
    const slots = source.collectGenerators(baseRequest("mybranch ma"));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      script: ["git", "branch", "--format=%(refname:short)"],
      splitOn: "\n",
      command: "mybranch",
      commandPath: ["mybranch"],
      prefix: "ma",
      tokenStart: "mybranch ".length,
      tokenEnd: "mybranch ma".length,
    });
    expect(typeof slots[0].postProcess).toBe("function");
  });

  it("纯 generator 位：resolve 仍 null（冻结同步面不变），槽位照常产出", () => {
    expect(source.resolve(baseRequest("mybranch ma"))).toBeNull();
    expect(source.collectGenerators(baseRequest("mybranch ma"))).toHaveLength(1);
  });

  it("静态 + generator 并存：静态候选照常 ready，槽位并行产出（两段渲染基座）", () => {
    const res = source.resolve(baseRequest("mybranch "));
    expect(itemLabels(res)).toContain("HEAD");
    const slots = source.collectGenerators(baseRequest("mybranch "));
    expect(slots).toHaveLength(1);
    expect(slots[0].prefix).toBe("");
    expect(slots[0].tokenStart).toBe("mybranch ".length);
    expect(slots[0].tokenEnd).toBe("mybranch ".length);
  });

  it("非声明式 script 形态（字符串 shell/函数/混型/template）不产槽位", () => {
    expect(source.collectGenerators(baseRequest("myshell x"))).toEqual([]);
  });

  it("无 generator 位置 / 无 spec 命中 → []", () => {
    expect(source.collectGenerators(baseRequest("mygit che"))).toEqual([]);
    expect(source.collectGenerators(baseRequest("nosuchcmd x"))).toEqual([]);
    expect(source.collectGenerators(baseRequest("mykubectl get po"))).toEqual([]); // template 生成器不产槽位
  });

  it("异常行不外抛（spec 枚举抛错 / 引号未闭合）→ []", () => {
    expect(source.collectGenerators(baseRequest("mybroken --x"))).toEqual([]);
    expect(source.collectGenerators(baseRequest('mygit commit -m "未闭合'))).toEqual([]);
  });
});
