// historyPanel 纯逻辑单测：过滤（空 query 全量 / 模糊排序 / 子串回落 /
// 上限截断）、循环导航与越界收拢、打开门判定矩阵。
import { describe, expect, it } from "vitest";
import {
  HISTORY_PANEL_LIMIT,
  HISTORY_TIMES_LIMIT,
  canOpenHistoryPanel,
  chooseHistoryPanelPlacement,
  clampHistoryPanelIndex,
  decorateHistoryEntries,
  filterHistoryEntries,
  moveHistoryPanelIndex,
  pruneHistoryTimes,
  recordHistoryTime,
  relativeHistoryAge,
  resolveHistoryPanelKey,
  sanitizeHistoryTimes,
} from "./historyPanel";

const HISTORY = [
  "kubectl get pods -n prod",
  "tail -f /var/log/syslog",
  "docker compose up -d",
  "git status",
  "echo hello",
];

describe("filterHistoryEntries", () => {
  it("empty query returns the newest entries capped at the limit, oldest on top (shell ↑ direction)", () => {
    const expected = [...HISTORY].reverse();
    expect(filterHistoryEntries(HISTORY, "")).toEqual(expected);
    expect(filterHistoryEntries(HISTORY, "   ")).toEqual(expected);
    const long = Array.from({ length: HISTORY_PANEL_LIMIT + 10 }, (_, i) => `cmd-${i}`);
    expect(filterHistoryEntries(long, "")).toHaveLength(HISTORY_PANEL_LIMIT);
    // 取最新的 50 条(cmd-0..cmd-49,cmd-0 最新)后反转:底部是最新。
    expect(filterHistoryEntries(long, "")[0]).toBe("cmd-49");
    expect(filterHistoryEntries(long, "")[HISTORY_PANEL_LIMIT - 1]).toBe("cmd-0");
  });

  it("ranks fuzzy matches by subsequence score, most-relevant at the bottom", () => {
    const rows = filterHistoryEntries(HISTORY, "kube");
    expect(rows[0]).toBe("kubectl get pods -n prod");
  });

  it("ranks multiple fuzzy hits by score and reverses into oldest-on-top order", () => {
    // "up"：docker 的 "up" 词首+连续命中得分最高；kubectl 里 u…p 的跨段子序列
    // 次之；其余无子序列命中。输出旧上新下:相关性最高的 docker 在底部。
    expect(filterHistoryEntries(HISTORY, "up")).toEqual(["kubectl get pods -n prod", "docker compose up -d"]);
  });

  it("handles over-long queries (beyond the search length gate) via substring fallback", () => {
    const long = "kubectl get pods -n prod and a very long continuation".slice(0, 80);
    expect(filterHistoryEntries(HISTORY, long)).toEqual([]);
    expect(filterHistoryEntries([...HISTORY, `run ${long}`], long)).toEqual([`run ${long}`]);
  });

  it("returns empty for queries matching nothing", () => {
    expect(filterHistoryEntries(HISTORY, "zzzz")).toEqual([]);
  });
});

describe("moveHistoryPanelIndex / clampHistoryPanelIndex", () => {
  it("wraps around both edges", () => {
    expect(moveHistoryPanelIndex(0, -1, 3)).toBe(2);
    expect(moveHistoryPanelIndex(2, 1, 3)).toBe(0);
    expect(moveHistoryPanelIndex(1, 1, 3)).toBe(2);
  });

  it("stays at zero for an empty list", () => {
    expect(moveHistoryPanelIndex(0, 1, 0)).toBe(0);
    expect(clampHistoryPanelIndex(5, 0)).toBe(0);
  });

  it("clamps after re-filtering shrinks the list", () => {
    expect(clampHistoryPanelIndex(7, 3)).toBe(2);
    expect(clampHistoryPanelIndex(-1, 3)).toBe(0);
  });
});

describe("resolveHistoryPanelKey (shell ↑ 语义键位映射)", () => {
  it("moves within the list and stays at the oldest (top) edge instead of wrapping", () => {
    expect(resolveHistoryPanelKey("ArrowUp", 2, 3)).toEqual({ kind: "move", delta: -1 });
    expect(resolveHistoryPanelKey("ArrowDown", 0, 3)).toEqual({ kind: "move", delta: 1 });
    // 顶部是最旧一条：再 ↑ 停住（消费但不回绕到最新）。
    expect(resolveHistoryPanelKey("ArrowUp", 0, 3)).toEqual({ kind: "stay" });
  });

  it("cancels on Esc and on ↓ past the newest (bottom) entry", () => {
    expect(resolveHistoryPanelKey("Escape", 1, 3)).toEqual({ kind: "cancel" });
    expect(resolveHistoryPanelKey("ArrowDown", 2, 3)).toEqual({ kind: "cancel" });
    expect(resolveHistoryPanelKey("ArrowDown", 0, 1)).toEqual({ kind: "cancel" });
  });

  it("fills the active entry on Enter/Tab and closes when the list is empty", () => {
    expect(resolveHistoryPanelKey("Enter", 2, 3)).toEqual({ kind: "fill" });
    expect(resolveHistoryPanelKey("Tab", 0, 1)).toEqual({ kind: "fill" });
    expect(resolveHistoryPanelKey("Enter", 0, 0)).toEqual({ kind: "close" });
    expect(resolveHistoryPanelKey("Tab", 0, 0)).toEqual({ kind: "close" });
  });

  it("lets unrelated keys pass through to the shell", () => {
    expect(resolveHistoryPanelKey("a", 1, 3)).toBeNull();
    expect(resolveHistoryPanelKey("Home", 1, 3)).toBeNull();
  });
});

