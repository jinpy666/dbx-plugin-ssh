import { describe, expect, it } from "vitest";
import {
  createStartupEntry,
  mergeStartupStore,
  normalizeStartupConfig,
  normalizeStartupEntry,
  serializeStartupConfig,
  STARTUP_COMMAND_MAX,
  STARTUP_COMMAND_MAX_BYTES,
  STARTUP_DELAY_DEFAULT_MS,
  STARTUP_DELAY_MAX_MS,
  truncateUtf8,
  utf8ByteLength,
  type StartupCommandsConfig,
} from "./startupCommands";

describe("startup commands editor semantics", () => {
  it("defaults to off with no rows for missing or malformed stores", () => {
    // 主开关缺省关；无 store / 非对象 / 缺桶一律按空配置处理。
    for (const raw of [undefined, null, "junk", 42, {}, { commands: "nope" }]) {
      const config = normalizeStartupConfig(raw);
      expect(config.enabled).toBe(false);
      expect(config.commands).toEqual([]);
    }
  });

  it("normalizes rows: defaults, clamps, strips trailing newline, keeps disabled rows", () => {
    const config = normalizeStartupConfig({
      enabled: true,
      commands: [
        { command: "cd /var/log" },
        { command: "echo 5", delayMs: 5 },
        { command: "echo capped", delayMs: 99_999 },
        { command: "echo invalid", delayMs: "abc" },
        { command: "echo off", enabled: false },
        { command: "echo cr\r\n" },
        { command: "   " },
        "junk",
        { delayMs: 10 },
      ],
    });
    expect(config.enabled).toBe(true);
    expect(config.commands).toEqual([
      { command: "cd /var/log", delayMs: STARTUP_DELAY_DEFAULT_MS, enabled: true },
      { command: "echo 5", delayMs: 5, enabled: true },
      { command: "echo capped", delayMs: STARTUP_DELAY_MAX_MS, enabled: true },
      { command: "echo invalid", delayMs: STARTUP_DELAY_DEFAULT_MS, enabled: true },
      // 禁用行保留（编辑器要能回显并重新打开）。
      { command: "echo off", delayMs: STARTUP_DELAY_DEFAULT_MS, enabled: false },
      // 注入自带回车：结尾 CR/LF 剥掉。
      { command: "echo cr", delayMs: STARTUP_DELAY_DEFAULT_MS, enabled: true },
    ]);
    // 纯空白 / 非对象 / 缺命令的行剔除；顺序保持。
    expect(config.commands.some((entry) => entry.command.trim().length === 0)).toBe(false);
  });

  it("caps the row count at the sidecar limit", () => {
    const commands = Array.from({ length: STARTUP_COMMAND_MAX + 10 }, (_unused, index) => ({
      command: `echo ${index}`,
    }));
    expect(normalizeStartupConfig({ enabled: true, commands }).commands.length).toBe(STARTUP_COMMAND_MAX);
  });

  it("truncates oversized commands on UTF-8 boundaries", () => {
    const multibyte = "界".repeat(STARTUP_COMMAND_MAX_BYTES); // 3 bytes each
    const entry = normalizeStartupEntry({ command: multibyte });
    expect(entry).not.toBeNull();
    expect(utf8ByteLength(entry!.command)).toBeLessThanOrEqual(STARTUP_COMMAND_MAX_BYTES);
    expect(utf8ByteLength(entry!.command) % 3).toBe(0);
    // ASCII 超长同样截断。
    const ascii = "x".repeat(STARTUP_COMMAND_MAX_BYTES + 100);
    expect(utf8ByteLength(normalizeStartupEntry({ command: ascii })!.command)).toBe(STARTUP_COMMAND_MAX_BYTES);
    expect(truncateUtf8("short", STARTUP_COMMAND_MAX_BYTES)).toBe("short");
  });

  it("serializes to the sidecar persisted shape", () => {
    const config: StartupCommandsConfig = {
      enabled: true,
      commands: [
        createStartupEntry(),
        { command: "echo off", delayMs: 99_999, enabled: false },
      ],
    };
    expect(serializeStartupConfig(config)).toEqual({
      enabled: true,
      commands: [
        { command: "", delayMs: STARTUP_DELAY_DEFAULT_MS, enabled: true },
        { command: "echo off", delayMs: STARTUP_DELAY_MAX_MS, enabled: false },
      ],
    });
    // 往返：serialize → normalize 幂等（空命令行在重载时剔除、延迟钳制生效）。
    const roundTrip = normalizeStartupConfig(serializeStartupConfig(config));
    expect(roundTrip).toEqual({
      enabled: true,
      commands: [
        { command: "echo off", delayMs: STARTUP_DELAY_MAX_MS, enabled: false },
      ],
    });
  });

  it("merges per connection without touching other connections' buckets", () => {
    const store = {
      "conn-a": { enabled: true, commands: [{ command: "echo a" }] },
      "conn-b": { enabled: false, commands: [] },
    };
    const merged = mergeStartupStore(
      store,
      "conn-a",
      { enabled: true, commands: [{ command: "echo new", delayMs: 1, enabled: true }] },
    );
    // 本连接整桶替换。
    expect(merged["conn-a"]).toEqual({
      enabled: true,
      commands: [{ command: "echo new", delayMs: 1, enabled: true }],
    });
    // 其他连接原样保留（浅拷贝：顶层换新对象，未触碰的桶保持同一值）。
    expect(merged).not.toBe(store);
    expect(merged["conn-b"]).toEqual(store["conn-b"]);
    // 旧 store 缺失 / 形状非法 → 只剩本连接（传入的开关态原样写入）。
    expect(mergeStartupStore(undefined, "conn-c", { enabled: true, commands: [] })).toEqual({
      "conn-c": { enabled: true, commands: [] },
    });
    expect(mergeStartupStore("junk", "conn-c", { enabled: true, commands: [] })["conn-c"])
      .toEqual({ enabled: true, commands: [] });
  });

  it("creates fresh enabled rows with the default delay", () => {
    expect(createStartupEntry()).toEqual({
      command: "",
      delayMs: STARTUP_DELAY_DEFAULT_MS,
      enabled: true,
    });
  });
});
