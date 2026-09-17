/**
 * Workbench remount session discovery. A session belongs to one workbench;
 * matching only that workbench prevents a new tab for the same saved
 * connection from attaching to (and taking over) another tab's PTY.
 */

export interface SessionSummary {
  sessionId: string;
  connectionId?: string;
  workbenchId?: string;
  connected?: boolean;
  /** Unix seconds; the sidecar lists sessions oldest-first. */
  createdAt?: number;
}

/**
 * Picks the sidecar session a remounting workbench should attach to. Returns
 * "" when that exact workbench has no live session — the caller falls back to
 * a fresh `ssh/session/open`, which is also how a new same-connection tab gets
 * its independent PTY.
 */
export function pickLiveSessionForReattach(
  sessions: SessionSummary[] | undefined,
  options: { connectionId: string; workbenchId: string },
): string {
  const connectionId = String(options.connectionId || "");
  if (!connectionId) return "";
  const candidates = (Array.isArray(sessions) ? sessions : []).filter(
    (session) =>
      session &&
      typeof session.sessionId === "string" &&
      session.sessionId &&
      session.connectionId === connectionId &&
      session.connected !== false,
  );
  if (candidates.length === 0) return "";
  const sameWorkbench = candidates.filter((session) => session.workbenchId === options.workbenchId);
  if (sameWorkbench.length === 0) return "";
  const newest = sameWorkbench.reduce((best, session) =>
    (session.createdAt ?? 0) >= (best.createdAt ?? 0) ? session : best,
  );
  return newest.sessionId;
}
