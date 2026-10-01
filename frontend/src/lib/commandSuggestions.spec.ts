import { describe, expect, it } from "vitest";
import {
  SEARCH_COMMANDS_DEFAULTS,
  commandSuggestionQueryAcceptable,
  resolveSuggestionTabKey,
  searchCommands,
  scoreSubsequence,
} from "./commandSuggestions";

const SOURCES = {
  history: ["docker compose up -d", "kubectl get pods", "git status", "git push origin main"],
  quickCommands: [
    { name: "disk usage", command: "df -h" },
    { name: "memory", command: "free -m" },
  ],
};

describe("scoreSubsequence (case-insensitive subsequence match)", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(scoreSubsequence("xyz", "git status")).toBeNull();
    expect(scoreSubsequence("dc", "git status")).toBeNull();
  });

  it("returns ordered indices for a scattered match", () => {
    const match = scoreSubsequence("gst", "git status");
    expect(match).not.toBeNull();
    expect(match!.indices).toEqual([0, 4, 5]);
  });

  it("matches case-insensitively and keeps candidate casing", () => {
    const match = scoreSubsequence("GS", "git Status");
    expect(match).not.toBeNull();
    expect(match!.indices).toEqual([0, 4]);
  });

  it("rewards consecutive runs over scattered matches", () => {
    const scattered = scoreSubsequence("gt", "git commit")!;
    const consecutive = scoreSubsequence("gi", "git commit")!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it("rewards word-boundary hits", () => {
    const wordStart = scoreSubsequence("s", "git status")!;
    const midWord = scoreSubsequence("s", "pos t")!;
    expect(wordStart.score).toBeGreaterThan(midWord.score);
  });

  it("gives the full-prefix match the highest prefix bonus", () => {
    const prefix = scoreSubsequence("git", "git status")!;
    const scattered = scoreSubsequence("git", "do git things")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it("gives an exact match a bonus on top of the prefix bonus", () => {
    const exact = scoreSubsequence("df -h", "df -h")!;
    const prefix = scoreSubsequence("df", "df -h")!;
    expect(exact.score).toBeGreaterThan(prefix.score);
  });
});

describe("commandSuggestionQueryAcceptable (length gate)", () => {
  it("accepts queries within the inclusive bounds", () => {
    expect(commandSuggestionQueryAcceptable("ab", 2, 64)).toBe(true);
    expect(commandSuggestionQueryAcceptable("a".repeat(64), 2, 64)).toBe(true);
  });

  it("rejects queries below the minimum or above the maximum", () => {
    expect(commandSuggestionQueryAcceptable("a", 2, 64)).toBe(false);
    expect(commandSuggestionQueryAcceptable("a".repeat(65), 2, 64)).toBe(false);
  });
});

describe("searchCommands", () => {
  it("returns at most `limit` suggestions sorted by score desc", () => {
    const results = searchCommands("git", { history: SOURCES.history, quickCommands: [] }, { limit: 2 });
    expect(results).toHaveLength(2);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns empty for queries outside the length bounds", () => {
    // 批 4：minLength 默认 2→1（Warp 首字符即建议；单字符经 ghost/浮层分工
    // 去噪——前缀命中归 ghost），单字符查询现在有结果。
    expect(searchCommands("g", SOURCES).length).toBeGreaterThan(0);
    expect(searchCommands("a".repeat(65), SOURCES)).toEqual([]);
    expect(searchCommands("   ", SOURCES)).toEqual([]);
  });

  it("tags the source kind for each result", () => {
    const results = searchCommands("df", SOURCES);
    expect(results[0].source).toBe("quick");
    const history = searchCommands("pods", SOURCES);
    expect(history[0].source).toBe("history");
  });

  it("dedupes a command shared by history and quick sources keeping one entry", () => {
    const results = searchCommands("df -h", { history: ["df -h"], quickCommands: [{ name: "df", command: "df -h" }] });
    expect(results.filter((item) => item.command === "df -h")).toHaveLength(1);
  });

  it("carries match indices for highlight rendering", () => {
    const results = searchCommands("gst", SOURCES);
    const status = results.find((item) => item.command === "git status");
    expect(status).toBeDefined();
    expect(status!.indices).toEqual([0, 4, 5]);
  });

  it("never mutates the input sources and returns frozen-shape rows", () => {
    const history = [...SOURCES.history];
    searchCommands("git", { history, quickCommands: SOURCES.quickCommands });
    expect(history).toEqual(SOURCES.history);
  });

  it("applies the documented default bounds and limit", () => {
    expect(SEARCH_COMMANDS_DEFAULTS).toMatchObject({ limit: 12, minLength: 1, maxLength: 64 });
    const many = Array.from({ length: 20 }, (_, i) => `git command ${i}`);
    const results = searchCommands("git", { history: many, quickCommands: [] });
    expect(results).toHaveLength(12);
  });

  it("keeps commands without a subsequence match out of the results", () => {
    expect(searchCommands("nginx", SOURCES)).toEqual([]);
  });
});

describe("resolveSuggestionTabKey (issue #138 Tab semantics)", () => {
  it("fills when the highlighted suggestion strictly extends the typed line", () => {
    expect(resolveSuggestionTabKey("cd /opt/aaa", "cd /opt/", false)).toBe("fill");
  });

  it("passes through to the shell when the auto-highlighted suggestion is unrelated fuzzy history", () => {
    expect(resolveSuggestionTabKey("cd /opt/aaa", "cd /opt/bb", false)).toBe("shell");
  });

  it("passes through when the line already equals the suggestion", () => {
    expect(resolveSuggestionTabKey("cd /opt/aaa", "cd /opt/aaa", false)).toBe("shell");
  });

  it("passes through when the suggestion is shorter than the typed line", () => {
    expect(resolveSuggestionTabKey("cd /opt", "cd /opt/aaa", false)).toBe("shell");
  });

  it("fills an unrelated suggestion only after explicit arrow-key selection", () => {
    expect(resolveSuggestionTabKey("cd /opt/aaa", "cd /opt/bb", true)).toBe("fill");
  });

  it("prefers fill over the extension rule when armed", () => {
    expect(resolveSuggestionTabKey("kubectl get pods", "git status", true)).toBe("fill");
  });
});
