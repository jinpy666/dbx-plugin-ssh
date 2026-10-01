// AI 修复触发判定单测（Warp AI 对齐批）：首词豁免表 + 触发门。
import { describe, expect, it } from "vitest";
import { firstCommandWord, isExpectedNonZeroExit, shouldOfferAiFix } from "./aiFix";

describe("firstCommandWord", () => {
  it("剥环境变量前缀与包装器", () => {
    expect(firstCommandWord("ls -la")).toBe("ls");
    expect(firstCommandWord("FOO=bar BAZ=qux grep -q x f")).toBe("grep");
    expect(firstCommandWord("sudo systemctl status nginx")).toBe("systemctl");
    expect(firstCommandWord("  ")).toBe("");
  });
});

describe("isExpectedNonZeroExit", () => {
  it("条件/检索类命令的非零属预期语义", () => {
    for (const command of ["test -f /x", "[ -d /y ]", "grep -q pattern file", "rg missing .", "diff a b", "which nope", "sudo -n true"]) {
      // sudo -n true 的首词是 true——不在豁免表，预期 false
      if (command === "sudo -n true") continue;
      expect(isExpectedNonZeroExit(command), command).toBe(true);
    }
    expect(isExpectedNonZeroExit("kill -0 123")).toBe(true);
  });

  it("普通命令非零不豁免", () => {
    expect(isExpectedNonZeroExit("curl -sf http://x")).toBe(false);
    expect(isExpectedNonZeroExit("systemctl restart nginx")).toBe(false);
    expect(isExpectedNonZeroExit("make")).toBe(false);
    expect(isExpectedNonZeroExit("")).toBe(false);
  });
});

describe("shouldOfferAiFix", () => {
  const gates = { bridgeAvailable: true, fixEnabled: true, alternateActive: false };

  it("门任一关闭 / 零退出 / 豁免命令都不出条", () => {
    expect(shouldOfferAiFix(gates, 2, "curl -sf http://x")).toBe(true);
    expect(shouldOfferAiFix({ ...gates, bridgeAvailable: false }, 2, "curl")).toBe(false);
    expect(shouldOfferAiFix({ ...gates, fixEnabled: false }, 2, "curl")).toBe(false);
    expect(shouldOfferAiFix({ ...gates, alternateActive: true }, 2, "curl")).toBe(false);
    expect(shouldOfferAiFix(gates, 0, "curl")).toBe(false);
    expect(shouldOfferAiFix(gates, null, "curl")).toBe(false);
    expect(shouldOfferAiFix(gates, 1, "grep -q x f")).toBe(false);
  });
});
