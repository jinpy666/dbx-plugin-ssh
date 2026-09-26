export interface SessionTransportReuseState {
  reuseAuthenticatedTransport: boolean;
  reuseAuthenticatedSessionId: string | undefined;
  /** WT-4 (WezTerm `spawn` parity): one-shot command for the new channel. */
  spawnCommand: string | undefined;
}

function sourceSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function spawnCommand(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Duplicate intent is deliberately local and one-shot. The host context is
 * immutable for the lifetime of a workbench, but every successful open turns
 * that copied tab into an ordinary session whose future reconnects must be
 * allowed to perform a fresh SSH authentication. The same one-shot rule
 * covers `spawnCommand`: a command session tab reconnects as an ordinary
 * shell session, so a finished command is never re-executed blindly.
 */
export function createSessionTransportReuseState(context: Record<string, unknown>): SessionTransportReuseState {
  const sourceId = sourceSessionId(context.reuseAuthenticatedSessionId);
  return {
    // Keep the boolean-only compatibility contract: older hosts do not pass
    // a source id and the backend deterministically chooses a live transport.
    reuseAuthenticatedTransport: context.reuseAuthenticatedTransport === true,
    reuseAuthenticatedSessionId: sourceId,
    spawnCommand: spawnCommand(context.spawnCommand),
  };
}

export function sessionTransportOpenParams(state: SessionTransportReuseState) {
  return {
    reuseAuthenticatedTransport: state.reuseAuthenticatedTransport,
    reuseAuthenticatedSessionId: state.reuseAuthenticatedTransport
      ? state.reuseAuthenticatedSessionId
      : undefined,
    // Orthogonal to the reuse flags: the command survives the one-time
    // fallback to a fresh login, then the one-shot consumption below drops
    // it for this tab's future reconnects.
    spawnCommand: state.spawnCommand,
  };
}

export function markSessionTransportOpenSucceeded(state: SessionTransportReuseState, sessionId: string): void {
  state.reuseAuthenticatedTransport = false;
  state.reuseAuthenticatedSessionId = sourceSessionId(sessionId);
  state.spawnCommand = undefined;
}

/** Switches one pending duplicate open to a normal fresh-login open. */
export function fallbackToFreshTransport(state: SessionTransportReuseState): boolean {
  if (!state.reuseAuthenticatedTransport) return false;
  state.reuseAuthenticatedTransport = false;
  state.reuseAuthenticatedSessionId = undefined;
  return true;
}
