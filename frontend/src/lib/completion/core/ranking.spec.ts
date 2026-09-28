// rankItems 纯函数单测（FIG wave-1 Lane A）：排序确定性、截断 20、不改入参。
// 排序语义必须与 legacy rankRows 完全一致（golden parity 的前提）。
import { describe, expect, it } from "vitest";
import { MAX_COMPLETION_ITEMS, rankItems } from "./ranking";
import type { CompletionItem } from "./types";

function item(label: string, score = 60, id = label): CompletionItem {
  return { id, label, kind: "subcommand", score, source: "test", edit: { text: label, replaceStart: 0, replaceEnd: 0 } };
}

describe("rankItems", () => {
  it("orders by score descending and breaks ties alphabetically by label", () => {
    const ranked = rankItems([item("push", 60), item("pull", 60), item("punt", 60), item("exact", 100), item("weak", 10)]);
    expect(ranked.map((entry) => entry.label)).toEqual(["exact", "pull", "punt", "push", "weak"]);
  });

  it("is deterministic for fully tied inputs", () => {
    const input = [item("c"), item("a"), item("b")];
    expect(rankItems(input).map((entry) => entry.label)).toEqual(["a", "b", "c"]);
    expect(rankItems(input).map((entry) => entry.label)).toEqual(["a", "b", "c"]);
  });

  it("truncates to MAX_COMPLETION_ITEMS keeping the top-scoring head", () => {
    const input = Array.from({ length: MAX_COMPLETION_ITEMS + 5 }, (_, index) => item(`cmd${String(index).padStart(2, "0")}`, 60));
    const ranked = rankItems(input);
    expect(ranked).toHaveLength(MAX_COMPLETION_ITEMS);
    expect(ranked[0].label).toBe("cmd00");
    expect(ranked[MAX_COMPLETION_ITEMS - 1].label).toBe(`cmd${String(MAX_COMPLETION_ITEMS - 1).padStart(2, "0")}`);
  });

  it("returns a new array and leaves the input untouched", () => {
    const input = [item("b", 1), item("a", 2)];
    const snapshot = [...input];
    const ranked = rankItems(input);
    expect(ranked).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(ranked.map((entry) => entry.label)).toEqual(["a", "b"]);
  });

  it("passes empty input through", () => {
    expect(rankItems([])).toEqual([]);
  });
});
