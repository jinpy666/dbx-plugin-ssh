import { describe, expect, it } from "vitest";
import { isCountdownActive, nextCountdownValue, RECORD_COUNTDOWN_START } from "./recordingCountdown";

describe("recording countdown state machine", () => {
  it("counts 3 → 2 → 1 → null (start signal)", () => {
    let value: number | null = RECORD_COUNTDOWN_START;
    expect(value).toBe(3);
    value = nextCountdownValue(value);
    expect(value).toBe(2);
    value = nextCountdownValue(value);
    expect(value).toBe(1);
    value = nextCountdownValue(value);
    expect(value).toBeNull();
  });

  it("is idempotent when idle", () => {
    expect(nextCountdownValue(null)).toBeNull();
  });

  it("never goes below zero for defensive inputs", () => {
    expect(nextCountdownValue(0)).toBeNull();
    expect(nextCountdownValue(-5)).toBeNull();
  });

  it("reports activity for Esc-chain gating", () => {
    expect(isCountdownActive(3)).toBe(true);
    expect(isCountdownActive(null)).toBe(false);
  });
});
