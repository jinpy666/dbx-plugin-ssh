import { describe, expect, it } from "vitest";
import { CONNECT_LOG_LIMIT, createConnectLog } from "./connectLog";

describe("createConnectLog", () => {
  it("pushes entries newest-first with timestamp and level", () => {
    const log = createConnectLog();
    log.push("info", "first");
    log.push("warn", "second");
    log.push("error", "third");
    expect(log.entries.value.map((entry) => entry.message)).toEqual(["third", "second", "first"]);
    expect(log.entries.value.map((entry) => entry.level)).toEqual(["error", "warn", "info"]);
    for (const entry of log.entries.value) expect(entry.ts).toBeGreaterThan(0);
  });

  it("caps the buffer at CONNECT_LOG_LIMIT and drops the oldest entries", () => {
    const log = createConnectLog();
    for (let index = 0; index < CONNECT_LOG_LIMIT + 25; index += 1) log.push("info", `entry-${index}`);
    expect(log.entries.value).toHaveLength(CONNECT_LOG_LIMIT);
    expect(log.entries.value[0].message).toBe(`entry-${CONNECT_LOG_LIMIT + 24}`);
    expect(log.entries.value[CONNECT_LOG_LIMIT - 1].message).toBe("entry-25");
  });

  it("clear() empties the buffer and later pushes still work", () => {
    const log = createConnectLog();
    log.push("info", "before");
    log.clear();
    expect(log.entries.value).toEqual([]);
    log.push("info", "after");
    expect(log.entries.value.map((entry) => entry.message)).toEqual(["after"]);
  });
});
