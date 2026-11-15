import { describe, expect, it } from "vitest";
import { pushSample, smoothSparklinePath, sparklinePath, sparklineSegments, METRICS_SAMPLE_CAPACITY } from "./metricsSparkline";

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

  it("honors an explicit shared max while keeping the default behavior unchanged", () => {
    // Explicit max: [4,4] against max 8 → half height; oversized values still clamp to the top.
    expect(sparklinePath([4, 4], 60, 18, 8)).toBe("0,9 60,9");
    expect(sparklinePath([16, 4], 60, 18, 8)).toBe("0,0 60,9");
    // Non-positive explicit max falls back to the bottom edge like the derived max of an all-zero series.
    expect(sparklinePath([4, 4], 60, 18, 0)).toBe("0,18 60,18");
    // Default behavior (max derived from the series) is untouched.
    expect(sparklinePath([0, 10, 5], 60, 18)).toBe("0,18 30,0 60,9");
  });

  it("smooths real samples into cubic curves and optional closed areas", () => {
    const line = smoothSparklinePath("0,18 30,4 60,10");
    expect(line).toContain("M 0,18 C");
    expect(line).toContain("60,10");
    expect(line).not.toContain("Z");
    const area = smoothSparklinePath("0,18 30,4 60,10", 18);
    expect(area).toContain("L 60,18 L 0,18 Z");
    expect(smoothSparklinePath("")).toBe("");
    expect(smoothSparklinePath("0,9")).toBe("M 0,9");
  });
});

describe("gap-aware segmented sparklines (monitor panel)", () => {
  it("returns no segments for an empty series or an all-gap window", () => {
    expect(sparklineSegments([], [], 60, 18)).toEqual([]);
    expect(sparklineSegments([1, 2, 3], [true, true, true], 60, 18)).toEqual([]);
    // Missing flag entries count as samples, but an empty series stays empty.
    expect(sparklineSegments([], [false], 60, 18)).toEqual([]);
  });

  it("matches sparklinePath exactly when there is no gap", () => {
    expect(sparklineSegments([0, 10, 5], [false, false, false], 60, 18)).toEqual([sparklinePath([0, 10, 5], 60, 18)]);
    expect(sparklineSegments([5], [false], 60, 18)).toEqual(["0,9"]);
    // Degenerate dimensions produce no drawable segments, mirroring sparklinePath's "" guard.
    expect(sparklineSegments([1, 2], [false, false], 0, 18)).toEqual([]);
    expect(sparklineSegments([1, 2], [false, false], 60, 0)).toEqual([]);
  });

  it("splits at gaps into per-segment polylines that keep their global x positions", () => {
    // Series [1,2,gap,3]: x = 0/20/40/60 over the full window; segment A spans indices 0-1,
    // segment B (single point) sits at its own x on the middle line.
    expect(sparklineSegments([1, 2, 0, 3], [false, false, true, false], 60, 18)).toEqual([
      "0,12 20,6",
      "60,9",
    ]);
    // Leading gap: only the surviving segment renders.
    expect(sparklineSegments([0, 0, 4], [true, true, false], 60, 18)).toEqual(["60,9"]);
    // Trailing gap: the earlier segment renders and the gap tail adds nothing.
    expect(sparklineSegments([4, 0, 0], [false, true, true], 60, 18)).toEqual(["0,9"]);
  });

  it("shares one max across segments so segment proportions stay comparable", () => {
    // Series [8,gap,4,4]: shared max = 8 → segment B normalizes against 8 (half height),
    // not against its own max of 4 (which would pin it to the top edge).
    expect(sparklineSegments([8, 0, 4, 4], [false, true, false, false], 60, 18)).toEqual([
      "0,9",
      "40,9 60,9",
    ]);
  });
});
