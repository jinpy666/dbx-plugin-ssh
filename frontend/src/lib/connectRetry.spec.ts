import { describe, expect, it } from "vitest";
import {
  decideConnectRetry,
  INACTIVE_RETRY_DELAY_MS,
  INACTIVE_RETRY_MAX,
  isPermanentConnectError,
  OPEN_RETRY_BASE_DELAY_MS,
  OPEN_RETRY_FAST_FAIL_WINDOW_MS,
  PRECONNECT_RETRY_DELAY_MS,
  PRECONNECT_RETRY_MAX,
} from "./connectRetry";

const BASE = { attempt: 0, maxAttempts: 3, attemptMs: 100, inactive: false, bootRestore: false };

describe("isPermanentConnectError", () => {
  it("treats auth and host-key rejections as permanent", () => {
    expect(isPermanentConnectError(new Error("SSH password authentication failed: password rejected by server"))).toBe(true);
    expect(isPermanentConnectError(new Error("SSH connection failed: Permission denied (publickey)"))).toBe(true);
    expect(isPermanentConnectError("SSH connection failed: UnknownKey")).toBe(true);
    expect(isPermanentConnectError(new Error("SSH handshake completed without presenting a host key"))).toBe(true);
    expect(isPermanentConnectError(new Error("No live authenticated SSH connection is available to duplicate; use New session to reconnect"))).toBe(true);
    expect(isPermanentConnectError(new Error("The authenticated SSH connection can no longer be reused; use New session to reconnect"))).toBe(true);
  });

  it("treats transient transport failures as retryable", () => {
    expect(isPermanentConnectError(new Error("SSH connection failed: Connection refused (os error 61)"))).toBe(false);
    expect(isPermanentConnectError(new Error("SSH connection to dbx-ssh-test:22 timed out"))).toBe(false);
    expect(isPermanentConnectError(new Error("boot race"))).toBe(false);
  });
});

describe("decideConnectRetry", () => {
  it("retries fast failures within the window and escalates the backoff", () => {
    const first = decideConnectRetry({ ...BASE, cause: new Error("boot race") });
    expect(first).toEqual({ kind: "retry", attempt: 1, delayMs: OPEN_RETRY_BASE_DELAY_MS * 1 });
    const second = decideConnectRetry({ ...BASE, attempt: 1, cause: new Error("boot race") });
    expect(second).toEqual({ kind: "retry", attempt: 2, delayMs: OPEN_RETRY_BASE_DELAY_MS * 2 });
    const third = decideConnectRetry({ ...BASE, attempt: 2, cause: new Error("boot race") });
    expect(third).toEqual({ kind: "retry", attempt: 3, delayMs: OPEN_RETRY_BASE_DELAY_MS * 3 });
  });

  it("stops after the attempt budget is exhausted (counter must survive re-entry)", () => {
    const exhausted = decideConnectRetry({ ...BASE, attempt: 3, cause: new Error("boot race") });
    expect(exhausted).toEqual({ kind: "fail" });
    expect(decideConnectRetry({ ...BASE, attempt: 9, cause: new Error("boot race") })).toEqual({ kind: "fail" });
  });

  it("fails an attempt that already ran past the fast-fail window", () => {
    const slow = decideConnectRetry({ ...BASE, attemptMs: OPEN_RETRY_FAST_FAIL_WINDOW_MS, cause: new Error("dial died") });
    expect(slow).toEqual({ kind: "fail" });
  });

  it("fails permanent auth/host-key errors immediately without burning retries", () => {
    const decision = decideConnectRetry({ ...BASE, cause: new Error("SSH password authentication failed: password rejected by server") });
    expect(decision).toEqual({ kind: "fail" });
    expect(decideConnectRetry({ ...BASE, cause: new Error("SSH connection failed: UnknownKey") })).toEqual({ kind: "fail" });
  });

  it("polls inactive-connection errors on manual entries for a bounded window, then fails", () => {
    const first = decideConnectRetry({ ...BASE, inactive: true, cause: new Error("Connection is not active") });
    expect(first).toEqual({ kind: "retry", attempt: 1, delayMs: INACTIVE_RETRY_DELAY_MS });
    const last = decideConnectRetry({ ...BASE, attempt: INACTIVE_RETRY_MAX - 1, inactive: true, cause: new Error("Connection is not active") });
    expect(last).toEqual({ kind: "retry", attempt: INACTIVE_RETRY_MAX, delayMs: INACTIVE_RETRY_DELAY_MS });
    const exhausted = decideConnectRetry({ ...BASE, attempt: INACTIVE_RETRY_MAX, inactive: true, cause: new Error("Connection is not active") });
    expect(exhausted).toEqual({ kind: "fail" });
  });

  it("keeps the regular backoff ladder for inactive errors during boot restore", () => {
    const restored = decideConnectRetry({ ...BASE, inactive: true, bootRestore: true, cause: new Error("Connection is not active") });
    expect(restored).toEqual({ kind: "retry", attempt: 1, delayMs: OPEN_RETRY_BASE_DELAY_MS });
  });

  it("polls inactive errors at the short preconnect cadence while waiting for the host pre-dial", () => {
    const first = decideConnectRetry({ ...BASE, inactive: true, bootRestore: true, preconnect: true, cause: new Error("Connection is not active") });
    expect(first).toEqual({ kind: "retry", attempt: 1, delayMs: PRECONNECT_RETRY_DELAY_MS });
    const last = decideConnectRetry({ ...BASE, attempt: PRECONNECT_RETRY_MAX - 1, inactive: true, bootRestore: true, preconnect: true, cause: new Error("Connection is not active") });
    expect(last).toEqual({ kind: "retry", attempt: PRECONNECT_RETRY_MAX, delayMs: PRECONNECT_RETRY_DELAY_MS });
    const exhausted = decideConnectRetry({ ...BASE, attempt: PRECONNECT_RETRY_MAX, inactive: true, bootRestore: true, preconnect: true, cause: new Error("Connection is not active") });
    expect(exhausted).toEqual({ kind: "fail" });
  });

  it("ignores the preconnect flag without an inactive error (regular ladder applies)", () => {
    const decision = decideConnectRetry({ ...BASE, bootRestore: true, preconnect: true, cause: new Error("boot race") });
    expect(decision).toEqual({ kind: "retry", attempt: 1, delayMs: OPEN_RETRY_BASE_DELAY_MS });
  });
});
