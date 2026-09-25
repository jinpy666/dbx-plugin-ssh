import { describe, expect, it } from "vitest";
import { mergeQuickCommandImport, parseQuickCommandImport } from "./quickCommandImport";
import type { QuickCommand } from "./quickCommands";

const EXISTING: QuickCommand[] = [
  { id: "a", name: "磁盘", command: "df -h" },
  { id: "b", name: "uptime", command: "uptime" },
];

describe("parseQuickCommandImport", () => {
  it("parses a plain JSON array of {name, command}", () => {
    const plan = parseQuickCommandImport(JSON.stringify([
      { name: "日志", command: "tail -f /var/log/syslog" },
      { command: "whoami" },
    ]));
    expect(plan.items).toEqual([
      { name: "日志", command: "tail -f /var/log/syslog" },
      { name: "whoami", command: "whoami" },
    ]);
    expect(plan.invalid).toBe(0);
    expect(plan.duplicates).toBe(0);
  });

  it("maps Tabby snippet export shape (snippets array, title/cmd aliases)", () => {
    const plan = parseQuickCommandImport(JSON.stringify({
      snippets: [
        { id: "1", title: "Docker PS", command: "docker ps" },
        { id: "2", name: "端口", cmd: "ss -tlnp" },
      ],
    }));
    expect(plan.items).toEqual([
      { name: "Docker PS", command: "docker ps" },
      { name: "端口", command: "ss -tlnp" },
    ]);
  });

  it("counts items without a command as invalid", () => {
    const plan = parseQuickCommandImport(JSON.stringify([
      { name: "空" },
      "not-an-object",
      null,
      { name: "ok", command: "ls" },
    ]));
    expect(plan.items).toEqual([{ name: "ok", command: "ls" }]);
    expect(plan.invalid).toBe(3);
  });

  it("deduplicates same names case-insensitively within the input", () => {
    const plan = parseQuickCommandImport(JSON.stringify([
      { name: "Clean", command: "echo 1" },
      { name: " clean ", command: "echo 2" },
      { name: "CLEAN", command: "echo 3" },
    ]));
    expect(plan.items).toEqual([{ name: "Clean", command: "echo 1" }]);
    expect(plan.duplicates).toBe(2);
  });

  it("reports invalid = -1 for non-JSON or unsupported top level shapes", () => {
    expect(parseQuickCommandImport("{not json").invalid).toBe(-1);
    expect(parseQuickCommandImport(JSON.stringify({ name: "x", command: "y" })).invalid).toBe(-1);
    expect(parseQuickCommandImport("42").invalid).toBe(-1);
  });

  it("truncates names/commands and stops at the global cap", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ name: `p${index}`, command: "echo hi" }));
    const plan = parseQuickCommandImport(JSON.stringify(many));
    expect(plan.items).toHaveLength(20);
    const long = parseQuickCommandImport(JSON.stringify([{ name: "n".repeat(80), command: "c".repeat(600) }]));
    expect(long.items[0]?.name).toHaveLength(60);
    expect(long.items[0]?.command).toHaveLength(500);
  });
});

describe("mergeQuickCommandImport", () => {
  it("skips entries whose name matches the existing list (case-insensitive)", () => {
    const plan = parseQuickCommandImport(JSON.stringify([
      { name: "UPTIME", command: "uptime -p" },
      { name: "新建", command: "ls -la" },
    ]));
    const merge = mergeQuickCommandImport(EXISTING, plan);
    expect(merge.accepted).toEqual([{ name: "新建", command: "ls -la" }]);
    expect(merge.skippedExisting).toBe(1);
    expect(merge.overflow).toBe(0);
  });

  it("keeps only the first N items that fit the remaining slots (overflow counted)", () => {
    // 解析阶段已按全局上限截断（见上条用例），所以合并最多看到 20 条：
    // 剩余 18 个槽位全填满，其余 2 条计入 overflow（导入前 N 条策略）。
    const plan = parseQuickCommandImport(JSON.stringify(
      Array.from({ length: 25 }, (_, index) => ({ name: `p${index}`, command: "echo hi" })),
    ));
    const merge = mergeQuickCommandImport(EXISTING, plan);
    expect(merge.accepted).toHaveLength(18);
    expect(merge.overflow).toBe(2);
    expect(merge.skippedExisting).toBe(0);
  });

  it("returns nothing when the list is already full", () => {
    const full: QuickCommand[] = Array.from({ length: 20 }, (_, index) => ({ id: `x${index}`, name: `n${index}`, command: "echo" }));
    const plan = parseQuickCommandImport(JSON.stringify([{ name: "new", command: "ls" }]));
    const merge = mergeQuickCommandImport(full, plan);
    expect(merge.accepted).toEqual([]);
    expect(merge.overflow).toBe(1);
  });
});
