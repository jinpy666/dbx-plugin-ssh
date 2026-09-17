/**
 * Clipboard with host-bridge fallbacks.
 *
 * The plugin workbench iframe runs sandboxed (opaque origin), so
 * `navigator.clipboard` may reject even inside a user gesture, and the host
 * bridge `window.dbxPlugin.clipboard` is an optional Host API that current
 * hosts do not expose yet. Every path therefore degrades instead of failing:
 *
 * - write: host bridge → navigator.clipboard → hidden-textarea execCommand('copy')
 * - read:  host bridge → navigator.clipboard (keyboard paste bypasses this
 *   entirely via the native paste event, which carries the real clipboardData
 *   without needing any read permission — see interceptTerminalPaste in App.vue)
 */

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface ClipboardDeps {
  bridge?: ClipboardPort | null;
  nativeClipboard?: ClipboardPort | null;
  /** execCommand seam for tests; defaults to document.execCommand. */
  execCommand?: (command: string) => boolean;
}

export type ClipboardWritePath = "bridge" | "native" | "execCommand";

export async function writeClipboardText(text: string, deps: ClipboardDeps = {}): Promise<ClipboardWritePath> {
  if (deps.bridge) {
    try {
      await deps.bridge.writeText(text);
      return "bridge";
    } catch {
      // Bridge present but broken: keep degrading.
    }
  }
  if (deps.nativeClipboard) {
    try {
      await deps.nativeClipboard.writeText(text);
      return "native";
    } catch {
      // Sandboxed iframes often reject this even with user activation.
    }
  }
  if (copyViaExecCommand(text, deps.execCommand)) return "execCommand";
  throw new Error("clipboard write unavailable");
}

export async function readClipboardText(deps: ClipboardDeps = {}): Promise<string> {
  if (deps.bridge) {
    try {
      return await deps.bridge.readText();
    } catch {
      // Fall through to the Web Clipboard API.
    }
  }
  if (deps.nativeClipboard) {
    try {
      return await deps.nativeClipboard.readText();
    } catch {
      // Permissions Policy denies reads for opaque origins; the caller should
      // steer the user to the keyboard paste path instead.
    }
  }
  throw new Error("clipboard read unavailable");
}

function copyViaExecCommand(text: string, execCommand?: (command: string) => boolean): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.dataset.dbxClipboard = "true";
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = (execCommand ?? document.execCommand.bind(document))("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
