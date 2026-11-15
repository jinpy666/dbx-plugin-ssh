// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { useMonitorPanel, type MonitorApi } from "./useMonitorPanel";

// 编排核心的单测（计划 §4-B4）：假 api + 手动 tick 定时器，场景全覆盖。
// 假 api 形状对齐 window.dbxPlugin 的 MonitorApi 子集；storage 用内存 Map 模拟
// KvBacking（宿主 storage 语义：字符串进出）。

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** 手动 tick 定时器：不依赖 fake timers，interval 行为逐 tick 确定（handler 为 async 时整轮 settle）。 */
function manualTimers() {
  const pending = new Set<() => unknown>();
  return {
    timers: {
      set: (handler: () => unknown) => {
        pending.add(handler);
        return handler;
      },
      clear: (handle: unknown) => void pending.delete(handle as () => unknown),
    },
    tick: async (times: number) => {
      for (let i = 0; i < times; i += 1) for (const handler of [...pending]) await handler();
    },
  };
}

function fakeApi(overrides: {
  invoke?: (method: string, params?: unknown) => Promise<unknown>;
  request?: (method: string, params?: unknown) => Promise<unknown>;
  openWorkbench?: MonitorApi["openWorkbench"];
  reopenConnection?: MonitorApi["reopenConnection"];
} = {}) {
  const invokeCalls: string[] = [];
  const requestCalls: string[] = [];
  const api: MonitorApi = {
    invoke: async (method, params) => {
      invokeCalls.push(`${method}:${JSON.stringify(params ?? {})}`);
      if (overrides.invoke) return overrides.invoke(method, params);
      if (method === "monitor/status") return { tasks: [] };
      if (method === "monitor/snapshot") return { samples: {} };
      return {};
    },
    request: async (method, params) => {
      requestCalls.push(`${method}:${JSON.stringify(params ?? {})}`);
      if (overrides.request) return overrides.request(method, params);
      return { connections: [] };
    },
    openWorkbench: overrides.openWorkbench,
    reopenConnection: overrides.reopenConnection,
  };
  return { api, invokeCalls, requestCalls };
}

const sshRows = [
  { id: "c-1", name: "web-01", dbType: "ssh", connected: true, providerId: "io.dbx.ssh.connection" },
  { id: "c-2", name: "db-01", dbType: "ssh", isConnected: true, providerId: "io.dbx.ssh.connection" },
];

const listSsh = (rows: unknown[] = sshRows) => async (method: string) => (method === "host.listConnections" ? { connections: rows } : {});

