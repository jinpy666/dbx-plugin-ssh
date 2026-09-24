export interface SessionTransportReuseState {
  reuseAuthenticatedTransport: boolean;
  reuseAuthenticatedSessionId: string | undefined;
}

function sourceSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Duplicate intent is deliberately local and one-shot. The host context is
 * immutable for the lifetime of a workbench, but every successful open turns
 * that copied tab into an ordinary session whose future reconnects must be
 * allowed to perform a fresh SSH authentication.
 */
export function createSessionTransportReuseState(context: Record<string, unknown>): SessionTransportReuseState {
  const sourceId = sourceSessionId(context.reuseAuthenticatedSessionId);
  return {
    // Keep the boolean-only compatibility contract: older hosts do not pass
    // a source id and the backend deterministically chooses a live transport.
    reuseAuthenticatedTransport: context.reuseAuthenticatedTransport === true,
    reuseAuthenticatedSessionId: sourceId,
  };
}

export function sessionTransportOpenParams(state: SessionTransportReuseState) {
  return {
    reuseAuthenticatedTransport: state.reuseAuthenticatedTransport,
    reuseAuthenticatedSessionId: state.reuseAuthenticatedTransport
      ? state.reuseAuthenticatedSessionId
      : undefined,
  };
}

export function markSessionTransportOpenSucceeded(state: SessionTransportReuseState, sessionId: string): void {
  state.reuseAuthenticatedTransport = false;
  state.reuseAuthenticatedSessionId = sourceSessionId(sessionId);
}

/** Switches one pending duplicate open to a normal fresh-login open. */
export function fallbackToFreshTransport(state: SessionTransportReuseState): boolean {
  if (!state.reuseAuthenticatedTransport) return false;
  state.reuseAuthenticatedTransport = false;
  state.reuseAuthenticatedSessionId = undefined;
  return true;
}
