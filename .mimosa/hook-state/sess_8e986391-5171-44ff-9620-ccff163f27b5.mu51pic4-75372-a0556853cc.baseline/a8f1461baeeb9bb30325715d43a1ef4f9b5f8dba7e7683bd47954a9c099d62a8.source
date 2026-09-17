// 会话录制回放（asciicast v2）纯逻辑单测。
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  eventIndexAtTime,
  gifFramePlan,
  mergeEventPages,
  replayDuration,
  type ReplayEventPage,
} from "./replayScheduler";

function page(offset: number, events: Array<[number, string]>, total: number, hasMore: boolean): ReplayEventPage {
  return { events: events.map(([time, data]) => ({ time, type: "o", data })), total, hasMore };
}

describe("replay event pages", () => {
  it("merges pages and drops non-output events", () => {
    const events = mergeEventPages([
      page(0, [[0, "hello "], [0.5, "world"]], 3, true),
      { events: [{ time: 1, type: "i", data: "x" }, { time: 1.2, type: "o", data: "!" }], total: 3, hasMore: false },
    ]);
    expect(events).toEqual([
      { time: 0, data: "hello " },
      { time: 0.5, data: "world" },
      { time: 1.2, data: "!" },
    ]);
  });

  it("measures duration from the last event", () => {
    expect(replayDuration([])).toBe(0);
    expect(replayDuration([{ time: 1, data: "a" }, { time: 2.5, data: "b" }])).toBe(2.5);
  });
});

describe("replay timeline", () => {
  const events = [{ time: 0, data: "a" }, { time: 1, data: "b" }, { time: 2, data: "c" }];

  it("scales by playback speed", () => {
    expect(buildTimeline(events, 1)).toEqual([0, 1000, 2000]);
    expect(buildTimeline(events, 2)).toEqual([0, 500, 1000]);
    expect(buildTimeline(events, 0.5)).toEqual([0, 2000, 4000]);
    // 非法 speed 退化为 1x。
    expect(buildTimeline(events, 0)).toEqual([0, 1000, 2000]);
  });

  it("locates the write head at a playhead time", () => {
    const timeline = buildTimeline(events, 1);
    expect(eventIndexAtTime(timeline, 0)).toBe(1);
    expect(eventIndexAtTime(timeline, 999)).toBe(1);
    expect(eventIndexAtTime(timeline, 1000)).toBe(2);
    expect(eventIndexAtTime(timeline, 9999)).toBe(3);
  });
});

describe("gif frame plan", () => {
  it("samples frames on a fixed interval and caps the count", () => {
    // 0..1000ms 之间每 100ms 一个事件。
    const timeline = Array.from({ length: 11 }, (_, index) => index * 100);
    expect(gifFramePlan(timeline, 300, 100)).toEqual([4, 7, 10, 11]);
    // 封顶：只留前 maxFrames 帧。
    expect(gifFramePlan(timeline, 100, 3)).toEqual([2, 3, 4]);
  });

  it("always emits the final frame and rejects invalid input", () => {
    expect(gifFramePlan([0, 100, 200], 500, 10)).toEqual([3]);
    expect(gifFramePlan([0, 100], 0, 10)).toEqual([]);
    expect(gifFramePlan([], 100, 10)).toEqual([0]);
  });
});
