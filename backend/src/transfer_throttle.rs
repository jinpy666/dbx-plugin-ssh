//! Download speed throttling (issue #66): paces the SFTP download chunk
//! loops so a transfer never exceeds the user-configured KiB/s cap. Pure
//! pacing math lives here; `ssh.rs` only snapshots the preference at task
//! start and calls [`Throttle::pace`] after each chunk. Zero-limit (the
//! default) keeps the hot path allocation-free and sleep-free.
//!
//! Pacing model: for a chunk of `bytes` at `limit_kib` KiB/s the ideal
//! transfer duration is `bytes / (limit * 1024)` seconds. We measure the
//! actual elapsed time of the chunk (network + disk) and sleep only the
//! shortfall, so a fast local link is slowed to the cap while an already
//! slow remote never gets extra delay. Drift across chunks is corrected
//! by the instantaneous (not cumulative) comparison: each chunk is judged
//! on its own elapsed time, so a slow chunk is not "repaid" by an extra
//! wait on the next one.

use std::time::Duration;

/// A configured limiter. `limit_kib == 0` means unlimited; constructing
/// via [`Throttle::new`] is the only entry point so callers cannot forget
/// the zero check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Throttle {
    limit_kib: u64,
}

impl Throttle {
    /// Builds the limiter for one download task; `0` disables pacing and
    /// the returned throttle's [`Self::pace`] becomes a no-op.
    pub fn new(limit_kib: u64) -> Self {
        Self { limit_kib }
    }

    /// True when pacing is active (a positive limit was configured).
    pub fn enabled(&self) -> bool {
        self.limit_kib > 0
    }

    /// Bytes per second implied by the configured KiB/s limit.
    fn bytes_per_second(&self) -> u64 {
        self.limit_kib.saturating_mul(1024)
    }

    /// How long a chunk of `bytes` should take at the configured rate.
    /// Exposed for tests; `pace` compares real elapsed time against it.
    fn ideal_duration(&self, bytes: usize) -> Duration {
        let bps = self.bytes_per_second();
        if bps == 0 {
            return Duration::ZERO;
        }
        // u128 intermediate: a 256 KiB chunk at 1 KiB/s is 256 s, well
        // within range, and overflow-free even for u64::MAX limits.
        let micros = (bytes as u128 * 1_000_000) / bps as u128;
        Duration::from_micros(u64::try_from(micros).unwrap_or(u64::MAX))
    }

    /// Sleeps the shortfall between the ideal duration of `bytes` at the
    /// configured rate and the time the chunk actually took (`elapsed`).
    /// Unlimited throttles and fully-spent budgets return instantly.
    pub async fn pace(&self, bytes: usize, elapsed: Duration) {
        let wait = self.shortfall(bytes, elapsed);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    /// Pure shortfall computation (unit-tested without an async runtime):
    /// the positive part of `ideal - elapsed`.
    fn shortfall(&self, bytes: usize, elapsed: Duration) -> Duration {
        if !self.enabled() {
            return Duration::ZERO;
        }
        self.ideal_duration(bytes)
            .checked_sub(elapsed)
            .unwrap_or(Duration::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_limit_disables_pacing_entirely() {
        let throttle = Throttle::new(0);
        assert!(!throttle.enabled());
        // No wait even for large chunks and no elapsed time at all.
        assert_eq!(
            throttle.shortfall(TRANSFER_1MIB, Duration::ZERO),
            Duration::ZERO
        );
    }

    #[test]
    fn shortfall_is_positive_part_of_ideal_minus_elapsed() {
        let throttle = Throttle::new(1); // 1024 B/s
        assert_eq!(throttle.bytes_per_second(), 1024);
        // A 1024-byte chunk at 1 KiB/s should take exactly one second.
        assert_eq!(throttle.ideal_duration(1024), Duration::from_secs(1),);
        // Fast chunk: the full ideal duration is the shortfall.
        assert_eq!(
            throttle.shortfall(1024, Duration::from_millis(100)),
            Duration::from_millis(900)
        );
        // Slow chunk (already over the cap): no extra wait, no panic.
        assert_eq!(
            throttle.shortfall(1024, Duration::from_millis(1500)),
            Duration::ZERO
        );
        // Exactly on the cap: no wait.
        assert_eq!(
            throttle.shortfall(1024, Duration::from_secs(1)),
            Duration::ZERO
        );
    }

    #[test]
    fn shortfall_scales_with_rate_and_chunk() {
        // 64 KiB/s: a 256 KiB chunk should take 4 s.
        let throttle = Throttle::new(64);
        assert_eq!(throttle.ideal_duration(256 * 1024), Duration::from_secs(4));
        // Fractional-second targets survive as microseconds.
        assert_eq!(
            throttle.ideal_duration(96 * 1024), // 1.5 s at 64 KiB/s
            Duration::from_millis(1500)
        );
        // Empty chunk never waits.
        assert_eq!(throttle.shortfall(0, Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn huge_limit_and_huge_bytes_stay_overflow_free() {
        let throttle = Throttle::new(1_048_576); // 1 GiB/s preference cap
                                                 // 256 KiB at 1 GiB/s = 262144 / 1073741824 s ≈ 244.14 µs.
        assert_eq!(
            throttle.ideal_duration(256 * 1024),
            Duration::from_micros(244)
        );
        // Saturation path: absurdly large byte counts still produce a
        // finite duration instead of wrapping.
        let slow = Throttle::new(1);
        assert!(slow.ideal_duration(usize::MAX) > Duration::from_secs(3600));
    }

    const TRANSFER_1MIB: usize = 1024 * 1024;

    #[tokio::test]
    async fn pace_sleeps_only_the_shortfall() {
        let throttle = Throttle::new(1024); // 1 MiB/s
                                            // A 128 KiB chunk should take 125 ms; simulate 25 ms elapsed.
        let started = std::time::Instant::now();
        throttle.pace(128 * 1024, Duration::from_millis(25)).await;
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(100) && waited < Duration::from_millis(400),
            "expected ~100 ms shortfall sleep, got {waited:?}"
        );
        // Disabled: returns immediately even with zero elapsed time.
        let started = std::time::Instant::now();
        Throttle::new(0).pace(128 * 1024, Duration::ZERO).await;
        assert!(started.elapsed() < Duration::from_millis(50));
    }
}
