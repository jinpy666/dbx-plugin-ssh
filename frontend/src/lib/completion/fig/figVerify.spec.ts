// verify_fig_specs 纯检查函数单测（离线）：manifest 一致性 / 预算超限与裁剪序 /
// parser 冒烟函数。脚本本体以 main() 守卫保持可导入。
// @vitest-environment happy-dom（smokeParserEngine 引入 parser 产物）

import { describe, expect, it } from "vitest";
// @ts-expect-error — node 内建类型未在 tsconfig types 引入（types 限 vite/client）
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
// @ts-expect-error — 同上
import { tmpdir } from "node:os";
// @ts-expect-error — 同上
import { join } from "node:path";
// @ts-expect-error — scripts/verify_fig_specs.mjs 为无类型 Node 脚本（.mjs）
import * as verifyFigSpecs from "../../../../../scripts/verify_fig_specs.mjs";

const {
  checkBudgets,
  checkManifestConsistency,
  listBuildFiles,
  parseManifestImports,
  smokeParserEngine,
  PARSER_ENGINE_URL,
} = verifyFigSpecs as {
  checkBudgets: (args: {
    sizes: Record<string, number>;
    manifestNames: string[];
    maxTotalBytes: number;
    maxSpecBytes: number;
  }) => { errors: string[]; total: number; trimOrder: Array<{ name: string; bytes: number }> };
  checkManifestConsistency: (args: {
    manifestNames: string[];
    buildFiles: string[];
    snapshotAllowlist: string[];
  }) => string[];
  listBuildFiles: (dir: string) => Promise<string[]>;
  parseManifestImports: (source: string) => string[];
  smokeParserEngine: (url: string) => Promise<{ problems: string[] }>;
  PARSER_ENGINE_URL: string;
};

const manifestSource = [
  "// header",
  'import spec_git from "./build/git.js";',
  'import spec_aws_ec2 from "./build/aws/ec2.js";',
  "export const manifest = { git: spec_git };",
].join("\n");

describe("parseManifestImports", () => {
  it("提取静态 import 的 spec 名并去重排序", () => {
    expect(parseManifestImports(manifestSource)).toEqual(["aws/ec2", "git"]);
  });
  it("空输入 → 空数组", () => {
    expect(parseManifestImports("")).toEqual([]);
  });
});

describe("checkManifestConsistency", () => {
  const base = {
    manifestNames: ["git", "aws/ec2"],
    buildFiles: ["git.js", "aws/ec2.js"],
    snapshotAllowlist: ["git", "aws/ec2"],
  };

  it("三方一致 → 无错误", () => {
    expect(checkManifestConsistency(base)).toEqual([]);
  });

  it("manifest 引用缺失产物 / 多余产物 / allowlist 漂移各自报错", () => {
    const errors = checkManifestConsistency({
      manifestNames: ["git", "gone"],
      buildFiles: ["git.js", "orphan.js"],
      snapshotAllowlist: ["git", "other"],
    });
    expect(errors.join("\n")).toContain("build/gone.js");
    expect(errors.join("\n")).toContain("orphan.js");
    expect(errors.join("\n")).toContain("other");
  });
});

describe("checkBudgets", () => {
  const sizes = { big: 600 * 1024, mid: 300 * 1024, small: 10 * 1024, tiny: 5 * 1024 };
  const names = ["tiny", "small", "mid", "big"];

  it("预算内 → 无错误、无裁剪序", () => {
    const r = checkBudgets({ sizes, manifestNames: names, maxTotalBytes: 1024 * 1024, maxSpecBytes: 600 * 1024 });
    expect(r.errors).toEqual([]);
    expect(r.trimOrder).toEqual([]);
    expect(r.total).toBe(600 * 1024 + 300 * 1024 + 10 * 1024 + 5 * 1024);
  });

  it("单 spec 超限 → 报错且裁剪序按体积降序先列最大者", () => {
    const r = checkBudgets({ sizes, manifestNames: names, maxTotalBytes: 10 * 1024 * 1024, maxSpecBytes: 500 * 1024 });
    expect(r.errors.join("\n")).toContain("单 spec 超限: big");
    expect(r.trimOrder.map((e: { name: string }) => e.name)).toEqual(["big"]);
  });

  it("总量超限 → 裁剪序从最大逐个列出直至预算内", () => {
    const r = checkBudgets({ sizes, manifestNames: names, maxTotalBytes: 400 * 1024, maxSpecBytes: 600 * 1024 });
    expect(r.errors.join("\n")).toContain("语料总量超限");
    expect(r.trimOrder.map((e: { name: string }) => e.name)).toEqual(["big"]);
    // 剔除 big 后剩余 315KB ≤ 400KB → 不再裁
    expect(r.trimOrder).toHaveLength(1);
  });

  it("缺 sizes 的 manifest 名按无体积处理（不计总量）", () => {
    const r = checkBudgets({ sizes: {}, manifestNames: names, maxTotalBytes: 1024, maxSpecBytes: 1 });
    expect(r.total).toBe(0);
    expect(r.trimOrder).toEqual([]);
  });
});

describe("smokeParserEngine（bundled parser.js）", () => {
  it("内嵌 fixture：嵌套子命令 + 持久选项继承 + 根位建议标志 + 空 searchTerm", async () => {
    const { problems } = await smokeParserEngine(PARSER_ENGINE_URL);
    expect(problems).toEqual([]);
  });
});

describe("listBuildFiles", () => {
  it("递归列目录并以 POSIX 相对路径返回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figverify-"));
    try {
      await mkdir(join(dir, "aws"), { recursive: true });
      await writeFile(join(dir, "git.js"), "export default {}");
      await writeFile(join(dir, "aws", "ec2.js"), "export default {}");
      expect(await listBuildFiles(dir)).toEqual(["aws/ec2.js", "git.js"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
