export const TERMINAL_RECONNECT_DELAYS = [500, 1000, 2000, 5000] as const;

export function terminalReconnectDelay(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return TERMINAL_RECONNECT_DELAYS[Math.min(normalizedAttempt, TERMINAL_RECONNECT_DELAYS.length - 1)];
}

export function shouldReattachTerminal(options: { disposed: boolean; state: "connecting" | "connected" | "disconnected" | "error"; expectedSessionId: string; currentSessionId?: string }): boolean {
  return !options.disposed && options.expectedSessionId === options.currentSessionId && (options.state === "connecting" || options.state === "connected");
}

/**
 * Matches the sidecar's stable "Connection is not active" open failure: the
 * host never delivered this connection's credentials to the sidecar (typical
 * after DBX restarted and restored the workbench tab without replaying the
 * connect lifecycle). Retrying cannot succeed until the user reopens the
 * connection from DBX, so the caller must fail fast instead of cycling the
 * boot-restore retry ladder.
 */
export function isConnectionInactiveError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return /Connection is not active/i.test(message);
}

export interface ReconnectRestoredNotice {
  /** i18n key: cwd variant when a path is known, plain variant otherwise. */
  key: "reconnectRestored.cwd" | "reconnectRestored.plain";
  values: Record<string, string>;
}

/**
 * Chooses the "connection restored" notice shown after an auto-reconnect
 * succeeds: surfaces the restored working-directory context when one is
 * available, or a plain restored message otherwise. Returns null when the
 * session connected normally (no reconnect happened), so no notice is shown.
 */
export function describeReconnectRestoredNotice(options: { wasReconnecting: boolean; path: string }): ReconnectRestoredNotice | null {
  if (!options.wasReconnecting) return null;
  const path = String(options.path || "").trim();
  if (path) return { key: "reconnectRestored.cwd", values: { path } };
  return { key: "reconnectRestored.plain", values: {} };
}

export interface ReconnectCountdown {
  /** Seconds until the retry fires, clamped at 0. */
  seconds: number;
  /** 1-based number of the retry that fires when the countdown ends. */
  attempt: number;
  /** 0-100 progress through the current backoff delay. */
  percent: number;
}

/**
 * Pure countdown math for the reconnecting status pill: turns the scheduled
 * retry timestamp into the seconds-left / percent-progress pair rendered by
 * App.vue. Returns null when no retry is pending or the schedule is stale
 * (clock drift past the deadline is clamped by the caller instead).
 */
export function describeReconnectCountdown(options: { pending: boolean; attempt: number; nextAt: number; now: number; delayMs: number }): ReconnectCountdown | null {
  if (!options.pending) return null;
  const nextAt = Number(options.nextAt);
  const delayMs = Number(options.delayMs);
  const attempt = Math.max(0, Math.floor(Number(options.attempt) || 0));
  if (!Number.isFinite(nextAt) || nextAt <= 0 || !Number.isFinite(delayMs) || delayMs <= 0) return null;
  const remainingMs = nextAt - options.now;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const percent = Math.round((Math.min(Math.max(delayMs - Math.max(0, remainingMs), 0), delayMs) / delayMs) * 100);
  return { seconds, attempt, percent };
}