describe("canOpenHistoryPanel", () => {
  const open = {
    completionOpen: false,
    suggestionOpen: false,
    quickSelectOpen: false,
    searchOpen: false,
    alternateActive: false,
    commandRunning: false,
    transferBusy: false,
  };

  it("opens when every gate is clear", () => {
    expect(canOpenHistoryPanel(open)).toBe(true);
  });

  it("is blocked while any overlay, alternate screen, running command or transfer owns the input", () => {
    for (const key of Object.keys(open) as Array<keyof typeof open>) {
      expect(canOpenHistoryPanel({ ...open, [key]: true })).toBe(false);
    }
  });
});

describe("history times (Warp 式相对时间的数据面)", () => {
  it("sanitizeHistoryTimes keeps only well-formed entries and caps to the limit", () => {
    expect(sanitizeHistoryTimes(null)).toEqual({});
    expect(sanitizeHistoryTimes("junk")).toEqual({});
    expect(sanitizeHistoryTimes([{ c: "ls", t: 100 }, { c: "", t: 5 }, { c: "rm", t: -1 }, { c: "ok", t: "x" }, "junk", null])).toEqual({ ls: 100 });
    const flood = Array.from({ length: HISTORY_TIMES_LIMIT + 10 }, (_, i) => ({ c: `cmd-${i}`, t: i + 1 }));
    const sanitized = sanitizeHistoryTimes(flood);
    expect(Object.keys(sanitized)).toHaveLength(HISTORY_TIMES_LIMIT);
    expect(sanitized["cmd-0"]).toBeUndefined();
    expect(sanitized[`cmd-${HISTORY_TIMES_LIMIT + 9}`]).toBe(HISTORY_TIMES_LIMIT + 10);
  });

  it("recordHistoryTime upserts and evicts the oldest beyond the limit", () => {
    let times = recordHistoryTime({}, "a", 1);
    times = recordHistoryTime(times, "b", 2);
    times = recordHistoryTime(times, "a", 3);
    expect(times).toEqual({ b: 2, a: 3 });
    for (let i = 0; i < HISTORY_TIMES_LIMIT; i += 1) times = recordHistoryTime(times, `x${i}`, 10 + i);
    // 102 条裁到 100：按时间序淘汰最旧的两条（b@2、a@3）。
    expect(Object.keys(times)).toHaveLength(HISTORY_TIMES_LIMIT);
    expect(times.b).toBeUndefined();
    expect(times.a).toBeUndefined();
    expect(times.x0).toBe(10);
    expect(times.x99).toBe(109);
    expect(recordHistoryTime(times, "   ", 99)).toEqual(times);
  });

  it("pruneHistoryTimes drops entries no longer present in the history ring", () => {
    expect(pruneHistoryTimes({ a: 1, b: 2, gone: 3 }, ["a", "b"])).toEqual([{ c: "a", t: 1 }, { c: "b", t: 2 }]);
  });

  it("decorateHistoryEntries attaches timestamps, null when unknown", () => {
    expect(decorateHistoryEntries(["ls", "cd .."], { ls: 42 })).toEqual([
      { command: "ls", ts: 42 },
      { command: "cd ..", ts: null },
    ]);
  });
});

describe("relativeHistoryAge", () => {
  const now = 1_000_000_000_000;

  it("never for missing or bogus timestamps (incl. future drift)", () => {
    expect(relativeHistoryAge(null, now)).toEqual({ kind: "never" });
    expect(relativeHistoryAge(0, now)).toEqual({ kind: "never" });
    expect(relativeHistoryAge(now + 60_000, now)).toEqual({ kind: "never" });
  });

  it("buckets into just-now / minutes / hours / days", () => {
    expect(relativeHistoryAge(now - 30_000, now)).toEqual({ kind: "just-now" });
    expect(relativeHistoryAge(now - 5 * 60_000, now)).toEqual({ kind: "minutes", count: 5 });
    expect(relativeHistoryAge(now - 3 * 3_600_000, now)).toEqual({ kind: "hours", count: 3 });
    expect(relativeHistoryAge(now - 50 * 3_600_000, now)).toEqual({ kind: "days", count: 2 });
  });
});

describe("chooseHistoryPanelPlacement (Warp 版式：优先输入行上方)", () => {
  it("prefers above whenever the space there is usable", () => {
    expect(chooseHistoryPanelPlacement(500, 17, 900)).toBe("above");
    expect(chooseHistoryPanelPlacement(200, 17, 900)).toBe("above");
  });

  it("flips below only when above is unusable and below has more room", () => {
    // 光标贴视口顶部（如刚 clear）：上方 14px 不可用，下方充足。
    expect(chooseHistoryPanelPlacement(20, 17, 900)).toBe("below");
    // 上方不足最小高度但下方更小（矮视口）：保持上方（内部滚动收窄）。
    expect(chooseHistoryPanelPlacement(100, 17, 120)).toBe("above");
    // 上方不足且下方更大：翻到下方。
    expect(chooseHistoryPanelPlacement(130, 17, 300)).toBe("below");
  });

  it("keeps above when the viewport is unmeasurable", () => {
    expect(chooseHistoryPanelPlacement(300, 17, 0)).toBe("above");
  });
});
