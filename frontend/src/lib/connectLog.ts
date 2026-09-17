/**
 * Bounded connect-attempt log backing the connecting card's "Show logs" panel.
 *
 * The backend exposes no connection stages, so the card narrates the client-side
 * lifecycle instead (attempt start / scheduled retry / success / failure /
 * user cancel / host-key prompts / post-cancel orphan cleanup). Callers push
 * final localized strings (formatted via t()); this store only owns ordering
 * and the ring-buffer cap. Entries are newest-first so the panel renders the
 * store in order without reversing.
 */

import { shallowRef, type Ref } from "vue";

export type ConnectLogLevel = "info" | "warn" | "error";

export interface ConnectLogEntry {
  ts: number;
  level: ConnectLogLevel;
  message: string;
}

/** Ring-buffer cap: oldest entries drop off past this many rows. */
export const CONNECT_LOG_LIMIT = 200;

export interface ConnectLog {
  /** Newest-first entry list (reactive). */
  entries: Readonly<Ref<ConnectLogEntry[]>>;
  push(level: ConnectLogLevel, message: string): void;
  clear(): void;
}

export function createConnectLog(): ConnectLog {
  const entries = shallowRef<ConnectLogEntry[]>([]);
  return {
    entries,
    push(level, message) {
      entries.value = [{ ts: Date.now(), level, message }, ...entries.value].slice(0, CONNECT_LOG_LIMIT);
    },
    clear() {
      entries.value = [];
    },
  };
}
