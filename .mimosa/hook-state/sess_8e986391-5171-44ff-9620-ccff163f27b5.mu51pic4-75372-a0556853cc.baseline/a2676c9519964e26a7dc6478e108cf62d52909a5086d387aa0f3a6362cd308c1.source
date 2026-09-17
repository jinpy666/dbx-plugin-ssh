// 会话录制回放（asciicast v2）纯逻辑：事件页合并、回放时间轴、进度定位。
// 零 UI / 零 sidecar 依赖，单测见 replayScheduler.spec.ts。

export interface ReplayEvent {
  /** Seconds since the recording started (asciicast `time`). */
  time: number;
  /** Output payload (asciicast `eventdata`). */
  data: string;
}

export interface RecordingSummary {
  recordingId: string;
  sessionId?: string;
  connectionId?: string;
  host?: string;
  startedAt?: number;
  durationSecs?: number;
  bytes?: number;
}

export interface ReplayEventPage {
  events: Array<{ time: number; type: string; data: string }>;
  total: number;
  hasMore: boolean;
}

// 合并 `ssh/recording/get` 分页（全部输出事件，忽略 i/r/m 等非输出事件）。
// 假设调用方按 offset 升序取页；同刻时间保持到达顺序。
export function mergeEventPages(pages: ReplayEventPage[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const page of pages) {
    for (const event of page.events) {
      if (event.type !== "o") continue;
      events.push({ time: Number(event.time) || 0, data: event.data });
    }
  }
  return events;
}

// 回放总时长：最后一个事件的时间（空录制为 0）。
export function replayDuration(events: readonly ReplayEvent[]): number {
  return events.length ? events[events.length - 1]!.time : 0;
}

// 回放时间轴：事件 → 播放进度（ms，已按 speed 放大）。speed 必须为正。
export function buildTimeline(events: readonly ReplayEvent[], speed: number): number[] {
  const rate = speed > 0 ? speed : 1;
  return events.map((event) => (event.time * 1000) / rate);
}

// 当前播放时刻（ms）应对应推进到的事件下标：第一个 atMs > playheadMs 的
// 事件之前。返回值是"已应写入的事件数"。
export function eventIndexAtTime(timeline: readonly number[], playheadMs: number): number {
  let index = 0;
  while (index < timeline.length && timeline[index]! <= playheadMs) {
    index += 1;
  }
  return index;
}

// GIF 导出的抽帧计划：按 frameIntervalMs 的事件时间间隔抽帧，封顶 maxFrames。
// 返回每个帧应写入到的事件数（累计），调用方据此渲染画布。
export function gifFramePlan(
  timeline: readonly number[],
  frameIntervalMs: number,
  maxFrames: number,
): number[] {
  if (frameIntervalMs <= 0 || maxFrames <= 0) return [];
  const frames: number[] = [];
  let nextBoundary = frameIntervalMs;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index]! > nextBoundary) {
      frames.push(index);
      nextBoundary += frameIntervalMs;
      if (frames.length >= maxFrames) return frames;
    }
  }
  // 收尾帧：确保最后一帧写到全部事件（与抽帧结果去重）。
  if (!frames.length || frames[frames.length - 1] !== timeline.length) {
    frames.push(timeline.length);
  }
  return frames;
}
