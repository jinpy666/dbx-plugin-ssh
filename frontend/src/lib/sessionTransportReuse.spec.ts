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
      spawnCommand: undefined,
    });

    markSessionTransportOpenSucceeded(state, "copied-session");

    expect(state).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: "copied-session",
      spawnCommand: undefined,
    });
    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: undefined,
      spawnCommand: undefined,
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
      spawnCommand: undefined,
    });
  });

  it("preserves the boolean-only compatibility request", () => {
    const state = createSessionTransportReuseState({
      reuseAuthenticatedTransport: true,
    });

    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: undefined,
      spawnCommand: undefined,
    });
  });

  // WT-4 (WezTerm spawn parity): the command rides the same one-shot state —
  // it must survive the duplicate→fresh-login fallback so the user's command
  // intent is not lost, and it must be consumed after the first successful
  // open so this tab's future reconnects stay ordinary shell sessions.
  it("keeps the spawn command through the fresh-login fallback and drops it after success", () => {
    const state = createSessionTransportReuseState({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: "source-session",
      spawnCommand: "htop --tree",
    });

    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: true,
      reuseAuthenticatedSessionId: "source-session",
      spawnCommand: "htop --tree",
    });

    expect(fallbackToFreshTransport(state)).toBe(true);
    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: undefined,
      spawnCommand: "htop --tree",
    });

    markSessionTransportOpenSucceeded(state, "spawned-session");
    expect(sessionTransportOpenParams(state)).toEqual({
      reuseAuthenticatedTransport: false,
      reuseAuthenticatedSessionId: undefined,
      spawnCommand: undefined,
    });
  });

  it("ignores blank or non-string spawn commands from the host context", () => {
    expect(createSessionTransportReuseState({ spawnCommand: "   " }).spawnCommand).toBeUndefined();
    expect(createSessionTransportReuseState({ spawnCommand: 42 }).spawnCommand).toBeUndefined();
    expect(createSessionTransportReuseState({}).spawnCommand).toBeUndefined();
    expect(createSessionTransportReuseState({ spawnCommand: "htop" }).spawnCommand).toBe("htop");
  });
});
