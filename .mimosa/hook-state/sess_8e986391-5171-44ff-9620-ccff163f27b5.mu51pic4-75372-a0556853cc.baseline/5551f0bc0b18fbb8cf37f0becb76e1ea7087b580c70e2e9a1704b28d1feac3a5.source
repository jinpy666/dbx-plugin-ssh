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
