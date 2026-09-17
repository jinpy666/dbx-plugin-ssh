import { describe, expect, it } from "vitest";
import { pushSample, sparklinePath, METRICS_SAMPLE_CAPACITY } from "./metricsSparkline";

describe("metrics sparkline sample ring", () => {
  it("appends samples and caps the window at 60 entries", () => {
    expect(METRICS_SAMPLE_CAPACITY).toBe(60);
    let ring: number[] = [];
    for (let index = 1; index <= METRICS_SAMPLE_CAPACITY + 5; index++) {
      ring = pushSample(ring, index);
    }
    expect(ring).toHaveLength(METRICS_SAMPLE_CAPACITY);
    // Oldest samples (1..5) evicted, newest kept in order.
    expect(ring[0]).toBe(6);
    expect(ring[ring.length - 1]).toBe(65);
  });

  it("never mutates the input ring and treats negative samples as 0", () => {
    const ring = [1, 2, 3];
    const next = pushSample(ring, -7);
    expect(ring).toEqual([1, 2, 3]);
    expect(next).toEqual([1, 2, 3, 0]);
    expect(pushSample(ring, Number.NaN)).toEqual([1, 2, 3, 0]);
  });
});

describe("metrics sparkline path", () => {
  it("returns an empty path for no samples", () => {
    expect(sparklinePath([], 60, 18)).toBe("");
  });

  it("places a single sample on the middle line", () => {
    expect(sparklinePath([5], 60, 18)).toBe("0,9");
  });

  it("draws all-zero series along the bottom edge", () => {
    expect(sparklinePath([0, 0, 0], 60, 18)).toBe("0,18 30,18 60,18");
  });

  it("scales points by the series max", () => {
    expect(sparklinePath([0, 10, 5], 60, 18)).toBe("0,18 30,0 60,9");
  });

  it("clamps oversized values to the top edge", () => {
    expect(sparklinePath([20, 10], 30, 10)).toBe("0,0 30,5");
  });
});
