/** Readline/Emacs word commands; word boundaries remain owned by the shell. */
const WORD_KEYS: Readonly<Record<string, string>> = {
  ArrowLeft: "\x1bb",
  ArrowRight: "\x1bf",
  Backspace: "\x1b\x7f",
  Delete: "\x1bd",
};

export function terminalWordEditingInput(
  event: Pick<KeyboardEvent, "type" | "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "keyCode" | "getModifierState">,
  options: { enabled: boolean; alternateActive: boolean; hotkeyMatched: boolean },
): string | undefined {
  if (!options.enabled || options.alternateActive || options.hotkeyMatched) return;
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.getModifierState("AltGraph")) return;
  return Object.hasOwn(WORD_KEYS, event.key) ? WORD_KEYS[event.key] : undefined;
}

/**
 * Input the append-only line model cannot follow, so auto suggestions must stop
 * trusting it until a fresh line starts:
 * - Tab: the shell's own completion rewrites the line, and the inserted text
 *   never reaches the key model;
 * - Ctrl+W (delete word) plus the cursor/history edits Ctrl+A/Ctrl+E/Ctrl+R;
 * - CSI/SS3 cursor, Home/End and history-navigation sequences, which redraw
 *   the line from shell state.
 * Deliberately conservative: modelling every mid-line edit of every shell is
 * out of scope, so anything ambiguous keeps the model untrusted.
 */
const UNTRACKABLE_SEQUENCES: readonly string[] = [
  "\t",
  "\x17",
  "\x01",
  "\x05",
  "\x12",
  "\x1b[A",
  "\x1b[B",
  "\x1b[C",
  "\x1b[D",
  "\x1b[H",
  "\x1b[F",
  "\x1bOA",
  "\x1bOB",
  "\x1bOC",
  "\x1bOD",
  "\x1bOH",
  "\x1bOF",
  "\x1b[1~",
  "\x1b[3~",
  "\x1b[4~",
  "\x1b[7~",
  "\x1b[8~",
  ...Object.values(WORD_KEYS),
];

/** A chunk that ends on a partial escape sequence cannot be classified yet. */
const PARTIAL_ESCAPE_TAIL = /(?:\x1b|\x1b\[|\x1b\[[\d;]*|\x1bO)$/;

function untrackableInput(data: string): boolean {
  return UNTRACKABLE_SEQUENCES.some((sequence) => data.includes(sequence)) || PARTIAL_ESCAPE_TAIL.test(data);
}

/** The append-only suggestion model cannot follow shell-owned word edits.
 * Keep it suppressed until a new line; do not guess a remote shell's cursor.
 */
export function wordEditingLineUntrusted(previous: boolean, data: string): boolean {
  if (/[\r\n\x03]/.test(data)) return false;
  return previous || untrackableInput(data);
}
