/**
 * Input-timeout verdict helper (issue #302).
 *
 * A terminal input send timing out does not always mean the transport died.
 * When terminal output frames are still arriving, the SSH channel is
 * demonstrably alive and the timeout only reflects request-path congestion
 * (e.g. the burst right after a large output flood). Reporting that as a
 * transport outage escalates a transient stall into the full reconnect
 * ladder; the caller can instead just reset the input queue.
 */

export const INPUT_TIMEOUT_FRESH_OUTPUT_GRACE_MS = 2_000;

/** True when the input timeout should be treated as congestion, not death:
 * terminal output arrived within the grace window ending at `now`. */
export function inputTimeoutIndicatesStall(lastTerminalDataAt: number, now: number, graceMs = INPUT_TIMEOUT_FRESH_OUTPUT_GRACE_MS): boolean {
  return now - lastTerminalDataAt < graceMs;
}
