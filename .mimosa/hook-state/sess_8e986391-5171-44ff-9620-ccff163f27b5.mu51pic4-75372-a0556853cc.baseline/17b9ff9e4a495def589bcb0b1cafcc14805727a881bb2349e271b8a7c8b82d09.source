// Aggregate progress for multi-item SFTP batch operations (multi-delete,
// multi-archive). The per-item remote calls stay sequential in App.vue; this
// module owns the pure bookkeeping so the panel can render one aggregated
// progress bar instead of N silent steps.

export interface BatchProgressState {
  total: number;
  /** Items that finished successfully. */
  done: number;
  /** Items that failed (the batch aborts on the first failure). */
  failed: number;
  /** Name of the item currently being processed (trailing label). */
  current: string;
}

export function createBatchProgress(total: number): BatchProgressState {
  const normalized = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : 0;
  return { total: normalized, done: 0, failed: 0, current: "" };
}

/**
 * 0-100 percentage across all items: succeeded + failed both count as
 * processed, so a failed batch still shows how far it got.
 */
export function batchProgressPercent(state: BatchProgressState): number {
  const processed = state.done + state.failed;
  if (state.total <= 0) return 0;
  return Math.round((Math.min(processed, state.total) / state.total) * 100);
}

/** Returns a new state with one item marked done/failed; pure. */
export function advanceBatchProgress(state: BatchProgressState, update: { name?: string; ok: boolean }): BatchProgressState {
  return {
    total: state.total,
    done: state.done + (update.ok ? 1 : 0),
    failed: state.failed + (update.ok ? 0 : 1),
    current: String(update.name || "").trim(),
  };
}