describe("useMonitorPanel", () => {
  it("restores watched set from storage and auto-starts tasks for watched connected servers (reconcile ①③)", async () => {
    const { api, invokeCalls, requestCalls } = fakeApi({ request: listSsh() });
    const storage = memoryStorage({ "ssh-monitor-watched": JSON.stringify({ version: 1, watched: { "c-1": { addedAt: 42 } } }) });
    const { timers } = manualTimers();
    const panel = useMonitorPanel({ api, storage, timers });
    await panel.start();

    expect(panel.watched.value).toEqual({ "c-1": { addedAt: 42 } });
    // watched∩connected（c-1）无任务 → monitor/start；c-2 未 watched 不启动。
    expect(invokeCalls).toContain("monitor/start:{\"connectionId\":\"c-1\"}");
    expect(invokeCalls.some((call) => call.startsWith("monitor/start:{\"connectionId\":\"c-2\"}"))).toBe(false);
    // provider-scoped 无参列连接 + 无参 status。
    expect(requestCalls).toContain("host.listConnections:{}");
    expect(invokeCalls).toContain("monitor/status:{}");
  });

  it("stops running tasks that are no longer watched (reconcile ④) and filters dbType", async () => {
    const { api, invokeCalls } = fakeApi({
      request: listSsh([...sshRows, { id: "pg-1", name: "postgres", dbType: "postgresql", connected: true }]),
      invoke: async (method) => {
        if (method === "monitor/status") return { tasks: [{ connectionId: "pg-1", state: "live", since: 1 }, { connectionId: "ghost", state: "live", since: 2 }] };
        return {};
      },
    });
    const { timers } = manualTimers();
    const panel = useMonitorPanel({ api, storage: memoryStorage(), timers });
    await panel.start();

    // dbType 过滤：非 ssh 连接不进面板连接列表。
    expect(panel.connections.value.map((row) => row.id)).toEqual(["c-1", "c-2"]);
    // 有任务但不在 watched（含 sidecar 残留条目）→ stop。
    expect(invokeCalls).toContain("monitor/stop:{\"connectionId\":\"ghost\"}");
    expect(invokeCalls).toContain("monitor/stop:{\"connectionId\":\"pg-1\"}");
  });

  it("stops the snapshot poll after 3 consecutive failures and lets refresh() resume it", async () => {
    let failuresLeft = 3;
    const { api, invokeCalls } = fakeApi({
      invoke: async (method) => {
        if (method === "monitor/snapshot" && failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("sidecar unavailable");
        }
        if (method === "monitor/snapshot") return { samples: {} };
        return {};
      },
    });
    const { timers, tick } = manualTimers();
    const panel = useMonitorPanel({ api, storage: memoryStorage(), timers });
    await panel.start(); // 启动即首轮 snapshot：第 1 次失败
    const snapshotCalls = () => invokeCalls.filter((call) => call.startsWith("monitor/snapshot")).length;
    const initialCalls = snapshotCalls();
    expect(panel.pollStopped.value).toBe(false);

    await tick(1); // 第 2 次失败：继续轮询
    expect(panel.pollStopped.value).toBe(false);
    await tick(1); // 第 3 次失败：停轮询置 pollStopped
    expect(panel.pollStopped.value).toBe(true);
    expect(snapshotCalls()).toBe(initialCalls + 2);

    await tick(3); // 定时器已摘除：不再触发 snapshot
    expect(snapshotCalls()).toBe(initialCalls + 2);

    await panel.refresh(); // 手动重试：恢复轮询并清 pollStopped
    expect(panel.pollStopped.value).toBe(false);
    expect(snapshotCalls()).toBe(initialCalls + 3);
    await tick(1); // 恢复后的定时器继续走
    expect(snapshotCalls()).toBe(initialCalls + 4);
  });

  it("retry issues stop then start for the same connection", async () => {
    const { api, invokeCalls } = fakeApi();
    const { timers } = manualTimers();
    const panel = useMonitorPanel({ api, storage: memoryStorage(), timers });
    await panel.start();

    await panel.retry("c-9");
    const stopIndex = invokeCalls.indexOf("monitor/stop:{\"connectionId\":\"c-9\"}");
    const startIndex = invokeCalls.indexOf("monitor/start:{\"connectionId\":\"c-9\"}");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(stopIndex);
  });

  it("toggleWatch persists the key, reopens disconnected servers and stop-then-removes on off", async () => {
    const reopenCalls: string[] = [];
    const { api, invokeCalls } = fakeApi({
      request: listSsh([sshRows[1], { id: "c-3", name: "off-01", dbType: "ssh", connected: false }]),
      reopenConnection: async (connectionId) => {
        reopenCalls.push(connectionId);
        return true;
      },
    });
    const storage = memoryStorage();
    const { timers } = manualTimers();
    const panel = useMonitorPanel({ api, storage, timers });
    await panel.start();

    // 加入未连接主机：写 watched + 尝试 reopenConnection 拉起；不立即 start（未连接）。
    await panel.toggleWatch("c-3", true);
    expect(Object.keys(panel.watched.value)).toContain("c-3");
    expect(reopenCalls).toEqual(["c-3"]);
    expect(invokeCalls.some((call) => call.startsWith("monitor/start:{\"connectionId\":\"c-3\"}"))).toBe(false);
    const persisted = JSON.parse(storage.getItem("ssh-monitor-watched") || "{}");
    expect(persisted.version).toBe(1);
    expect(persisted.watched["c-3"]).toBeTruthy();

    // 加入已连接主机：立即 reconcile → start。
    await panel.toggleWatch("c-2", true);
    expect(invokeCalls).toContain("monitor/start:{\"connectionId\":\"c-2\"}");

    // 移除：先 stop 再删键。
    await panel.toggleWatch("c-2", false);
    expect(invokeCalls).toContain("monitor/stop:{\"connectionId\":\"c-2\"}");
    expect(panel.watched.value["c-2"]).toBeUndefined();
    expect(JSON.parse(storage.getItem("ssh-monitor-watched") || "{}").watched["c-2"]).toBeUndefined();
  });

  it("probes privacy/refreshMs prefs from storage and clamps refresh-ms to the allowed set", async () => {
    const { api } = fakeApi();
    const storage = memoryStorage({ "ssh-monitor-privacy": "1", "ssh-monitor-refresh-ms": "30000" });
    const { timers } = manualTimers();
    const panel = useMonitorPanel({ api, storage, timers });
    await panel.start();
    expect(panel.privacy.value).toBe(true);
    expect(panel.refreshMs.value).toBe(30000);

    panel.togglePrivacy();
    expect(panel.privacy.value).toBe(false);
    expect(storage.getItem("ssh-monitor-privacy")).toBe("0");

    panel.setRefreshMs(7000);
    expect(panel.refreshMs.value).toBe(30000); // 非法值不采纳
    panel.setRefreshMs(2000);
    expect(panel.refreshMs.value).toBe(2000);
    expect(storage.getItem("ssh-monitor-refresh-ms")).toBe("2000");
  });
});
