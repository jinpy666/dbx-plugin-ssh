import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCKER_STATS,
  aggregateDockerStats,
  deriveDockerRates,
  formatBytes,
  formatPercent,
  formatRate,
  normalizeDockerStatSample,
  normalizeDockerStatsPayload,
  normalizeContainerIds,
  resolveDockerRates,
  type DockerStatSample,
} from "./dockerStats";

function sample(overrides: Partial<DockerStatSample> = {}): DockerStatSample {
  return {
    containerId: "3f2a1b4c5d6e",
    name: "web-1",
    cpuPercent: 12.34,
    memBytes: 1536,
    memLimitBytes: 2_469_606_195,
    memPercent: 0.01,
    netRxBytes: 1200,
    netTxBytes: 0,
    blockReadBytes: 4500,
    blockWriteBytes: 1100,
    pids: 7,
    ...overrides,
  };
}

describe("normalizeDockerStatsPayload", () => {
  it("keeps valid samples and coerces numeric fields", () => {
    const payload = normalizeDockerStatsPayload({
      available: true,
      needsSudo: false,
      sampledAt: 1732752000000,
      stats: [
        {
          containerId: "3f2a1b4c5d6e",
          name: "web-1",
          cpuPercent: "1.5",
          memBytes: 1536,
          memLimitBytes: 0,
          memPercent: 0.01,
          netRxBytes: 1200,
          netTxBytes: 0,
          netRxRate: 333,
          netTxRate: 0,
          blockReadBytes: 10,
          blockWriteBytes: 20,
          pids: 3,
        },
      ],
    });
    expect(payload.available).toBe(true);
    expect(payload.sampledAt).toBe(1732752000000);
    expect(payload.stats).toHaveLength(1);
    expect(payload.stats[0].cpuPercent).toBe(1.5);
    expect(payload.stats[0].netRxRate).toBe(333);
  });

  it("drops rows without an id and survives malformed payloads", () => {
    const payload = normalizeDockerStatsPayload({
      available: true,
      stats: [{ name: "no-id" }, null, 7, "row"],
    });
    expect(payload.stats).toEqual([]);
    expect(normalizeDockerStatsPayload(undefined)).toEqual(EMPTY_DOCKER_STATS);
    expect(normalizeDockerStatsPayload({ available: "yes" }).available).toBe(false);
  });

  it("rejects negative and non-finite numbers", () => {
    const normalized = normalizeDockerStatSample({
      containerId: "3f2a1b4c5d6e",
      cpuPercent: -1,
      memBytes: Number.POSITIVE_INFINITY,
      netRxBytes: "abc",
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.cpuPercent).toBe(0);
    expect(normalized?.memBytes).toBe(0);
    expect(normalized?.netRxBytes).toBe(0);
    expect(normalized?.netRxRate).toBeUndefined();
  });
});

describe("normalizeContainerIds", () => {
  it("trims, de-duplicates and caps the request ids", () => {
    expect(normalizeContainerIds([" aabbccddeeff ", "", "aabbccddeeff", "112233445566"])).toEqual([
      "aabbccddeeff",
      "112233445566",
    ]);
    expect(normalizeContainerIds(Array.from({ length: 60 }, (_, index) => `id${index}`))).toHaveLength(50);
  });
});

describe("deriveDockerRates", () => {
  it("differences cumulative counters over the window", () => {
    const rates = deriveDockerRates(
      sample({ netRxBytes: 1000, netTxBytes: 2000 }),
      sample({ netRxBytes: 4000, netTxBytes: 5000 }),
      3000,
    );
    expect(rates).toEqual({ netRxRate: 1000, netTxRate: 1000 });
  });

  it("returns zero without a baseline or inside the minimum window", () => {
    expect(deriveDockerRates(undefined, sample(), 3000)).toEqual({
      netRxRate: 0,
      netTxRate: 0,
    });
    expect(deriveDockerRates(sample(), sample({ netRxBytes: 9999 }), 100)).toEqual({
      netRxRate: 0,
      netTxRate: 0,
    });
  });

  it("treats a counter reset as zero instead of a negative rate", () => {
    expect(
      deriveDockerRates(
        sample({ netRxBytes: 9000 }),
        sample({ netRxBytes: 10 }),
        3000,
      ).netRxRate,
    ).toBe(0);
  });
});

describe("resolveDockerRates", () => {
  it("prefers the sidecar-provided rates when present", () => {
    const rates = resolveDockerRates(
      sample({ netRxRate: 42, netTxRate: 7 }),
      sample({ netRxBytes: 0 }),
      3000,
    );
    expect(rates).toEqual({ netRxRate: 42, netTxRate: 7 });
  });

  it("falls back to local diffing for payloads without rate fields", () => {
    const rates = resolveDockerRates(
      sample({ netRxBytes: 4096, netTxBytes: 0 }),
      sample({ netRxBytes: 1024, netTxBytes: 0 }),
      3000,
    );
    expect(rates.netRxRate).toBe(1024);
  });
});

describe("aggregateDockerStats", () => {
  it("sums usage and recomputes the memory percentage", () => {
    const totals = aggregateDockerStats([
      sample({ cpuPercent: 1.25, memBytes: 1024, memLimitBytes: 2048, netRxRate: 100, pids: 2 }),
      sample({ containerId: "aabbccddeeff", cpuPercent: 2.5, memBytes: 1024, memLimitBytes: 2048, netRxRate: 50, pids: 3 }),
    ]);
    expect(totals.containers).toBe(2);
    expect(totals.cpuPercent).toBe(3.75);
    expect(totals.memBytes).toBe(2048);
    expect(totals.memPercent).toBe(50);
    expect(totals.netRxRate).toBe(150);
    expect(totals.pids).toBe(5);
  });

  it("returns zeros for an empty list", () => {
    expect(aggregateDockerStats([])).toMatchObject({ containers: 0, cpuPercent: 0, memPercent: 0 });
  });
});

describe("formatters", () => {
  it("formats bytes in 1024-based units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(2_469_606_195)).toBe("2.3 GiB");
    expect(formatBytes(120 * 1024 * 1024 * 1024)).toBe("120 GiB");
  });

  it("formats rates and percentages", () => {
    expect(formatRate(1200)).toBe("1.2 KiB/s");
    expect(formatPercent(12.34)).toBe("12.3%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("0%");
  });
});
