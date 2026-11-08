/**
 * VNC 剪贴板回声抑制。
 *
 * 本地 → 远端走 `vnc/set-clipboard`（RFB ClientCutText），部分服务端会把新
 * 剪贴板内容再以 ServerCutText 回送一次。回送值与我们刚发的完全相同时，再
 * 写回本地剪贴板既没意义，还会把用户随后复制的新内容盖掉（表现为「第一次
 * 粘贴之后，再复制就不生效」）。这里记录最近一次外发内容与时间，命中回声
 * 就跳过写回。
 */

const ECHO_WINDOW_MS = 5000;

let lastSentText = "";
let lastSentAt = 0;

export function rememberOutboundVncClipboard(text: string): void {
  lastSentText = text;
  lastSentAt = Date.now();
}

export function isInboundVncClipboardEcho(text: string): boolean {
  if (!text || text !== lastSentText) return false;
  return Date.now() - lastSentAt <= ECHO_WINDOW_MS;
}
