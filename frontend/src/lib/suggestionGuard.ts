// 命令建议浮层的抑制门（P1-1）：全屏程序（vim/top 等 alternate buffer）、
// 跟随型程序（htop/less/journalctl/tail -f…）与 pager 单键交互期间不出建议。
// 纯函数 + 显式状态锁存（跟随型命令命中后保持抑制，Ctrl+C 或 q 解除），
// xterm buffer 检测与按键来源留给调用方。

export interface SuggestionGuardInput {
  /** xterm 当前是否处于 alternate buffer（vim/tmux/htop 等整屏接管）。 */
  alternateActive: boolean;
  /** 最近一次执行（或开始执行）的命令行；null 表示尚无命令。 */
  lastCommand: string | null;
  /** 本次按下的单个字符；多字符粘贴 / 回车 / 控制键传 null。 */
  typingChar: string | null;
  /** 输入前命令行是否为空（pager 单键启发只在行首生效）。 */
  lineEmpty?: boolean;
  /** 终端交互提示待答（issue #150 及其反馈扩展，MFA/验证码/密码待输入、
   *  选择菜单与 y/n 确认）：键入的是对远端的应答而非命令，本轮不出建议；
   *  不落锁存，交互结束后下一次键入照常评估。 */
  interactivePromptPending?: boolean;
}

export interface SuggestionGuardState {
  suppressed: boolean;
  suppressedBy: string | null;
}

export interface SuggestionGuardResult {
  show: boolean;
  state: SuggestionGuardState;
}

/** 跟随/整屏型程序名单：命中即进入抑制锁存。 */
const SUPPRESSIVE_PROGRAMS = new Set(["btop", "htop", "less", "man", "more", "nano", "nvim", "top", "vi", "vim", "watch"]);

/** pager（less/more）单键交互启发：行首按下这些键时多半在翻页而不是敲命令。 */
const PAGER_KEYS = new Set([" ", "b", "g", "G", "n", "N", "q", "/", "?", ":"]);

const CTRL_C = "\u0003";

/** 取命令首词的 basename（跳过 env 前缀与路径）。 */
function leadProgram(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  // `env VAR=x less …` / `sudo less …` 常见包装：跳过 env/sudo 与其赋值项。
  let index = 0;
  while (index < tokens.length && (tokens[index] === "env" || tokens[index] === "sudo")) index += 1;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const token = tokens[index] ?? "";
  const base = token.split("/").pop() ?? token;
  return base.toLowerCase();
}

/** 命令是否进入跟随/整屏输出模式（命中后由调用方锁存抑制）。 */
export function isSuppressiveCommand(command: string | null | undefined): boolean {
  const line = String(command ?? "").trim();
  if (!line) return false;
  const program = leadProgram(line);
  if (SUPPRESSIVE_PROGRAMS.has(program)) return true;
  if (program === "journalctl") return !/--no-pager\b/.test(line);
  if (program === "tail") {
    // 只看管道/串接前的参数段；-f/-F/-Fn 等带 f 即跟随。
    const head = line.split(/[|;&]/)[0] ?? "";
    return /(?:^|\s)-[a-zA-Z]*f/i.test(head);
  }
  return false;
}

/** pager 单键启发：仅在空行（行首）时把这些按键视作翻页交互。 */
export function isPagerKeystroke(typingChar: string | null | undefined, lineEmpty: boolean): boolean {
  if (!typingChar || !lineEmpty) return false;
  return PAGER_KEYS.has(typingChar);
}

export function createSuggestionGuardState(): SuggestionGuardState {
  return { suppressed: false, suppressedBy: null };
}

/**
 * Evaluates whether the suggestion overlay may show after one input event and
 * returns the next latch state alongside the decision (pure — always consumes
 * the returned state for the following call):
 * - alternate buffer or an already-latched suppressive program hides;
 * - a suppressive `lastCommand` (re)latches and hides;
 * - Ctrl+C / q inside a latch releases it (that keystroke itself stays hidden);
 * - pager-style single keys at an empty line hide for that keystroke only;
 * - a pending interactive prompt on the remote side (MFA code, password,
 *   selection menu, y/n confirm) hides for that keystroke only — no latch,
 *   so the next keystroke after the prompt clears is evaluated as usual.
 */
export function canShowSuggestions(input: SuggestionGuardInput, state: SuggestionGuardState = createSuggestionGuardState()): SuggestionGuardResult {
  let next: SuggestionGuardState = { ...state };

  if (next.suppressed && (input.typingChar === CTRL_C || input.typingChar === "q")) {
    // 跟随程序的退出手势：本轮不出建议，锁存解除。
    next = createSuggestionGuardState();
    return { show: false, state: next };
  }

  if (input.interactivePromptPending) return { show: false, state: next };
  if (isSuppressiveCommand(input.lastCommand)) {
    next = { suppressed: true, suppressedBy: input.lastCommand };
    return { show: false, state: next };
  }
  if (input.lastCommand !== null && next.suppressed) {
    // 新跑了一条普通命令：跟随程序已被挤出，解除抑制。
    next = createSuggestionGuardState();
  }

  if (input.alternateActive) return { show: false, state: next };
  if (next.suppressed) return { show: false, state: next };
  if (isPagerKeystroke(input.typingChar, input.lineEmpty ?? true)) return { show: false, state: next };
  return { show: true, state: next };
}
