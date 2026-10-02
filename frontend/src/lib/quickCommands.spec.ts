import { describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  filterQuickCommands,
  loadQuickCommandsFromStore,
  persistQuickCommands,
  QUICK_COMMANDS_STORE_KEY,
  quickCommandText,
} from "./quickCommands";

const LIST = [
  { id: "1", name: "日志", command: "tail -f /var/log/nginx.log" },
  { id: "2", name: "Docker PS", command: "docker ps --format wide" },
  { id: "3", name: "端口", command: "netstat -tlnp | grep :8888" },
];

describe("filterQuickCommands", () => {
  it("returns everything for an empty/blank query", () => {
    expect(filterQuickCommands(LIST, "")).toHaveLength(3);
    expect(filterQuickCommands(LIST, "   ")).toHaveLength(3);
  });

  it("matches name and command case-insensitively", () => {
    expect(filterQuickCommands(LIST, "docker")).toHaveLength(1);
    expect(filterQuickCommands(LIST, "日志")[0]?.id).toBe("1");
    expect(filterQuickCommands(LIST, "8888")[0]?.id).toBe("3");
  });

  it("returns [] when nothing matches", () => {
    expect(filterQuickCommands(LIST, "no-such-thing")).toEqual([]);
  });

  it("tolerates an empty list", () => {
    expect(filterQuickCommands([], "x")).toEqual([]);
  });
});

describe("quickCommandText", () => {
  it("preserves multi-line commands as PTY Enter keystrokes and trims", () => {
    expect(quickCommandText("docker ps\n")).toBe("docker ps");
    expect(quickCommandText("systemctl status nginx\r\n")).toBe("systemctl status nginx");
    expect(quickCommandText("  echo a\necho b  ")).toBe("echo a\recho b");
    expect(quickCommandText("echo a\r\necho b\recho c")).toBe("echo a\recho b\recho c");
    expect(quickCommandText(["echo \\", "--flag value"].join("\n"))).toBe("echo \\\r--flag value");
  });
  it("returns empty string for blank input", () => {
    expect(quickCommandText(" \n ")).toBe("");
  });
});

describe("store-backed authority (存储迁移批 1)", () => {
  // 本文件的 store 断言依赖顺序：未落键 → null 的断言必须在首个 persist 之前
  // （pluginStore 模块缓存在同文件内跨用例存活，load 走缓存不回源）。
  it("loadQuickCommandsFromStore returns null while the key is absent (seed not yet applied)", () => {
    expect(loadQuickCommandsFromStore()).toBeNull();
  });

  it("persist then load round-trips a normalized list", () => {
    const stored = persistQuickCommands([
      { id: "1", name: "日志", command: "tail -f app.log" },
      { id: "2", name: "  ", command: "  " }, // 空命令行被 normalize 丢弃
    ]);
    expect(stored).toHaveLength(1);
    expect(loadQuickCommandsFromStore()).toEqual(stored);
  });

  it("treating an empty list as present prevents legacy resurrection after user clears all", () => {
    persistQuickCommands([]);
    expect(loadQuickCommandsFromStore()).toEqual([]);
  });

  it("corrupt JSON degrades to an empty list without re-triggering the seed", () => {
    // 键已存在（已迁移）时坏 JSON 不回退种子：否则清空后的旧 sidecar 数据会复活。
    pluginStore.setItem(QUICK_COMMANDS_STORE_KEY, "{not-json");
    expect(loadQuickCommandsFromStore()).toEqual([]);
  });
});
