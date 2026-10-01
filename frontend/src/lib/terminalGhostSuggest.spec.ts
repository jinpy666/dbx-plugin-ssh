import { describe, expect, it } from "vitest";
import { searchCommands } from "./commandSuggestions";
import {
  TERMINAL_GHOST_DEFAULTS,
  classifyGhostInput,
  createGhostState,
  evaluateGhost,
  firstGhostWordChunk,
  terminalCharCells,
  ghostMenuSuppressed,
  isGhostPrefixMatch,
  nextGhostState,
  pickGhostMatch,
  type GhostEvaluationInput,
  type TerminalGhostState,
} from "./terminalGhostSuggest";

const SOURCES = {
  history: ["docker compose up -d", "kubectl get pods", "git status", "git push origin main", "git"],
  quickCommands: [{ name: "disk usage", command: "df -h" }],
};

function evaluate(overrides: Partial<GhostEvaluationInput> = {}) {
  return evaluateGhost({
    state: { hidden: false, cursorAtEnd: true },
    line: "git ",
    cursorAtLineEnd: true,
    enabled: true,
    commandRunning: false,
    compositionActive: false,
    sources: SOURCES,
    ...overrides,
  });
}

describe("classifyGhostInput (onData bytes -> ghost event)", () => {
  it("maps single printable characters to printable", () => {
    expect(classifyGhostInput("g")).toEqual({ kind: "printable" });
    expect(classifyGhostInput(" ")).toEqual({ kind: "printable" });
    expect(classifyGhostInput("~")).toEqual({ kind: "printable" });
  });

  it("maps control bytes to their dedicated events", () => {
    expect(classifyGhostInput("\u007f")).toEqual({ kind: "backspace" });
    expect(classifyGhostInput("\r")).toEqual({ kind: "newline" });
    expect(classifyGhostInput("\n")).toEqual({ kind: "newline" });
    expect(classifyGhostInput("\u0003")).toEqual({ kind: "interrupt" });
    expect(classifyGhostInput("\u001b")).toEqual({ kind: "escape" });
  });

  it("maps CSI/SS3 movement finales to cursorMove", () => {
    expect(classifyGhostInput("\u001b[A")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001b[B")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001b[C")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001b[D")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001b[H")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001b[F")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001b[5~")).toEqual({ kind: "cursorMove" });
    expect(classifyGhostInput("\u001bOA")).toEqual({ kind: "cursorMove" });
  });

  it("treats non-movement escape sequences as opaque", () => {
    expect(classifyGhostInput("\u001b[200~pasted\u001b[201~")).toEqual({ kind: "opaque" });
    expect(classifyGhostInput("\u001b[1;5Cextra")).toEqual({ kind: "opaque" });
    expect(classifyGhostInput("\u001bOP")).toEqual({ kind: "opaque" });
  });

  it("treats multi-character payloads and unknown control bytes as opaque", () => {
    expect(classifyGhostInput("paste")).toEqual({ kind: "opaque" });
    expect(classifyGhostInput("\u0001")).toEqual({ kind: "opaque" });
    expect(classifyGhostInput("")).toEqual({ kind: "opaque" });
  });
});

describe("nextGhostState (gate state machine)", () => {
  it("starts suppressed and cursor-at-end", () => {
    expect(createGhostState()).toEqual<TerminalGhostState>({ hidden: true, cursorAtEnd: true });
  });

  it("typing and backspace unhide and restore cursorAtEnd", () => {
    const moved = nextGhostState(createGhostState(), { kind: "cursorMove" });
    expect(moved).toEqual({ hidden: true, cursorAtEnd: false });
    expect(nextGhostState(moved, { kind: "printable" })).toEqual({ hidden: false, cursorAtEnd: true });
    expect(nextGhostState(moved, { kind: "backspace" })).toEqual({ hidden: false, cursorAtEnd: true });
  });

  it("newline, interrupt, escape and reset always hide", () => {
    const live: TerminalGhostState = { hidden: false, cursorAtEnd: true };
    for (const kind of ["newline", "interrupt", "escape", "reset"] as const) {
      expect(nextGhostState(live, { kind })).toEqual({ hidden: true, cursorAtEnd: true });
    }
  });

  it("cursorMove only clears cursorAtEnd and keeps the hidden latch", () => {
    const hidden = nextGhostState(createGhostState(), { kind: "cursorMove" });
    expect(hidden).toEqual({ hidden: true, cursorAtEnd: false });
    const shown: TerminalGhostState = { hidden: false, cursorAtEnd: true };
    expect(nextGhostState(shown, { kind: "cursorMove" })).toEqual({ hidden: false, cursorAtEnd: false });
  });

  it("opaque suppresses until the next printable keystroke", () => {
    const shown: TerminalGhostState = { hidden: false, cursorAtEnd: true };
    const pasted = nextGhostState(shown, { kind: "opaque" });
    expect(pasted).toEqual({ hidden: true, cursorAtEnd: true });
    expect(nextGhostState(pasted, { kind: "printable" })).toEqual({ hidden: false, cursorAtEnd: true });
  });
});

