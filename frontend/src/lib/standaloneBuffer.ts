/**
 * Standalone ArrayBuffer normalization for `fileTransfer.write` payloads.
 *
 * The host bridge's write branch puts the payload straight into postMessage's
 * transfer list; Chromium rejects a `Uint8Array` view there with
 * "Failed to execute 'postMessage' on 'Window': Value at index 0 does not
 * have a transferable type." (only ArrayBuffer/MessagePort/ImageBitmap are
 * transferable). Passing a plain ArrayBuffer takes the bridge's valid branch,
 * so every caller hands over a standalone buffer whose byte range covers the
 * whole underlying storage — no copy when the view already is standalone.
 */

export function standaloneArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = data.buffer;
  if (buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buffer.byteLength) return buffer;
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}
