/**
 * Heuristic binary sniff for remote file previews. Double-clicking a file must
 * never dump binary garbage into the text editor, so the workbench sniffs the
 * first chunk before opening it: any NUL byte, or a large share of bytes that
 * are invalid UTF-8 (plus non-text control characters), marks content binary.
 */
const REPLACEMENT_OR_CONTROL_RATIO = 0.1;

export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes.includes(0)) return true;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (decoded.length === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (code === 0xfffd) suspicious += 1;
    // Allow tab/newline/CR/VT/FF and ESC (ANSI logs); flag the rest of C0.
    else if (code < 9 || (code > 13 && code < 32 && code !== 27)) suspicious += 1;
  }
  return suspicious / decoded.length > REPLACEMENT_OR_CONTROL_RATIO;
}