describe("isGhostPrefixMatch / pickGhostMatch (ghost prefix-extension semantics)", () => {
  it("requires a strict prefix extension, case-insensitively", () => {
    expect(isGhostPrefixMatch("git", "git status")).toBe(true);
    expect(isGhostPrefixMatch("GIT", "git status")).toBe(true);
    expect(isGhostPrefixMatch("git status", "git status")).toBe(false);
    expect(isGhostPrefixMatch("git status --short", "git status")).toBe(false);
  });

  it("picks the highest-ranked strict prefix extension from the engine output", () => {
    const candidates = searchCommands("git", { history: SOURCES.history, quickCommands: [] });
    const match = pickGhostMatch("git", candidates);
    expect(match).not.toBeNull();
    expect(match!.command.startsWith("git")).toBe(true);
    expect(match!.remainder).toBe(match!.command.slice("git".length));
    expect(match!.remainder.length).toBeGreaterThan(0);
  });

  it("skips fuzzy non-prefix hits and falls through to later prefix candidates", () => {
    // "gs" 模糊命中 "git status"（非前缀）与 "git"（相等，非扩展）——两者都
    // 不能做 ghost；没有其他前缀扩展时返回 null。
    const candidates = searchCommands("gs", { history: SOURCES.history, quickCommands: [] }, { minLength: 1 });
    expect(pickGhostMatch("gs", candidates)).toBeNull();
    // 掺入一个真前缀扩展候选后，非前缀项被跳过、前缀项胜出。
    const withPrefix = [
      { command: "gsutil ls", score: 1, source: "history" as const, indices: [0, 1] },
      { command: "git status", score: 99, source: "history" as const, indices: [0, 4] },
    ];
    expect(pickGhostMatch("gs", withPrefix)).toEqual({ command: "gsutil ls", remainder: "util ls" });
  });

  it("returns null when every candidate is exact or non-prefix", () => {
    const candidates = [
      { command: "git", score: 99, source: "history" as const, indices: [0, 1, 2] },
      { command: "do git things", score: 3, source: "history" as const, indices: [3, 4, 5] },
    ];
    expect(pickGhostMatch("git", candidates)).toBeNull();
  });

  it("skips candidates containing newlines or control characters", () => {
    // B1 回归：ghost overlay 以 textContent 渲染看不到换行，含控制字符的
    // 候选一旦被接受会把多行文本一次性注入终端（fish 对多行历史同样不出
    // 行内建议）。
    const multiLine = { command: "git add\ngit commit", score: 1, source: "history" as const, indices: [0, 1] };
    const withTab = { command: "printf\tformat", score: 2, source: "history" as const, indices: [0, 1] };
    const normal = { command: "git status", score: 9, source: "history" as const, indices: [0, 1] };
    // 含控制字符的高分候选被跳过，普通前缀扩展候选胜出。
    expect(pickGhostMatch("git", [multiLine, normal])).toEqual({ command: "git status", remainder: " status" });
    expect(pickGhostMatch("pri", [withTab, normal])).toBeNull();
    // 全部候选都含控制字符 → 不出建议。
    expect(pickGhostMatch("echo", [multiLine])).toBeNull();
  });
});

