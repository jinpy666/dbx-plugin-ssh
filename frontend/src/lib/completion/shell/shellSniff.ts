import type { Terminal } from "@xterm/xterm";
import { detectShellKind } from "./shellBuiltins";

/** Windows shell 提示符采样（shellBuiltins 兜底源的 detect 回调，自
 * useCommandSuggestions 纯搬移）：光标行起向上至多 3 行里找 `PS C:\…>` /
 * `C:\…>` 形态提示符。POSIX 提示符不命中，行为与直连 fig 引擎一致。
 * TTL 1s：键入路径每次调度都会问一次，miss 也廉价（3 行 buffer 扫描）；
 * 短 TTL 保证会话早期（提示符刚到达）尽快收敛。 */
export function createTerminalShellSniffer(termGet: () => Terminal | undefined): () => "powershell" | "cmd" | null {
  const terminalShellSniff = { kind: null as "powershell" | "cmd" | null, at: 0 };
  return () => {
    const now = Date.now();
    if (now - terminalShellSniff.at < 1000) return terminalShellSniff.kind;
    terminalShellSniff.at = now;
    terminalShellSniff.kind = null;
    try {
      const term = termGet();
      if (!term) return null;
      const buffer = term.buffer.active;
      if (buffer.type !== "normal") return null;
      const cursorRow = buffer.baseY + Math.min(buffer.cursorY, buffer.length - 1);
      for (let rowY = cursorRow; rowY >= Math.max(0, cursorRow - 2); rowY -= 1) {
        const text = buffer.getLine(rowY)?.translateToString(true) ?? "";
        const kind = detectShellKind(text);
        if (kind) {
          terminalShellSniff.kind = kind;
          break;
        }
      }
    } catch {
      return null;
    }
    return terminalShellSniff.kind;
  };
}
