/**
 * Converts text/newline input into the byte semantics expected by an
 * interactive PTY. Clipboard APIs commonly provide LF or CRLF while an
 * Enter key from xterm is represented by CR.
 *
 * Keep the line boundaries intact: a backslash immediately before a newline
 * must remain a shell line continuation rather than becoming a space.
 */
export function normalizeTerminalInputText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r");
}

/**
 * Normalizes PTY input without decoding arbitrary keyboard bytes as UTF-8.
 * CRLF is one Enter, and LF is converted to Enter; all other bytes are kept
 * byte-for-byte so escape sequences and non-text terminal input are intact.
 */
export function normalizeTerminalInputBytes(data: Uint8Array): Uint8Array {
  const normalized = new Uint8Array(data.length);
  let write = 0;
  for (let read = 0; read < data.length; read += 1) {
    const byte = data[read];
    if (byte === 0x0d) {
      normalized[write++] = 0x0d;
      if (data[read + 1] === 0x0a) read += 1;
    } else if (byte === 0x0a) {
      normalized[write++] = 0x0d;
    } else {
      normalized[write++] = byte;
    }
  }
  return normalized.slice(0, write);
}

/** Windows shell 行编辑能力分类（供整行替换选择清行字节）。
 *  POSIX readline/ZLE 把 Ctrl+U 绑定为 kill-whole-line；PSReadLine 的
 *  Windows 编辑模式（Windows 上的默认）不绑定 Ctrl+U，cmd 的 cooked 行编辑
 *  同样不认它——对这两类 shell 用 Ctrl+U 清行等于 no-op，替换文本会追加到
 *  现有行上（issue #317）。 */
export type WindowsShellEraseKind = "powershell" | "cmd" | null;

/**
 * Full-line replacement erase sequence emitted before the replacement text.
 *
 * - powershell: Ctrl+Home (cursor to line start) + Ctrl+End (delete to end).
 *   PSReadLine binds both by default in Windows edit mode
 *   (BackwardDeleteLine/ForwardDeleteLine), so the whole editable line is
 *   cleared regardless of cursor position, and ConPTY translates the CSI
 *   sequences into key events.
 * - cmd: the cooked console line editor only honors backspace, so erase the
 *   tracked model length.
 * - null (POSIX/unknown): Ctrl+U, unchanged behavior.
 */
export function terminalLineEraseSequence(shellKind: WindowsShellEraseKind, modelLineLength: number): string {
  if (shellKind === "powershell") return "\u001b[1;5H\u001b[1;5F";
  if (shellKind === "cmd") return "\b".repeat(Math.max(0, modelLineLength));
  return "\u0015";
}

/** 本地会话 shell 程序名 → 行清字节能力分类（提示符采样 miss 时的兜底：
 *  oh-my-posh 等自定义提示符不含 `PS C:\…>` 形态）。POSIX/未知程序保持
 *  Ctrl+U 语义不变。 */
export function shellKindFromProgramName(program: string | undefined | null): WindowsShellEraseKind {
  const base = String(program ?? "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (base === "pwsh" || base === "powershell") return "powershell";
  if (base === "cmd") return "cmd";
  return null;
}