describe("evaluateGhost (gates + search + accept bytes)", () => {
  it("suggests the remainder of the best prefix match with accept bytes", () => {
    const result = evaluate({ line: "git s" });
    expect(result.match).toEqual({ command: "git status", remainder: "tatus" });
    expect(result.acceptPayload).toBe("tatus");
  });

  it("matches case-insensitively and keeps candidate casing in the remainder", () => {
    const result = evaluate({ line: "GIT S" });
    expect(result.match).toEqual({ command: "git status", remainder: "tatus" });
    expect(result.acceptPayload).toBe("tatus");
  });

  it("hides on an empty line even when the gate is open", () => {
    expect(evaluate({ line: "" }).match).toBeNull();
  });

  it("hides while the gate is suppressed (paste/escape/newline latch)", () => {
    expect(evaluate({ state: { hidden: true, cursorAtEnd: true }, line: "git s" }).match).toBeNull();
  });

  it("hides when the cursor left the end of line (state or buffer sample)", () => {
    expect(evaluate({ state: { hidden: false, cursorAtEnd: false }, line: "git s" }).match).toBeNull();
    expect(evaluate({ cursorAtLineEnd: false, line: "git s" }).match).toBeNull();
  });

  it("hides while a remote command is running or transfer owns the stream", () => {
    expect(evaluate({ commandRunning: true, line: "git s" }).match).toBeNull();
  });

  it("hides during IME composition", () => {
    expect(evaluate({ compositionActive: true, line: "git s" }).match).toBeNull();
  });

  it("hides when the setting is off", () => {
    expect(evaluate({ enabled: false, line: "git s" }).match).toBeNull();
  });

  it("applies the query length gate", () => {
    // 批 4：默认 minLength 2→1（Warp 首字符即建议），单字符默认即出 ghost。
    expect(evaluate({ line: "g" }).match).not.toBeNull();
    expect(evaluate({ line: "g", bounds: { minLength: 2 } }).match).toBeNull();
    expect(evaluate({ line: "x".repeat(65) }).match).toBeNull();
  });

  it("returns null when no history command extends the typed prefix", () => {
    expect(evaluate({ line: "npm run" }).match).toBeNull();
    expect(evaluate({ line: "npm run" }).acceptPayload).toBeNull();
  });

  it("prefers quick-command sources through the shared engine ranking", () => {
    const result = evaluate({
      line: "df",
      sources: { history: ["df -hT"], quickCommands: [{ name: "disk", command: "df -h" }] },
    });
    expect(result.match).toEqual({ command: "df -h", remainder: " -h" });
  });

  it("documents the default bounds on top of the shared engine defaults", () => {
    expect(TERMINAL_GHOST_DEFAULTS).toEqual({ minLength: 1, maxLength: 64, limit: 12 });
  });
});

// 菜单互斥（#138 丝滑度批 2 收窄）：仅历史建议浮层抑制 ghost（数据分工后
// 浮层开着 = 无前缀命中，此判是竞态兜底）；结构化补全菜单与 ghost 同屏共存
// （对标 Warp：菜单只占用 ↑↓/Tab/Esc，→ 恒归 ghost 接受，空间上也不叠）。
describe("ghostMenuSuppressed (menu mutual exclusion)", () => {
  it("suppresses ghost while the history suggestion overlay is open", () => {
    expect(ghostMenuSuppressed(true)).toBe(true);
  });

  it("allows ghost alongside the structured completion menu", () => {
    expect(ghostMenuSuppressed(false)).toBe(false);
  });
});

describe("firstGhostWordChunk (Ctrl+→ word-by-word accept, Warp 语义)", () => {
  it("cuts the leading whitespace run plus the first word", () => {
    expect(firstGhostWordChunk(" status --long")).toBe(" status");
    expect(firstGhostWordChunk("ho ui-mock-history-a")).toBe("ho");
  });

  it("returns the whole remainder when it is a single word without separators", () => {
    expect(firstGhostWordChunk("-lah")).toBe("-lah");
  });

  it("returns the whitespace-only tail whole (no word left to cut)", () => {
    expect(firstGhostWordChunk("   ")).toBe("   ");
    expect(firstGhostWordChunk("")).toBe("");
  });

  it("treats non-space delimiters as word characters (fish token 口径)", () => {
    // 「词」= 非空白连续段（fish token / 默认 zsh WORDCHARS）：整条路径是
    // 一个词，一次 Ctrl+→ 全收，不拦腰截断。
    expect(firstGhostWordChunk(" /var/log/messages")).toBe(" /var/log/messages");
  });
});

describe("terminalCharCells (锚点乐观前进的简化 wcwidth, 批 3a)", () => {
  it("counts ASCII and half-width Kana-adjacent punctuation as one cell", () => {
    expect(terminalCharCells("a")).toBe(1);
    expect(terminalCharCells("/")).toBe(1);
    expect(terminalCharCells("é")).toBe(1);
  });

  it("counts CJK ideographs, Kana, Hangul and fullwidth forms as two cells", () => {
    expect(terminalCharCells("中")).toBe(2);
    expect(terminalCharCells("あ")).toBe(2);
    expect(terminalCharCells("한")).toBe(2);
    expect(terminalCharCells("Ａ")).toBe(2);
  });

  it("stays conservative for surrogate pairs and empty input", () => {
    // 组合区段外的代理对（emoji 等）不在双宽表内——乐观前进少推一格，
    // settle 校正兜底，优于多推。
    expect(terminalCharCells("😀")).toBe(1);
    expect(terminalCharCells("")).toBe(1);
  });
});
