// @vitest-environment happy-dom
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { createConnectLog } from "../lib/connectLog";
import { useConnectCard } from "./useConnectCard";

describe("useConnectCard reconnect entry points", () => {
  it.each(["reconnect", "startConnect", "reconnectNow"] as const)("reopens the host before %s opens a new SSH session", async (entry) => {
    const calls: string[] = [];
    const reconnectPending = ref(true);
    const reconnectAttempt = ref(2);
    const openSession = vi.fn(async (..._args: unknown[]) => { calls.push("open"); });
    const card = useConnectCard({
      t: (key) => key,
      connectLog: createConnectLog(),
      terminalState: ref("disconnected"),
      connectCancelled: ref(false),
      connectSucceeded: ref(false),
      reconnectPending,
      reconnectAttempt,
      reconnectTimer: ref(0),
      getTerminal: () => undefined,
      resetGutterTimestamps: vi.fn(),
      closeSession: vi.fn().mockResolvedValue(undefined),
      openSession,
      requestHostReopenConnection: async () => { calls.push("reopen"); return true; },
    });

    if (entry === "reconnectNow") await card.reconnectNow();
    else await card[entry]();

    expect(calls).toEqual(["reopen", "open"]);
    expect(openSession).toHaveBeenCalledWith(false, false, false, true);
    if (entry === "reconnectNow") {
      expect(reconnectPending.value).toBe(false);
      expect(reconnectAttempt.value).toBe(0);
    }
  });
});
