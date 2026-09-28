// fig spec 归一化单测（Lane C）：上游宽松对象 → FigSpecRoot 纯数据。
// 全部离线：输入是手写内联对象，不 import 上游网络资源。
import { describe, expect, it } from "vitest";
import { normalizeFigSpec } from "./normalize";
import type { FigSpecRoot } from "./types";

describe("normalizeFigSpec", () => {
  it("把 Option.name 的 string | string[] 归一为 names（-- 前缀保留）并并入 aliases", () => {
    const spec = normalizeFigSpec({
      name: "git",
      options: [
        { name: "--verbose", description: "talk more" },
        { name: ["--branch", "-b"], description: "new branch", args: { name: "branch" } },
        { name: "-C", aliases: ["--cwd"], args: true },
      ],
    });
    expect(spec?.options).toEqual([
      { names: ["--verbose"], description: "talk more" },
      { names: ["--branch", "-b"], description: "new branch", args: { name: "branch" } },
      { names: ["-C", "--cwd"], args: {} },
    ]);
  });

  it("根 name 数组拆为主名 + aliases，重复别名去重", () => {
    const spec = normalizeFigSpec({ name: ["gh", "github"], aliases: ["gh"] });
    expect(spec).toEqual({ name: "gh", aliases: ["github", "gh"] });
  });

  it("generator 只留脚本声明：script 字符串包一层数组、splitOn 保留、postProcess 丢弃", () => {
    const spec = normalizeFigSpec({
      name: "git",
      args: [
        {
          name: "branch",
          generators: [
            { script: "git branch", splitOn: "\n", postProcess: (out: string) => out },
            { script: ["git", "branch", "--list"] },
            { template: "filepaths" },
          ],
        },
      ],
    });
    expect(spec?.args?.[0].generators).toEqual([
      { kind: "script", script: ["git branch"], splitOn: "\n" },
      { kind: "script", script: ["git", "branch", "--list"] },
    ]);
  });

  it("函数型 generator / 函数 suggestions 丢弃，对象 suggestions 投影 name", () => {
    const fn = () => ["a"];
    const spec = normalizeFigSpec({
      name: "git",
      args: [
        { name: "x", generators: fn },
        { name: "y", suggestions: [{ name: "oneline", description: "ignored" }, "raw", 42] },
        { name: "z", suggestions: fn },
      ],
    });
    expect(spec?.args?.[0].generators).toBeUndefined();
    expect(spec?.args?.[1].suggestions).toEqual(["oneline", "raw"]);
    expect(spec?.args?.[2].suggestions).toBeUndefined();
  });

  it("loadSpec / generateSpec 子命令保留原节点并记 generators: [] 空标记", () => {
    const spec = normalizeFigSpec({
      name: "aws",
      subcommands: [
        { name: "s3", description: "S3 (loadSpec 动态)", loadSpec: { type: "loaded" } },
        { name: "ec2", generateSpec: async () => [] },
        { name: "iam", description: "静态子命令" },
      ],
    });
    expect(spec?.subcommands).toHaveLength(3);
    expect(spec?.subcommands?.[0]).toMatchObject({ name: "s3", description: "S3 (loadSpec 动态)", generators: [] });
    expect(spec?.subcommands?.[1]).toMatchObject({ name: "ec2", generators: [] });
    expect(spec?.subcommands?.[2]?.generators).toBeUndefined();
  });

  it("args 链保留完整有序（isOptional / isVariadic 原样标记），option args 数组取首个", () => {
    const spec = normalizeFigSpec({
      name: "remote",
      subcommands: [
        {
          name: "add",
          args: [{ name: "name" }, { name: "url", isOptional: false }, { name: "extra", isOptional: true, isVariadic: true }],
          options: [{ name: ["-t", "--track"], args: [{ name: "branch" }, { name: "ignored" }] }],
        },
      ],
    });
    expect(spec?.subcommands?.[0].args).toEqual([
      { name: "name" },
      { name: "url" },
      { name: "extra", isOptional: true, isVariadic: true },
    ]);
    expect(spec?.subcommands?.[0].options?.[0].args).toEqual({ name: "branch" });
  });

  it("子命令树不截深度（4 层全保留）", () => {
    const spec = normalizeFigSpec({
      name: "a",
      subcommands: [{ name: "b", subcommands: [{ name: "c", subcommands: [{ name: "d", subcommands: [{ name: "e" }] }] }] }],
    });
    expect(spec?.subcommands?.[0].subcommands?.[0].subcommands?.[0].subcommands?.[0].name).toBe("e");
  });

  it("isPersistent / isRepeatable / isRequired / 子命令 aliases 保留", () => {
    const spec = normalizeFigSpec({
      name: "kubectl",
      options: [{ name: "--context", isPersistent: true, args: { name: "name" } }],
      subcommands: [{ name: "config", aliases: ["view"], options: [{ name: "--allow-missing", isRequired: false }], isRepeatable: undefined }],
    });
    expect(spec?.options?.[0].isPersistent).toBe(true);
    expect(spec?.subcommands?.[0].aliases).toEqual(["view"]);
    expect(spec?.subcommands?.[0].options?.[0].isRequired).toBeUndefined();
  });

  it("非法输入（非对象 / 无 name / 空 name 数组）返回 null，且产出可序列化纯数据", () => {
    expect(normalizeFigSpec(null)).toBeNull();
    expect(normalizeFigSpec("git")).toBeNull();
    expect(normalizeFigSpec({ description: "no name" })).toBeNull();
    expect(normalizeFigSpec({ name: [] })).toBeNull();
    expect(normalizeFigSpec({ name: [""] })).toBeNull();

    const spec: FigSpecRoot | null = normalizeFigSpec({
      name: "git",
      subcommands: [{ name: "checkout", aliases: ["co"], options: [{ name: ["-b", "--branch"], args: true }] }],
    });
    // 纯数据断言（sync 写盘同款）：树中无函数值，序列化不含 "function"。
    const walk = (value: unknown): boolean => {
      if (typeof value === "function") return false;
      if (Array.isArray(value)) return value.every(walk);
      if (value && typeof value === "object") return Object.values(value).every(walk);
      return true;
    };
    expect(walk(spec)).toBe(true);
    expect(JSON.stringify(spec)).not.toContain("function");
  });

  it("同输入产出逐字节相同序列化（sync 幂等的前提）", () => {
    const input = {
      name: "git",
      options: [{ name: ["-b", "--branch"], description: "b", args: { name: "name" } }],
      subcommands: [{ name: "checkout", aliases: ["co"], args: [{ name: "branch", generators: [{ script: "git branch" }] }] }],
    };
    expect(JSON.stringify(normalizeFigSpec(input))).toBe(JSON.stringify(normalizeFigSpec(input)));
  });
});
