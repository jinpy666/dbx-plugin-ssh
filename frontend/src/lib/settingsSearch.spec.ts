import { describe, expect, it } from "vitest";
import { filterSettingsCategories, matchesSettingsCategory, settingsQueryTokens } from "./settingsSearch";

const categories = [
  { id: "appearance", labelKey: "settingsNav.appearance" },
  { id: "suggestions", labelKey: "settingsNav.suggestions" },
  { id: "transfer", labelKey: "settingsNav.transfer" },
  { id: "mcp", labelKey: "settingsNav.mcp" },
];
const labels: Record<string, string> = {
  appearance: "外观",
  suggestions: "命令建议",
  transfer: "传输",
  mcp: "MCP 服务",
};
const labelOf = (category: { id: string }) => labels[category.id] ?? category.id;

describe("settingsQueryTokens", () => {
  it("lowercases and splits on whitespace", () => {
    expect(settingsQueryTokens("  MCP  服务 ")).toEqual(["mcp", "服务"]);
    expect(settingsQueryTokens("")).toEqual([]);
  });
});

describe("matchesSettingsCategory", () => {
  const entry = { id: "mcp", labelKey: "settingsNav.mcp" };

  it("matches everything for an empty query", () => {
    expect(matchesSettingsCategory(entry, "MCP 服务", "")).toBe(true);
  });

  it("matches the localized label, the id and the label key", () => {
    expect(matchesSettingsCategory(entry, "MCP 服务", "服务")).toBe(true);
    expect(matchesSettingsCategory(entry, "MCP 服务", "mcp")).toBe(true);
    expect(matchesSettingsCategory(entry, "MCP 服务", "settingsNav")).toBe(true);
    expect(matchesSettingsCategory(entry, "MCP 服务", "传输")).toBe(false);
  });

  it("requires every token to match (AND, across fields)", () => {
    expect(matchesSettingsCategory(entry, "MCP 服务", "mcp 服务")).toBe(true);
    expect(matchesSettingsCategory(entry, "MCP 服务", "mcp 传输")).toBe(false);
  });
});

describe("filterSettingsCategories", () => {
  it("returns a copy in original order for an empty query", () => {
    const out = filterSettingsCategories(categories, labelOf, "");
    expect(out).toEqual(categories);
    expect(out).not.toBe(categories);
  });

  it("keeps navigation order regardless of match strength", () => {
    // "e" 命中每个分类的 labelKey（settingsNav.* 含 e）与多数 id → 全中且保序。
    expect(filterSettingsCategories(categories, labelOf, "e").map((c) => c.id)).toEqual([
      "appearance",
      "suggestions",
      "transfer",
      "mcp",
    ]);
    // 只命中部分时同样保持原序（transfer 与 mcp 的本地化名都含「服务」的另一例）。
    expect(filterSettingsCategories(categories, labelOf, "传输").map((c) => c.id)).toEqual(["transfer"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSettingsCategories(categories, labelOf, "不存在的分类")).toEqual([]);
  });
});
