// Terminal output text sanitization, ported from the portable parts of
// tiny-rdm's modules/ssh/terminal-output.js. The MCP-CTL shell-hook special
// case is deliberately not ported: that echo scrubbing targets tiny-rdm's own
// `/tmp/.mcp_ctl_shell_*` hook injection, which this plugin never issues.
// What we keep is the generic capability: stripping OSC/CSI control sequences
// and matching command echo lines, used to render `ssh/exec` output as plain
// text in the run-command dialog.

const CSI_ESCAPE_PATTERN = String.raw`\u001b\[[0-?]*[ -/]*[@-~]`;
const OSC_ESCAPE_PATTERN = String.raw`\u001b\][^\u0007]*?(?:\u0007|\u001b\\)`;
const TERMINAL_CONTROL_PATTERN = new RegExp(`${OSC_ESCAPE_PATTERN}|${CSI_ESCAPE_PATTERN}`, "g");

function escapeRegex(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripTerminalControlSequences(output: unknown): string {
  return String(output || "").replace(TERMINAL_CONTROL_PATTERN, "");
}

/** Removes the single echoed command line (with any `\r` + CSI prompt repaint prefix). */
export function stripCommandEcho(output: unknown, command: unknown): string {
  const pattern = String(command || "").trim();
  if (!pattern) return String(output || "");
  const commandPattern = escapeRegex(pattern);
  const echoLine = new RegExp(
    `(^|[\\r\\n])(?:[^\\r\\n]*\\r(?:${CSI_ESCAPE_PATTERN})*)?[^\\r\\n]*${commandPattern}[^\\r\\n]*(?:\\r?\\n|\\r)?`,
    "g",
  );
  return String(output || "").replace(echoLine, "$1");
}

/**
 * Strips control sequences and any echo lines of `commands` that are visible
 * in `output`. Commands whose echo is not present are returned in
 * `remainingCommands` so a caller processing a stream can retry later chunks.
 */
export function stripHiddenCommandEchoes(output: unknown, commands: readonly unknown[] = []): { output: string; remainingCommands: string[] } {
  let clean = String(output || "");
  const remainingCommands: string[] = [];

  for (const command of commands) {
    const text = String(command || "").trim();
    if (!text) continue;

    const next = stripCommandEcho(clean, text);
    if (next === clean) {
      remainingCommands.push(text);
      continue;
    }
    clean = next;
  }

  return {
    output: clean,
    remainingCommands,
  };
}

/** Plain-text rendering for exec output: no OSC/CSI noise, trailing blank lines trimmed. */
export function sanitizeCommandOutput(output: unknown): string {
  return stripTerminalControlSequences(output).replace(/[\s\u0000]+$/u, "");
}
