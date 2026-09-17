/**
 * Ordered, lossless transport for PTY input.
 *
 * The host's binary send promise only confirms that the frame was accepted by
 * the bridge. The sidecar also emits an inputAck event for observability, but
 * that event is deliberately not part of the keyboard path: waiting for it
 * makes a delayed event stall every later keystroke behind one character.
 */

export interface TerminalInputQueueOptions {
  send(sessionId: string, payload: Uint8Array): Promise<void> | void;
  onError?(cause: unknown): void;
}

export interface TerminalInputQueue {
  enqueue(sessionId: string, data: Uint8Array): number;
  reset(): void;
}

function writeU64(target: Uint8Array, offset: number, value: number) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setBigUint64(offset, BigInt(value), false);
}

export function createTerminalInputQueue(options: TerminalInputQueueOptions): TerminalInputQueue {
  let nextSequence = 0;
  let generation = 0;
  let tail = Promise.resolve();

  function enqueue(sessionId: string, data: Uint8Array) {
    const sequence = ++nextSequence;
    const itemGeneration = generation;
    const payload = new Uint8Array(8 + data.byteLength);
    writeU64(payload, 0, sequence);
    payload.set(data, 8);

    // Keep the transport ordered because the sidecar worker pool may process
    // concurrent binary frames on different workers. Do not wait for the
    // broadcast inputAck; sendBinary's completion is the bridge acceptance
    // boundary and the backend applies its own bounded backpressure.
    tail = tail
      .then(async () => {
        // Input queued before a session reset must not leak into the next
        // session. An already-running send cannot be cancelled, so new input
        // remains behind it and is sent only after the old frame settles.
        if (itemGeneration !== generation) return;
        await options.send(sessionId, payload);
      })
      .catch((cause) => {
        try {
          options.onError?.(cause);
        } catch {
          // An error banner must not poison the queue for later keystrokes.
        }
      });
    return sequence;
  }

  return {
    enqueue,
    reset() {
      generation += 1;
      nextSequence = 0;
    },
  };
}
