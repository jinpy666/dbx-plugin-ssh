import { describe, expect, it } from "vitest";
import {
  dropWatch,
  enqueueWatchModified,
  popWatchModified,
  registerWatch,
  watchName,
  type ModifiedPrompt,
  type WatchRegistry,
} from "./watchEdits";

const entry = (watchId: string, name: string, remotePath: string) => ({ watchId, name, remotePath });

describe("registerWatch", () => {
  it("keeps multiple parallel watches in one registry", () => {
    let watches: WatchRegistry = {};
    watches = registerWatch(watches, entry("w-1", "a.txt", "/remote/a.txt"));
    watches = registerWatch(watches, entry("w-2", "b.txt", "/remote/b.txt"));
    expect(Object.keys(watches).sort()).toEqual(["w-1", "w-2"]);
    expect(watches["w-1"].name).toBe("a.txt");
    expect(watches["w-2"].remotePath).toBe("/remote/b.txt");
  });

  it("replaces the stale watchId of the same remote path", () => {
    let watches: WatchRegistry = {};
    watches = registerWatch(watches, entry("w-1", "a.txt", "/remote/a.txt"));
    watches = registerWatch(watches, entry("w-2", "b.txt", "/remote/b.txt"));
    // 重新打开 a.txt：sidecar dedup 停掉 w-1 颁发 w-3，注册表按 remotePath 顶替。
    watches = registerWatch(watches, entry("w-3", "a.txt", "/remote/a.txt"));
    expect(watches["w-1"]).toBeUndefined();
    expect(watches["w-3"].name).toBe("a.txt");
    expect(watches["w-2"]).toBeDefined();
  });

  it("ignores incomplete entries", () => {
    let watches: WatchRegistry = {};
    watches = registerWatch(watches, entry("", "a.txt", "/remote/a.txt"));
    watches = registerWatch(watches, entry("w-1", "", "/remote/a.txt"));
    watches = registerWatch(watches, entry("w-1", "a.txt", ""));
    expect(watches).toEqual({});
  });
});

describe("dropWatch", () => {
  it("removes only the given watchId", () => {
    let watches: WatchRegistry = {};
    watches = registerWatch(watches, entry("w-1", "a.txt", "/remote/a.txt"));
    watches = registerWatch(watches, entry("w-2", "b.txt", "/remote/b.txt"));
    watches = dropWatch(watches, "w-1");
    expect(watches["w-1"]).toBeUndefined();
    expect(watches["w-2"].name).toBe("b.txt");
    // 未知 watchId：原样返回（不破坏引用）。
    expect(dropWatch(watches, "w-9")).toBe(watches);
  });
});

describe("watchName", () => {
  it("resolves names from the registry and falls back to empty", () => {
    const watches = registerWatch({}, entry("w-1", "a.txt", "/remote/a.txt"));
    expect(watchName(watches, "w-1")).toBe("a.txt");
    expect(watchName(watches, "w-x")).toBe("");
  });
});

describe("enqueueWatchModified", () => {
  const watches: WatchRegistry = {
    "w-1": entry("w-1", "a.txt", "/remote/a.txt"),
    "w-2": entry("w-2", "b.txt", "/remote/b.txt"),
  };

  it("queues each file's event so prompts never replace each other", () => {
    let queue: ModifiedPrompt[] = [];
    queue = enqueueWatchModified(queue, watches, "w-1");
    queue = enqueueWatchModified(queue, watches, "w-2");
    expect(queue).toEqual([
      { watchId: "w-1", name: "a.txt" },
      { watchId: "w-2", name: "b.txt" },
    ]);
  });

  it("drops unknown watchIds instead of prompting into nothing", () => {
    const queue = enqueueWatchModified([], watches, "w-dead");
    expect(queue).toEqual([]);
  });

  it("deduplicates a repeated save of the same pending file", () => {
    let queue: ModifiedPrompt[] = [];
    queue = enqueueWatchModified(queue, watches, "w-1");
    queue = enqueueWatchModified(queue, watches, "w-1");
    expect(queue).toEqual([{ watchId: "w-1", name: "a.txt" }]);
  });
});

describe("popWatchModified", () => {
  const queue: ModifiedPrompt[] = [
    { watchId: "w-1", name: "a.txt" },
    { watchId: "w-2", name: "b.txt" },
  ];

  it("pops only the head so later prompts survive", () => {
    const next = popWatchModified(queue, "w-1");
    expect(next).toEqual([{ watchId: "w-2", name: "b.txt" }]);
  });

  it("refuses a stale decision whose watchId is not the head", () => {
    // 慢上传的过期回调指向 w-2，队头却是 w-1：队列原样保留。
    expect(popWatchModified(queue, "w-2")).toBeNull();
    expect(popWatchModified([], "w-1")).toBeNull();
  });
});
