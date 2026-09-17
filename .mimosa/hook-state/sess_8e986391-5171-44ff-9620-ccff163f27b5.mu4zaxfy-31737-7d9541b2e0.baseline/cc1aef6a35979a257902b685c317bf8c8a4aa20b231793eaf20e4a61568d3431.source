import { describe, expect, it } from "vitest";
import {
  compileRules,
  highlightFillStyle,
  matchesInLine,
  normalizeHighlightRules,
  sanitizeHighlightRuleInput,
  HIGHLIGHT_COLOR_DEFAULT,
  HIGHLIGHT_RULE_PATTERN_MAX,
  type HighlightRuleView,
} from "./keywordHighlight";

const rule = (overrides: Partial<HighlightRuleView> = {}): HighlightRuleView => ({
  id: "r1",
  pattern: "ERROR",
  isRegex: false,
  color: "#ef4444",
  caseSensitive: false,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("keyword highlight rule compilation", () => {
  it("escapes regex metacharacters in plain patterns", () => {
    const [compiled] = compileRules([rule({ pattern: "a.c", color: "#22c55e" })]);
    expect(compiled).toBeDefined();
    expect(matchesInLine("a.c", [compiled!])).toEqual([{ start: 0, end: 3, color: "#22c55e" }]);
    expect(matchesInLine("abc", [compiled!])).toEqual([]);
  });

  it("passes regex patterns through verbatim", () => {
    const [compiled] = compileRules([rule({ pattern: "err(or)?", isRegex: true, color: "#f59e0b" })]);
    expect(compiled).toBeDefined();
    const hits = matchesInLine("x error y", [compiled!]);
    expect(hits).toEqual([{ start: 2, end: 7, color: "#f59e0b" }]);
  });

  it("drops invalid regex rules instead of throwing", () => {
    const compiled = compileRules([
      rule({ id: "bad", pattern: "([unclosed", isRegex: true }),
      rule({ id: "good", pattern: "ok", color: "#22c55e" }),
    ]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].pattern).toBe("ok");
  });

  it("skips disabled and blank rules", () => {
    expect(compileRules([rule({ enabled: false })])).toEqual([]);
    expect(compileRules([rule({ pattern: "   " })])).toEqual([]);
  });

  it("orders compiled rules longest-pattern first", () => {
    const compiled = compileRules([rule({ id: "a", pattern: "or" }), rule({ id: "b", pattern: "error" }), rule({ id: "c", pattern: "warnings" })]);
    expect(compiled.map((item) => item.pattern)).toEqual(["warnings", "error", "or"]);
  });

  it("compiles repeatedly without leaking lastIndex state", () => {
    const [compiled] = compileRules([rule({ pattern: "err", color: "#ef4444" })]);
    expect(matchesInLine("err", [compiled!])).toHaveLength(1);
    expect(matchesInLine("err", [compiled!])).toHaveLength(1);
    expect(matchesInLine("another err here", [compiled!])[0]).toEqual({ start: 8, end: 11, color: "#ef4444" });
  });
});

describe("keyword highlight line matching", () => {
  const errorRule = rule({ id: "e", pattern: "ERROR", color: "#ef4444" });
  const warnRule = rule({ id: "w", pattern: "WARN", color: "#f59e0b" });

  it("matches multiple rules in one line", () => {
    const compiled = compileRules([errorRule, warnRule]);
    const hits = matchesInLine("ERROR then WARN then ERROR", compiled);
    expect(hits).toEqual([
      { start: 0, end: 5, color: "#ef4444" },
      { start: 11, end: 15, color: "#f59e0b" },
      { start: 21, end: 26, color: "#ef4444" },
    ]);
  });

  it("resolves overlaps first-come-first-served (longer pattern wins)", () => {
    const compiled = compileRules([rule({ id: "long", pattern: "foobar", color: "#3b82f6" }), rule({ id: "short", pattern: "bar", color: "#f59e0b" })]);
    // foobar occupies 0..6, so the bare "bar" inside it is skipped.
    expect(matchesInLine("foobar bar", compiled)).toEqual([
      { start: 0, end: 6, color: "#3b82f6" },
      { start: 7, end: 10, color: "#f59e0b" },
    ]);
  });

  it("honors the case-sensitivity flag", () => {
    const sensitive = compileRules([rule({ pattern: "error", caseSensitive: true })]);
    expect(matchesInLine("ERROR", sensitive)).toEqual([]);
    expect(matchesInLine("error", sensitive)).toHaveLength(1);
    const insensitive = compileRules([rule({ pattern: "error" })]);
    expect(matchesInLine("ERROR", insensitive)).toHaveLength(1);
  });

  it("caps matches per line", () => {
    const compiled = compileRules([rule({ pattern: "a", color: "#22c55e" })]);
    expect(matchesInLine("aaaa", compiled, 2)).toHaveLength(2);
    expect(matchesInLine("aaaa", compiled)).toHaveLength(4);
  });

  it("returns nothing without rules or content", () => {
    expect(matchesInLine("anything", [])).toEqual([]);
    expect(matchesInLine("", compileRules([errorRule]))).toEqual([]);
  });
});

describe("keyword highlight rule list normalization", () => {
  const view = { id: "r1", pattern: "ERROR", isRegex: false, color: "#ef4444", caseSensitive: true, enabled: true, createdAt: 5, updatedAt: 6 };

  it("keeps well-formed views verbatim and caps the list", () => {
    const raw = [view, ...Array.from({ length: 35 }, (_, index) => ({ ...view, id: `r${index + 2}` }))];
    expect(normalizeHighlightRules(raw)).toHaveLength(30);
    expect(normalizeHighlightRules(raw, 1)).toEqual([view]);
  });

  it("drops invalid entries, dedupes ids and defaults missing flags", () => {
    const list = normalizeHighlightRules([
      "junk",
      null,
      { id: "", pattern: "x" }, // 缺 id
      { id: "r2", pattern: "   " }, // 空白 pattern
      { id: "r3", pattern: "warn", isRegex: "yes", color: "red", createdAt: "old" }, // 坏色/坏数字收紧
      view,
      { ...view }, // 重复 id
      { id: "r4", pattern: "fatal", enabled: false },
    ]);
    expect(list).toEqual([
      { id: "r3", pattern: "warn", isRegex: false, color: HIGHLIGHT_COLOR_DEFAULT, caseSensitive: false, enabled: true, createdAt: 0, updatedAt: 0 },
      view,
      { id: "r4", pattern: "fatal", isRegex: false, color: HIGHLIGHT_COLOR_DEFAULT, caseSensitive: false, enabled: false, createdAt: 0, updatedAt: 0 },
    ]);
    expect(normalizeHighlightRules(null)).toEqual([]);
  });
});

describe("keyword highlight rule input sanitization", () => {
  it("trims the pattern and enforces the required/length constraints", () => {
    expect(sanitizeHighlightRuleInput({ pattern: "  " }).error).toBe("highlightRules.invalidPattern");
    expect(sanitizeHighlightRuleInput({ pattern: "x".repeat(HIGHLIGHT_RULE_PATTERN_MAX + 1) }).error).toBe("highlightRules.invalidPattern");
    expect(sanitizeHighlightRuleInput({ pattern: "  error  " }).value?.pattern).toBe("error");
  });

  it("validates the hex color and falls back to the default", () => {
    expect(sanitizeHighlightRuleInput({ pattern: "e", color: "red" }).error).toBe("highlightRules.invalidColor");
    expect(sanitizeHighlightRuleInput({ pattern: "e", color: "#ef444" }).error).toBe("highlightRules.invalidColor");
    expect(sanitizeHighlightRuleInput({ pattern: "e", color: "#EF4444" }).value?.color).toBe("#EF4444");
    expect(sanitizeHighlightRuleInput({ pattern: "e" }).value?.color).toBe(HIGHLIGHT_COLOR_DEFAULT);
  });

  it("compiles regex drafts before accepting them", () => {
    expect(sanitizeHighlightRuleInput({ pattern: "(bad", isRegex: true }).error).toBe("highlightRules.invalidRegex");
    const ok = sanitizeHighlightRuleInput({ pattern: "err(or)?", isRegex: true, caseSensitive: true });
    expect(ok.error).toBeNull();
    expect(ok.value).toEqual({ pattern: "err(or)?", color: HIGHLIGHT_COLOR_DEFAULT, isRegex: true, caseSensitive: true });
  });

  it("keeps plain drafts without regex compilation", () => {
    // Metacharacters are legal plain patterns: the escape happens at compile time.
    const plain = sanitizeHighlightRuleInput({ pattern: "a.c" });
    expect(plain.error).toBeNull();
    expect(plain.value).toEqual({ pattern: "a.c", color: HIGHLIGHT_COLOR_DEFAULT, isRegex: false, caseSensitive: false });
  });
});

describe("keyword highlight decoration fill", () => {
  it("converts rule colors to translucent rgba fills", () => {
    expect(highlightFillStyle("#ef4444")).toBe("rgba(239, 68, 68, 0.35)");
    expect(highlightFillStyle("#22C55E")).toBe("rgba(34, 197, 94, 0.35)");
  });

  it("falls back to the default color for malformed shapes", () => {
    expect(highlightFillStyle("red")).toBe("rgba(245, 158, 11, 0.35)");
    expect(highlightFillStyle("#12345")).toBe("rgba(245, 158, 11, 0.35)");
    expect(highlightFillStyle("")).toBe("rgba(245, 158, 11, 0.35)");
  });
});
