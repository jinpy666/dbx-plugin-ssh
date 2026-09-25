// 连接信息面板的展示辅助（只读）：延迟数值来自 ssh/exec echo 往返计时，
// 认证方式名称来自 ssh/sessions/list 的 authMethod（仅方法名，无凭据）。
// 这里只负责格式化，纯函数。

/**
 * Normalize host-provided display text. DBX connection metadata can contain
 * actual nulls as well as serialized values such as `"null"`/`"undefined"`.
 * Treat those and whitespace-only values as missing so they never leak into
 * the toolbar or connection-info popover.
 */
export function normalizeConnectionText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "null" && normalized.toLowerCase() !== "undefined" ? normalized : "";
}

/** Normalize a host-provided SSH port; invalid/empty values remain absent. */
export function normalizeConnectionPort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535) return value;
  if (typeof value !== "string") return undefined;
  const text = normalizeConnectionText(value);
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/** 毫秒延迟 → "12 ms"；无测量值或非法输入返回 "–"。超过 1s 保留一位小数。 */
export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export const KNOWN_AUTH_METHODS = ["password", "private-key", "private-key-password", "agent", "auto", "none"] as const;
export type KnownAuthMethod = (typeof KNOWN_AUTH_METHODS)[number];

/** 认证方式展示标签：已知方法名走 translate 本地化，未知值原样展示，空缺返回占位符。 */
export function formatAuthMethodLabel(
  method: string | null | undefined,
  translate: (method: KnownAuthMethod) => string,
  placeholder = "–",
): string {
  const value = normalizeConnectionText(method);
  if (!value) return placeholder;
  if ((KNOWN_AUTH_METHODS as readonly string[]).includes(value)) return translate(value as KnownAuthMethod);
  return value;
}
