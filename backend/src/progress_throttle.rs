//! 传输进度事件时间窗节流。
//!
//! 传输热路径每 256KiB（TRANSFER_CHUNK_SIZE）发一条 `sftp/transfer/progress`
//! IPC 事件：1GB @ 50MB/s ≈ 200 条/秒，每条都跨桥序列化并直驱前端全量重渲
//! 染。时间窗内的中间事件直接丢弃；首帧、窗口边界与终帧必发，进度条终值
//! 不受影响。终态事件（queued/completed/error）不经本节流，由调用方照常
//! 无条件发射。

use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ProgressThrottle {
    interval: Duration,
    last_emit: Option<Instant>,
}

impl ProgressThrottle {
    pub const DEFAULT_INTERVAL: Duration = Duration::from_millis(100);

    pub fn new() -> Self {
        Self {
            interval: Self::DEFAULT_INTERVAL,
            last_emit: None,
        }
    }

    /// 决定本次进度是否发射。`final_frame`（当前块到达声明总量或 eof）必发
    /// 并把窗口推进到 `now`，保证最后一个数据块的进度可见。
    pub fn should_emit_at(&mut self, now: Instant, final_frame: bool) -> bool {
        if final_frame {
            self.last_emit = Some(now);
            return true;
        }
        match self.last_emit {
            None => {
                self.last_emit = Some(now);
                true
            }
            Some(last) if now.duration_since(last) >= self.interval => {
                self.last_emit = Some(now);
                true
            }
            Some(_) => false,
        }
    }

    pub fn should_emit(&mut self, final_frame: bool) -> bool {
        self.should_emit_at(Instant::now(), final_frame)
    }
}

impl Default for ProgressThrottle {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_frame_always_emits() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_emit_at(Instant::now(), false));
    }

    #[test]
    fn frames_within_window_are_dropped() {
        let mut throttle = ProgressThrottle::new();
        let t0 = Instant::now();
        assert!(throttle.should_emit_at(t0, false));
        assert!(!throttle.should_emit_at(t0 + Duration::from_millis(50), false));
        assert!(!throttle.should_emit_at(t0 + Duration::from_millis(99), false));
    }

    #[test]
    fn window_boundary_emits_again() {
        let mut throttle = ProgressThrottle::new();
        let t0 = Instant::now();
        assert!(throttle.should_emit_at(t0, false));
        assert!(throttle.should_emit_at(t0 + Duration::from_millis(100), false));
    }

    #[test]
    fn final_frame_always_emits_even_inside_window() {
        let mut throttle = ProgressThrottle::new();
        let t0 = Instant::now();
        assert!(throttle.should_emit_at(t0, false));
        assert!(throttle.should_emit_at(t0 + Duration::from_millis(1), true));
    }

    #[test]
    fn final_frame_advances_the_window() {
        let mut throttle = ProgressThrottle::new();
        let t0 = Instant::now();
        assert!(throttle.should_emit_at(t0, false));
        // 终帧把 last_emit 推进到 t0+1ms：窗口从此从终帧起算。
        assert!(throttle.should_emit_at(t0 + Duration::from_millis(1), true));
        assert!(!throttle.should_emit_at(t0 + Duration::from_millis(50), false));
        assert!(throttle.should_emit_at(t0 + Duration::from_millis(101), false));
    }

    #[test]
    fn per_task_throttles_are_independent() {
        let mut a = ProgressThrottle::new();
        let mut b = ProgressThrottle::new();
        let t0 = Instant::now();
        assert!(a.should_emit_at(t0, false));
        // 同一时刻另一个任务的首次进度照发，互不饿死。
        assert!(b.should_emit_at(t0, false));
        assert!(!a.should_emit_at(t0 + Duration::from_millis(10), false));
    }
}
