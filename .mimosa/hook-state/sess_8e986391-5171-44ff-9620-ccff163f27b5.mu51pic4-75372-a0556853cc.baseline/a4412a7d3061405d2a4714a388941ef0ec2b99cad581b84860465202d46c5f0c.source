// resolveRemotePath 单测（UI_SCAN R3-P2-4）：路径栏提交前的归一——`~` 展开
// （仅提供 home 时）、`.`/`..` 段消解、重复与尾斜杠折叠、非法 %-序列保留。
import { describe, expect, it } from "vitest";
import { resolveRemotePath } from "./remotePathInput";

describe("resolveRemotePath", () => {
  it("expands ~ to home when provided", () => {
    expect(resolveRemotePath("~", "/home/demo")).toBe("/home/demo");
    expect(resolveRemotePath("~/logs", "/home/demo")).toBe("/home/demo/logs");
  });

  it("keeps ~ literal when home is unknown (backend reports the error)", () => {
    expect(resolveRemotePath("~")).toBe("/~");
    expect(resolveRemotePath("~/x")).toBe("/~/x");
  });

  it("resolves .. segments against the path itself", () => {
    expect(resolveRemotePath("/home/demo/../etc")).toBe("/home/etc");
    expect(resolveRemotePath("/a/b/../../c")).toBe("/c");
  });

  it("clamps .. above the root to /", () => {
    expect(resolveRemotePath("/../etc")).toBe("/etc");
    expect(resolveRemotePath("/..")).toBe("/");
  });

  it("resolves . segments and collapses duplicate/trailing slashes", () => {
    expect(resolveRemotePath("/home/./demo/")).toBe("/home/demo");
    expect(resolveRemotePath("//var//log///")).toBe("/var/log");
  });

  it("prefixes a leading slash for bare input", () => {
    expect(resolveRemotePath("var/log")).toBe("/var/log");
  });

  it("trims whitespace and keeps the root as-is", () => {
    expect(resolveRemotePath("  /  ")).toBe("/");
    expect(resolveRemotePath("/")).toBe("/");
  });

  it("keeps undecodable %-sequences intact for the backend to reject", () => {
    expect(resolveRemotePath("/a/%ZZ")).toBe("/a/%ZZ");
  });

  it("decodes valid percent-escapes", () => {
    expect(resolveRemotePath("/my%20files")).toBe("/my files");
  });
});
