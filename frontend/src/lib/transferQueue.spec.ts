import { describe, expect, it } from "vitest";
import {
  clampTransferConcurrency,
  clampTransferDownloadLimit,
  clampTransferMaxActive,
  nextRunnable,
  runTransfers,
  transferSlotsInUse,
  type TransferQueueItem,
} from "./transferQueue";

function queue(items: Array<[string, TransferQueueItem["direction"], TransferQueueItem["status"]]>): TransferQueueItem[] {
  return items.map(([id, direction, status]) => ({ id, direction, status }));
}

describe("transferSlotsInUse (running + paused occupy, cancelled/done release)", () => {
  it("counts running and paused items as occupied slots", () => {
    const items = queue([
      ["a", "upload", "running"],
      ["b", "upload", "paused"],
      ["c", "upload", "queued"],
    ]);
    expect(transferSlotsInUse(items)).toBe(2);
  });

  it("frees slots for done and cancelled items", () => {
    const items = queue([
      ["a", "download", "done"],
      ["b", "download", "cancelled"],
    ]);
    expect(transferSlotsInUse(items)).toBe(0);
  });
});

describe("nextRunnable (per-direction balanced scheduling)", () => {
  it("returns null when every slot is taken", () => {
    const items = queue([
      ["a", "upload", "running"],
      ["b", "upload", "paused"],
    ]);
    expect(nextRunnable(items, 2, 2)).toBeNull();
  });

  it("returns the first queued item when slots are free", () => {
    const items = queue([
      ["a", "upload", "done"],
      ["b", "upload", "queued"],
      ["c", "upload", "queued"],
    ]);
    expect(nextRunnable(items, 0, 3)?.id).toBe("b");
  });

  it("never schedules cancelled or done items", () => {
    const items = queue([
      ["a", "upload", "cancelled"],
      ["b", "upload", "done"],
    ]);
    expect(nextRunnable(items, 0, 2)).toBeNull();
  });

  it("balances directions: picks from the direction with fewer active slots", () => {
    const items = queue([
      ["u1", "upload", "queued"],
      ["d1", "download", "queued"],
      ["u2", "upload", "queued"],
    ]);
    const active = queue([
      ["r-up", "upload", "running"],
      ["r-up2", "upload", "running"],
      ["r-down", "download", "running"],
    ]);
    // Both directions have slots free globally (2 running of limit 4); upload
    // has 2 active, download 1 — the download candidate wins despite queue order.
    expect(nextRunnable([...active, ...items], 3, 4)?.id).toBe("d1");
  });

  it("keeps queue order within one direction", () => {
    const items = queue([
      ["u2", "upload", "queued"],
      ["u1", "upload", "queued"],
    ]);
    expect(nextRunnable(items, 0, 2)?.id).toBe("u2");
  });

  it("clamps a degenerate limit to at least one", () => {
    const items = queue([["a", "upload", "queued"]]);
    expect(nextRunnable(items, 0, 0)?.id).toBe("a");
    expect(nextRunnable(items, 1, 0)).toBeNull();
  });
});

describe("clampTransferConcurrency", () => {
  it("clamps into 1..10 with a default of 3", () => {
    expect(clampTransferConcurrency(3)).toBe(3);
    expect(clampTransferConcurrency(0)).toBe(1);
    expect(clampTransferConcurrency(-5)).toBe(1);
    expect(clampTransferConcurrency(11)).toBe(10);
    expect(clampTransferConcurrency(Number.NaN)).toBe(3);
    expect(clampTransferConcurrency(4.7)).toBe(4);
  });
});

describe("clampTransferMaxActive", () => {
  it("clamps into 1..8 with a default of 3", () => {
    expect(clampTransferMaxActive(3)).toBe(3);
    expect(clampTransferMaxActive(0)).toBe(1);
    expect(clampTransferMaxActive(-5)).toBe(1);
    expect(clampTransferMaxActive(9)).toBe(8);
    expect(clampTransferMaxActive(Number.NaN)).toBe(3);
    expect(clampTransferMaxActive(2.9)).toBe(2);
    expect(clampTransferMaxActive("4")).toBe(4);
  });
});

describe("clampTransferDownloadLimit (issue #66)", () => {
  it("keeps 0 = unlimited as the fallback and clamps into 0..1048576", () => {
    expect(clampTransferDownloadLimit(0)).toBe(0);
    expect(clampTransferDownloadLimit(undefined)).toBe(0);
    expect(clampTransferDownloadLimit(Number.NaN)).toBe(0);
    expect(clampTransferDownloadLimit("abc")).toBe(0);
    expect(clampTransferDownloadLimit(-5)).toBe(0);
    expect(clampTransferDownloadLimit(1.9)).toBe(1);
    expect(clampTransferDownloadLimit(512)).toBe(512);
    expect(clampTransferDownloadLimit(2_000_000)).toBe(1_048_576);
  });
});

describe("runTransfers (orchestration over the pure scheduler)", () => {
  it("runs items up to the concurrency limit and completes them all", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, direction: "upload" as const }));
    await runTransfers(items, 2, {
      id: (item) => item.id,
      run: async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        order.push(item.id);
        inFlight -= 1;
      },
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(order).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("respects per-direction balancing with mixed queues", async () => {
    const started: string[] = [];
    const items = [
      { id: "u1", direction: "upload" as const },
      { id: "d1", direction: "download" as const },
    ];
    await runTransfers(items, 1, {
      id: (item) => item.id,
      run: async (item) => {
        started.push(item.id);
        await Promise.resolve();
      },
    });
    expect(started).toEqual(["u1", "d1"]);
  });

  it("propagates worker failures and stops scheduling new items", async () => {
    const ran: string[] = [];
    const items = [{ id: "a", direction: "upload" as const }, { id: "b", direction: "upload" as const }, { id: "c", direction: "upload" as const }];
    await expect(
      runTransfers(items, 2, {
        id: (item) => item.id,
        run: async (item) => {
          ran.push(item.id);
          if (item.id === "a") throw new Error("cancelled transfer");
        },
      }),
    ).rejects.toThrow("cancelled transfer");
    // Worker a fails immediately; worker b may still finish its own item, but
    // no further items are picked up after the failure.
    expect(ran).not.toContain("c");
  });
});
