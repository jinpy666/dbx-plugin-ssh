/**
 * Plugin-host bridge binary event normalization (shared by all plugins).
 *
 * The host bridge changed the sandbox binary event shape: it now transfers
 * zero-copy bytes as `data: Uint8Array`, while Host API 1.0 bridges deliver
 * `dataBase64: string` (the base64 field is gone from current bridges). Every
 * onBinary consumer — terminal output frames, SFTP/files download chunks —
 * must render on either host, so they funnel through this helper instead of
 * decoding one fixed field.
 *
 * 宿主适配公共代码一律放 shared/frontend/，插件前端以相对路径引用并在各自
 * spec 里保底测试；禁止在插件内各抄一份（见 AGENTS.md 硬性规则 7）。
 */

export interface BridgeBinaryEvent {
  channel: string;
  /** Current host bridge: zero-copy bytes transferred with the message. */
  data?: Uint8Array;
  /** Legacy host bridge: base64-encoded payload. */
  dataBase64?: string;
}

export function bridgeBinaryBytes(
  event: BridgeBinaryEvent,
  decodeBase64: (value: string) => Uint8Array,
): Uint8Array {
  if (event.data instanceof Uint8Array) return event.data;
  return decodeBase64(event.dataBase64 ?? "");
}
