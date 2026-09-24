import { describe, expect, it } from "vitest";
import {
  createSessionTransportReuseState,
  fallbackToFreshTransport,
  markSessionTransportOpenSucceeded,
  sessionTransportOpenParams,
} from "./sessionTransportReuse";

describe("session transport reuse state", () => {
  it("consumes duplicate intent after the first successful open", () => {
    const state = createSessionTransportReuseState({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: "source-session",
    });

    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: "source-session",
    });

    markSessionTransportOpenSucceeded(state, "copied-session");

    expect(state).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: "copied-session",
    });
    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: undefined,
    });
  });

  it("can fail over exactly once to a fresh authenticated transport", () => {
    const state = createSessionTransportReuseState({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: "dead-source",
    });

    expect(fallbackToFreshTransport(state)).toBe(true);
    expect(fallbackToFreshTransport(state)).toBe(false);
    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: undefined,
    });
  });

  it("preserves the boolean-only compatibility request", () => {
    const state = createSessionTransportReuseState({
      reuseAuthenticatedTransport: true,
    });

    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: undefined,
    });
  });
});
