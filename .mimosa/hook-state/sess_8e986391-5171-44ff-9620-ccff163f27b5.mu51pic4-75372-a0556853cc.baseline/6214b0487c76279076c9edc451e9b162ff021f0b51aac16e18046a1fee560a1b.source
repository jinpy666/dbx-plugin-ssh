import { describe, expect, it } from "vitest";
import {
  decideConnectRetry,
  isPermanentConnectError,
  OPEN_RETRY_BASE_DELAY_MS,
  OPEN_RETRY_FAST_FAIL_WINDOW_MS,
} from "./connectRetry";

const BASE = { attempt: 0, maxAttempts: 3, attemptMs: 100, inactive: false, bootRestore: false };

describe("isPermanentConnectError", () => {
  it("treats auth and host-key rejections as permanent", () => {
    expect(isPermanentConnectError(new Error("SSH password authentication failed: password rejected by server"))).toBe(true);
    expect(isPermanentConnectError(new Error("SSH connection failed: Permission denied (publickey)"))).toBe(true);
    expect(isPermanentConnectError("SSH connection failed: UnknownKey")).toBe(true);
    expect(isPermanentConnectError(new Error("SSH handshake completed without presenting a host key"))).toBe(true);
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

  it("fails inactive-connection errors on manual entries but retries during boot restore", () => {
    expect(decideConnectRetry({ ...BASE, inactive: true, cause: new Error("Connection is not active") })).toEqual({ kind: "fail" });
    const restored = decideConnectRetry({ ...BASE, inactive: true, bootRestore: true, cause: new Error("Connection is not active") });
    expect(restored.kind).toBe("retry");
  });
});
