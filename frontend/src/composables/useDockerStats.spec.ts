// @vitest-environment happy-dom
// docker stats 趋势环缓冲的接线测试：轮询成功才入点、换容器集合清空、
// 容量封顶。轮询定时器用超长间隔避免真实 tick，直接手动 refresh。
import { describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useDockerStats, DOCKER_STATS_INTERVAL_MS } from "./useDockerStats";
import { DOCKER_STATS_HISTORY_CAPACITY } from "../lib/dockerStats";

function payload(sampledAt: number, cpuPercent: number) {
  return {
    available: true,
    needsSudo: false,
    sampledAt,
    stats: [
      {
        containerId: "c1",
        name: "web",
        cpuPercent,
        memBytes: 512,
        memLimitBytes: 1024,
        memPercent: 50,
        netRxBytes: 100,
        netTxBytes: 20,
        blockReadBytes: 0,
        blockWriteBytes: 0,
        pids: 3,
      },
    ],
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) await Promise.resolve();
  await nextTick();
}

function setup() {
  const ids = ref(["c1"]);
  const enabled = ref(true);
  let sampledAt = 1_000;
  let cpu = 10;
  const invoke = vi.fn(async (method: string) => {
    if (method !== "docker/stats") throw new Error(`unexpected ${method}`);
    const payloadValue = payload(sampledAt, cpu);
    sampledAt += DOCKER_STATS_INTERVAL_MS;
    cpu += 5;
    return payloadValue;
  });
  const scope = effectScope();
  const api = scope.run(() =>
    useDockerStats({
      containerIds: () => ids.value,
      params: () => ({ target: "local" }),
      enabled: () => enabled.value,
      invoke,
      intervalMs: 24 * 60 * 60 * 1000,
      now: () => sampledAt,
    }),
  );
  if (!api) throw new Error("scope did not run");
  return { ...api, ids, enabled, invoke, scope };
}

describe("useDockerStats history", () => {
  it("records one point per successful poll", async () => {
    const { history, refresh, scope } = setup();
    await settle();
    expect(history.value).toHaveLength(1);
    await refresh();
    await settle();
    expect(history.value).toHaveLength(2);
    expect(history.value.map((point) => point.cpuPercent)).toEqual([10, 15]);
    scope.stop();
  });

  it("caps the window at the documented capacity", async () => {
    const { history, refresh, scope } = setup();
    await settle();
    for (let index = 0; index < DOCKER_STATS_HISTORY_CAPACITY + 4; index += 1) {
      await refresh();
      await settle();
    }
    expect(history.value).toHaveLength(DOCKER_STATS_HISTORY_CAPACITY);
    scope.stop();
  });

  it("clears the trend when the watched container set changes", async () => {
    const { history, ids, enabled, scope } = setup();
    await settle();
    expect(history.value.length).toBeGreaterThan(0);
    enabled.value = false;
    await settle();
    ids.value = ["c2"];
    await settle();
    expect(history.value).toEqual([]);
    scope.stop();
  });

  it("keeps the previous trend when a poll fails", async () => {
    const { history, invoke, refresh, scope } = setup();
    await settle();
    const before = history.value.length;
    invoke.mockRejectedValueOnce(new Error("daemon hiccup"));
    await refresh();
    await settle();
    expect(history.value).toHaveLength(before);
    expect(history.value[0].cpuPercent).toBe(10);
    scope.stop();
  });
});
