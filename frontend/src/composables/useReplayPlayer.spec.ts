// @vitest-environment happy-dom
// 回放播放器（自 useRecording 下沉）回归守卫：分页拉全与 2 万事件封顶、
// 请求序号守卫（晚到的旧加载不得顶替新回放）、rAF 推进与倍速/seek 的
// 墙钟重锚定。无 replayHost 时播放器走纯状态机（replayTerminal 为 null，
// write 空安全），正好覆盖时间轴语义本身。

import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayPlayer } from "./useReplayPlayer";
import type { RecordingSummary, ReplayEventPage } from "../lib/replayScheduler";

function mount(invokeHandlers?: { firstDelayMs?: number }) {
  const summary: RecordingSummary = { recordingId: "rec-1", host: "h1" };
  const invoke = vi.fn(async (method: string, params: { recordingId: string; offset: number }) => {
    if (method !== "ssh/recording/get") return undefined;
    const events = Array.from({ length: 20 }, (_, i) => ({
      time: (params.offset + i) / 10,
      type: "o",
      data: `e${params.offset + i}`,
    }));
    const total = 60;
    const hasMore = params.offset + 20 < total;
    // 仅第一条录制慢加载（两条 open 都请求 offset 0，不能按 offset 区分）。
    if (invokeHandlers?.firstDelayMs && params.recordingId === "rec-1") {
      await new Promise((resolve) => setTimeout(resolve, invokeHandlers.firstDelayMs));
    }
    return { events, total, hasMore } satisfies ReplayEventPage;
  });
  (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
  const player = useReplayPlayer({
    showError: vi.fn(),
    appearance: ref({ terminal: { fontSize: 14 } }),
    terminalTheme: () => ({ background: "#000000" }) as never,
    terminalFontOverride: ref({} as never),
    terminalAppearance: ref({ settings: {} } as never),
    hostFontFamily: () => "monospace",
  });
  return { player, summary, invoke };
}

/** 手动 rAF：注册回调并按需驱动一帧。 */
function stubRaf() {
  let pending: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    pending.push(cb);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => { pending = []; });
  return {
    frame() {
      const current = pending;
      pending = [];
      for (const cb of current) cb();
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

describe("useReplayPlayer loadReplayEvents", () => {
  it("merges pages until hasMore=false", async () => {
    const { player } = mount();
    const events = await player.loadReplayEvents("rec-1");
    expect(events).toHaveLength(60);
    expect(events[0]?.data).toBe("e0");
    expect(events.at(-1)?.data).toBe("e59");
  });

  it("stops at the 20k event cap even when the server offers more", async () => {
    const invoke = vi.fn(async (_method: string, params: { offset: number }) => ({
      events: Array.from({ length: 500 }, (_, i) => ({ time: (params.offset + i) / 10, type: "o", data: "x" })),
      total: 1_000_000,
      hasMore: true,
    }));
    (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
    const player = useReplayPlayer({
      showError: vi.fn(),
      appearance: ref({ terminal: { fontSize: 14 } }),
      terminalTheme: () => ({ background: "#000000" }) as never,
      terminalFontOverride: ref({} as never),
      terminalAppearance: ref({ settings: {} } as never),
      hostFontFamily: () => "monospace",
    });
    const events = await player.loadReplayEvents("rec-1");
    expect(events).toHaveLength(player.REPLAY_EVENT_CAP);
    expect(invoke).toHaveBeenCalledTimes(40);
  });
});

describe("useReplayPlayer openReplay", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("fetches, builds the timeline and resets the playhead", async () => {
    const { player, summary } = mount();
    const pending = player.openReplay(summary);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(player.replayState.value?.summary.recordingId).toBe("rec-1");
    expect(player.replayState.value?.events).toHaveLength(60);
    // 总时长 = 最后事件 time × 1000（5.9s → 5900ms）。
    expect(player.replayDurationMs.value).toBe(5900);
    expect(player.replayPlayheadMs.value).toBe(0);
  });

  it("drops a late load of the previous recording (request epoch guard)", async () => {
    // 首条录制的第一页挂起直到手动放行（显式 deferred，不依赖假时钟时长）。
    let releaseFirst: (() => void) | undefined;
    const invoke = vi.fn(async (method: string, params: { recordingId: string; offset: number }) => {
      if (method !== "ssh/recording/get") return undefined;
      if (params.recordingId === "rec-1" && params.offset === 0) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      const events = Array.from({ length: 20 }, (_, i) => ({
        time: (params.offset + i) / 10,
        type: "o",
        data: `e${params.recordingId}-${params.offset + i}`,
      }));
      return { events, total: 60, hasMore: params.offset + 20 < 60 } satisfies ReplayEventPage;
    });
    (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
    const player = useReplayPlayer({
      showError: vi.fn(),
      appearance: ref({ terminal: { fontSize: 14 } }),
      terminalTheme: () => ({ background: "#000000" }) as never,
      terminalFontOverride: ref({} as never),
      terminalAppearance: ref({ settings: {} } as never),
      hostFontFamily: () => "monospace",
    });
    const summary: RecordingSummary = { recordingId: "rec-1", host: "h1" };
    const first = player.openReplay(summary);
    await vi.advanceTimersByTimeAsync(0);
    // 第二条立即完成（rec-2 不走 deferred；同语料只为触发守卫）。
    const second = player.openReplay({ ...summary, recordingId: "rec-2" });
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(player.replayState.value?.summary.recordingId).toBe("rec-2");
    // 放行慢加载：晚到的旧请求不得关闭/顶替新回放。
    releaseFirst!();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(player.replayState.value?.summary.recordingId).toBe("rec-2");
  });
});

describe("useReplayPlayer playback clock", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
  afterEach(() => vi.useRealTimers());

  async function playingPlayer() {
    const { player, summary } = mount();
    const pending = player.openReplay(summary);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    const raf = stubRaf();
    player.toggleReplayPlay();
    return { player, raf };
  }

  it("advances the playhead via rAF and stops at the end", async () => {
    const { player, raf } = await playingPlayer();
    vi.advanceTimersByTime(500);
    raf.frame();
    expect(player.replayPlayheadMs.value).toBe(500);
    // 推进到末尾：播放头收敛到时长并自动停（总时长 5.9s）。
    vi.advanceTimersByTime(10_000);
    raf.frame();
    expect(player.replayPlayheadMs.value).toBe(player.replayDurationMs.value);
    expect(player.replayPlaying.value).toBe(false);
    raf.restore();
  });

  it("re-anchors the wall clock when the speed changes mid-playback", async () => {
    const { player, raf } = await playingPlayer();
    vi.advanceTimersByTime(500);
    raf.frame();
    const before = player.replayPlayheadMs.value;
    expect(before).toBe(500);
    player.replaySpeed.value = 2;
    // watch 异步 flush：先让重锚落地再推进假时钟。
    await nextTick();
    // 切档本身不跳进度（重锚墙钟基准）；此后同样墙钟间隔推进翻倍。
    expect(player.replayPlayheadMs.value).toBe(before);
    vi.advanceTimersByTime(500);
    raf.frame();
    expect(player.replayPlayheadMs.value).toBe(before + 1_000);
    raf.restore();
  });

  it("seek jumps the write index without touching the wall clock", async () => {
    const { player, raf } = await playingPlayer();
    raf.frame();
    const target = player.replayState.value!.events[30]!.time * 1000;
    const seekEvent = { target: { value: String(target) } } as unknown as Event;
    player.onReplaySeek(seekEvent);
    expect(player.replayPlayheadMs.value).toBe(target);
    expect(player.replayPlaying.value).toBe(false);
    // 从 seek 点继续播放：推进基于新锚点（墙钟被 seek 重置）。
    player.toggleReplayPlay();
    vi.advanceTimersByTime(200);
    raf.frame();
    expect(player.replayPlayheadMs.value).toBe(target + 200);
    raf.restore();
  });
});
