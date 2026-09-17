// Session status semantics, ported from tiny-rdm's modules/ssh/session-status.js
// and extended with the workbench's own "reconnecting" phase. The plugin runs a
// single SSH session per workbench, so `findPreferredSshSession` (multi-session
// selection) has no counterpart here; what we port is the status normalization
// used to render a consistent status pill no matter which string the host,
// sidecar events, or reconnect bookkeeping produce.

export type NormalizedSshSessionStatus = "connected" | "connecting" | "idle" | "disconnected" | "error" | "ready";

export type WorkbenchSessionStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

/** Terminal pane state kept by App.vue. */
export type WorkbenchTerminalState = "connecting" | "connected" | "disconnected" | "error";

export function normalizeSshSessionStatus(sessionOrStatus: unknown): NormalizedSshSessionStatus {
  const raw = typeof sessionOrStatus === "string" ? sessionOrStatus : String((sessionOrStatus as { status?: unknown } | null)?.status || "");
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return "disconnected";
  if (normalized === "connected" || normalized === "ready") return "connected";
  if (normalized === "connecting" || normalized === "pending" || normalized === "dialing" || normalized === "opening") return "connecting";
  if (normalized === "idle" || normalized === "paused") return "idle";
  if (normalized === "closed" || normalized === "disconnected" || normalized === "stopped") return "disconnected";
  if (normalized === "error" || normalized === "failed" || normalized === "timeout") return "error";
  return normalized.includes("connect")
    ? "connecting"
    : normalized.includes("error") || normalized.includes("fail")
      ? "error"
      : "ready";
}

export function isUsableSshSession(sessionOrStatus: unknown): boolean {
  const status = normalizeSshSessionStatus(sessionOrStatus);
  return status === "connected" || status === "connecting" || status === "idle";
}

/**
 * Maps the terminal pane state plus the reconnect bookkeeping onto the
 * user-facing status vocabulary: 连接中/已连接/重连中/已断开/错误.
 * While `attachSession` is inside its bounded backoff loop the pane reports
 * "connecting"; surfacing that as its own "reconnecting" phase is the only
 * addition over tiny-rdm's normalize step.
 */
export function describeWorkbenchSessionStatus(state: WorkbenchTerminalState | string, options: { reattaching?: boolean } = {}): WorkbenchSessionStatus {
  const normalized = normalizeSshSessionStatus(state);
  if (normalized === "connecting" && options.reattaching) return "reconnecting";
  if (normalized === "connected" || normalized === "idle") return "connected";
  if (normalized === "connecting") return "connecting";
  if (normalized === "error") return "error";
  return "disconnected";
}
