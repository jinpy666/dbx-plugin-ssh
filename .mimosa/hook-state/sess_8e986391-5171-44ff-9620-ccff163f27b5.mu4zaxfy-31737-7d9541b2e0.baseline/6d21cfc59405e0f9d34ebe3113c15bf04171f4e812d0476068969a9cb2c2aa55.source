import { describe, expect, it, vi } from "vitest";
import { createTerminalInputQueue } from "./terminalInputQueue";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function frame(sequence: number, text: string) {
  const payload = new Uint8Array(8 + text.length);
  new DataView(payload.buffer).setBigUint64(0, BigInt(sequence), false);
  payload.set(new TextEncoder().encode(text), 8);
  return payload;
}

describe("terminal input queue", () => {
  it("does not gate rapid keystrokes on the broadcast ACK", async () => {
    const sent: Array<{ sessionId: string; payload: Uint8Array }> = [];
    const queue = createTerminalInputQueue({
      send: (sessionId, payload) => {
        sent.push({ sessionId, payload });
      },
    });

    queue.enqueue("session-1", new TextEncoder().encode("c"));
    queue.enqueue("session-1", new TextEncoder().encode("d"));
    await settle();

    expect(sent.map((item) => item.sessionId)).toEqual(["session-1", "session-1"]);
    expect(sent.map((item) => item.payload)).toEqual([frame(1, "c"), frame(2, "d")]);
  });

  it("keeps the queue usable after a bridge send failure", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const send = vi
      .fn<(sessionId: string, payload: Uint8Array) => void>()
      .mockImplementationOnce(() => {
        throw new Error("bridge unavailable");
      })
      .mockImplementation((_sessionId, payload) => {
        sent.push(new TextDecoder().decode(payload.slice(8)));
      });
    const queue = createTerminalInputQueue({ send, onError: (cause) => errors.push(cause) });

    queue.enqueue("session-1", new TextEncoder().encode("c"));
    queue.enqueue("session-1", new TextEncoder().encode("d"));
    await settle();

    expect(errors).toHaveLength(1);
    expect(sent).toEqual(["d"]);
  });

  it("drops queued frames from a session that was reset", async () => {
    const sent: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = createTerminalInputQueue({
      send: async (_sessionId, payload) => {
        sent.push(new TextDecoder().decode(payload.slice(8)));
        if (sent.length === 1) await first;
      },
    });

    queue.enqueue("old-session", new TextEncoder().encode("a"));
    queue.enqueue("old-session", new TextEncoder().encode("b"));
    await settle();
    queue.reset();
    queue.enqueue("new-session", new TextEncoder().encode("c"));
    releaseFirst();
    await settle();

    expect(sent).toEqual(["a", "c"]);
  });
});
