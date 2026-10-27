//! 并发多流预读窗口（自适应传输引擎二期，issue #237）。
//!
//! 一期（ST9）的下载预取是深度 1 的单步预读：返回第 N 块时后台预读第 N+1
//! 块，命中省一个整 RTT，但在高带宽低延迟链路（内网 GB 级单大文件）上仍然
//! 单流串行——吞吐被「单请求带宽 × 在途 1」界死。二期把预取槽推广为有界
//! **并发预读窗口**：`download_chunk` 供给第 N 块后，后台并行发起
//! depth-1 路（默认 depth=4，硬上限 4）未来分块的远端读，SFTP 协议层天然
//! 支持单通道多请求交错（RFC draft-ietf-secsh-filexfer 的 request id 多路
//! 复用），稳态在途读 ≈ depth-1 路，吞吐随流数扩展。
//!
//! 职责边界（与 [`crate::transfer_schedule`] 同向）：本模块只做**纯逻辑**——
//! 深度决策与窗口簿记（命中/在途/地板淘汰/降级），不做任何 I/O；远端读、
//! 句柄池、错误降级挂接在 `ssh.rs` 的 `download_chunk` 车道里。
//!
//! 协议与语义红线：
//! - stdio 协议形状零变化——前端仍按既有 `sftp/download/next` 顺序逐块驱动，
//!   分块供给顺序、二进制帧（offset+chunk）、进度/取消/断点续传语义全部不变；
//!   并发只发生在 sidecar 内部的「预读未到来分块」上，本地落盘仍按供给顺序
//!   追加拼装。
//! - 窗口命中按 (offset, len) 精确匹配，offset 不一致（续传跳片/重试）自动
//!   作废；任一并发读失败即整窗降级单流（`degraded`），错误本身不打断任务，
//!   由既有同步读车道按原语义浮出。

/// 窗口深度硬上限（并发读流数 ≤ 4：内网实测 2-4 路即接近跑满单通道，
/// 更深只堆内存与服务端并发压力）。
pub const MAX_STREAMS: usize = 4;
/// 多流生效的文件体积阈值缺省（MiB）：小文件单步预取已够，窗口白付句柄。
pub const DEFAULT_THRESHOLD_MIB: u64 = 256;
/// 阈值可配上限（MiB），与 `transfer_compress_threshold_mib` 同向。
pub const THRESHOLD_MIB_MAX: u64 = 65536;

/// 深度决策输入（全部可测事实，不臆测网络参数）。
#[derive(Clone, Copy, Debug)]
pub struct DepthInput {
    /// 远端文件体积（字节）。
    pub size: u64,
    /// 生效阈值（MiB；0 = 多流关闭，一律单步预取）。
    pub threshold_mib: u64,
    /// 下载限速是否生效：限速节奏由 Throttle 配速，并发预读会打乱配速
    /// （与一期预取同一规则），一律降为单步预取。
    pub throttle_enabled: bool,
    /// 老旧服务器兼容模式（M14-B）：不做流水线并发，降为单步预取。
    pub compat_mode: bool,
    /// 车道是否适配：仅普通单文件高层车道（非树/压缩/lzpack/sudo、非
    /// latin-1 裸包转义名）为 true；不适配车道一律降为单步预取。
    pub eligible: bool,
}

/// 深度决策：返回预读窗口深度。1 = 维持一期单步预取（多流关闭）；
/// 2..=[`MAX_STREAMS`] = 并发窗口（含供给块在内最多 depth 路在途读）。
pub fn window_depth(input: DepthInput) -> usize {
    if !input.eligible || input.throttle_enabled || input.compat_mode || input.threshold_mib == 0 {
        return 1;
    }
    let threshold_bytes = input.threshold_mib.saturating_mul(1024 * 1024);
    if input.size < threshold_bytes {
        return 1;
    }
    MAX_STREAMS
}

/// 有界并发预读窗口簿记。键为分块 offset；值为已就绪的窗口分块。
///
/// 不变量：
/// - `floor` 是已供给到的下一 offset（单调不减）；低于地板的窗口块/在途
///   请求一律淘汰（供给推进、重复读兜底到达后不会积压陈块）。
/// - 命中按 (offset, len) 精确匹配——末块短读、续传跳片天然失配作废。
/// - `degraded` 置位后不再规划新的并发读（`plan` 返回空），已就绪块仍可
///   命中；任务剩余生命周期单流，错误由同步车道按原语义浮出。
#[derive(Debug)]
pub struct ReadaheadWindow {
    depth: usize,
    floor: u64,
    chunks: std::collections::HashMap<u64, Vec<u8>>,
    in_flight: std::collections::HashSet<u64>,
    degraded: bool,
}

impl ReadaheadWindow {
    pub fn new(depth: usize) -> Self {
        Self {
            depth: depth.max(1),
            floor: 0,
            chunks: std::collections::HashMap::new(),
            in_flight: std::collections::HashSet::new(),
            degraded: false,
        }
    }

    #[cfg(test)]
    pub fn is_degraded(&self) -> bool {
        self.degraded
    }

    #[cfg(test)]
    pub fn buffered(&self) -> usize {
        self.chunks.len()
    }

    #[cfg(test)]
    pub fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    /// 取出命中块（offset 与长度都精确一致才命中；末块短读天然匹配）。
    pub fn take(&mut self, offset: u64, len: usize) -> Option<Vec<u8>> {
        if self.chunks.get(&offset)?.len() == len {
            self.chunks.remove(&offset)
        } else {
            None
        }
    }

    /// 供给推进后的回填规划：以 `next_offset` 为地板淘汰陈块，然后在
    /// `[next_offset, next_offset + depth × chunk_size)` 的窗口目标里挑出
    /// 未就绪且不在途的 offset（末块按 `size` 截短），置为在途并返回。
    /// 降级后返回空（不再发起并发读）。
    pub fn plan(&mut self, next_offset: u64, size: u64, chunk_size: u64) -> Vec<(u64, usize)> {
        self.floor = next_offset;
        self.chunks.retain(|offset, _| *offset >= self.floor);
        self.in_flight.retain(|offset| *offset >= self.floor);
        if self.degraded || self.depth < 2 || chunk_size == 0 {
            return Vec::new();
        }
        let mut plan = Vec::new();
        for index in 0..self.depth as u64 {
            let offset = next_offset.saturating_add(index.saturating_mul(chunk_size));
            if offset >= size {
                break;
            }
            if self.chunks.contains_key(&offset) || self.in_flight.contains(&offset) {
                continue;
            }
            let len = size.saturating_sub(offset).min(chunk_size) as usize;
            self.in_flight.insert(offset);
            plan.push((offset, len));
        }
        plan
    }

    /// 并发读成功入窗。低于地板（同步兜底已先行供给）或重复到达的块丢弃，
    /// 防陈块积压。
    pub fn complete(&mut self, offset: u64, data: Vec<u8>) {
        self.in_flight.remove(&offset);
        if offset < self.floor {
            return;
        }
        self.chunks.insert(offset, data);
    }

    /// 并发读失败：请求出窗并整窗降级单流。返回 true 表示这是本任务第一次
    /// 降级（调用方据此打一次日志）。
    pub fn fail(&mut self, offset: u64) -> bool {
        self.in_flight.remove(&offset);
        if self.degraded {
            return false;
        }
        self.degraded = true;
        true
    }

    /// 全窗作废（offset 失配等异常路径）：清就绪块与在途标记，降级状态
    /// 保留（降级是本任务生命周期事实，不因作废重置）。
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.in_flight.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK: u64 = 256 * 1024;
    const MIB: u64 = 1024 * 1024;

    fn input(size: u64) -> DepthInput {
        DepthInput {
            size,
            threshold_mib: DEFAULT_THRESHOLD_MIB,
            throttle_enabled: false,
            compat_mode: false,
            eligible: true,
        }
    }

    #[test]
    fn depth_gate_respects_threshold_boundary() {
        // 恰在阈值上启用、差一字节关闭。
        assert_eq!(window_depth(input(256 * MIB)), MAX_STREAMS);
        assert_eq!(window_depth(input(256 * MIB - 1)), 1);
        assert_eq!(window_depth(input(3 * 1024 * MIB + 123)), MAX_STREAMS);
    }

    #[test]
    fn depth_gate_flags_force_single_prefetch() {
        let size = 4 * 1024 * MIB;
        assert_eq!(
            window_depth(DepthInput {
                eligible: false,
                ..input(size)
            }),
            1
        );
        assert_eq!(
            window_depth(DepthInput {
                throttle_enabled: true,
                ..input(size)
            }),
            1
        );
        assert_eq!(
            window_depth(DepthInput {
                compat_mode: true,
                ..input(size)
            }),
            1
        );
        // 阈值 0 = 多流显式关闭。
        assert_eq!(
            window_depth(DepthInput {
                threshold_mib: 0,
                ..input(size)
            }),
            1
        );
    }

    #[test]
    fn depth_gate_never_exceeds_hard_cap() {
        // 硬上限 4：超配阈值/超大体积也封顶。
        assert!(window_depth(input(u64::MAX)) <= MAX_STREAMS);
        assert_eq!(window_depth(input(u64::MAX)), MAX_STREAMS);
    }

    #[test]
    fn plans_full_window_and_clips_at_eof() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        // 4 块体积：plan 供给起点 0 → 目标 0..4 全量 4 块（含供给块自身）。
        let size = 4 * CHUNK;
        let plan = window.plan(0, size, CHUNK);
        assert_eq!(
            plan,
            vec![
                (0, CHUNK as usize),
                (CHUNK, CHUNK as usize),
                (2 * CHUNK, CHUNK as usize),
                (3 * CHUNK, CHUNK as usize)
            ]
        );
        assert_eq!(window.in_flight_count(), 4);

        // 恰好 3.5 块：末块截短，且窗口目标越界截断。
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 3 * CHUNK + CHUNK / 2;
        let plan = window.plan(0, size, CHUNK);
        assert_eq!(plan.len(), 4);
        assert_eq!(plan[3], (3 * CHUNK, CHUNK as usize / 2));
    }

    #[test]
    fn plan_skips_buffered_and_in_flight_and_slides_floor() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 8 * CHUNK;
        let first = window.plan(0, size, CHUNK);
        assert_eq!(first.len(), 4);
        // 块 0 已就绪（模拟并发读完成）：推进到块 1 后 plan 只补窗口尾部。
        window.complete(0, vec![0_u8; CHUNK as usize]);
        let second = window.plan(CHUNK, size, CHUNK);
        // 窗口目标 [CHUNK, CHUNK+4×CHUNK)：块 1..3 仍在途，只补块 4。
        assert_eq!(second, vec![(4 * CHUNK, CHUNK as usize)]);
        // 块 0 已低于地板被淘汰。
        assert_eq!(window.buffered(), 0);
        assert_eq!(window.in_flight_count(), 4);
    }

    #[test]
    fn take_requires_exact_offset_and_length() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 2 * CHUNK + 100;
        assert!(window.plan(0, size, CHUNK).len() == 3);
        window.complete(0, vec![0_u8; CHUNK as usize]);
        window.complete(2 * CHUNK, vec![0_u8; 100]);
        // 长度不一致（把末块当整块要）不命中，不误发短块。
        assert!(window.take(2 * CHUNK, CHUNK as usize).is_none());
        assert!(window.take(2 * CHUNK, 100).is_some());
        assert!(window.take(0, CHUNK as usize).is_some());
        assert!(window.take(0, CHUNK as usize).is_none());
    }

    #[test]
    fn complete_below_floor_is_discarded() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 8 * CHUNK;
        let plan = window.plan(0, size, CHUNK);
        assert!(plan.contains(&(0, CHUNK as usize)));
        // 窗口未命中，同步车道先行供给并推进地板，随后并发读迟到。
        window.plan(CHUNK, size, CHUNK);
        window.complete(0, vec![0_u8; CHUNK as usize]);
        assert_eq!(window.buffered(), 0);
    }

    #[test]
    fn fail_degrades_once_and_stops_planning() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 8 * CHUNK;
        assert!(window.plan(0, size, CHUNK).len() == 4);
        assert!(window.fail(CHUNK), "first failure should report degrade");
        assert!(window.is_degraded());
        assert!(!window.fail(2 * CHUNK), "repeat failure is silent");
        assert_eq!(
            window.in_flight_count(),
            2,
            "both failed offsets left the window"
        );
        // 降级后不再规划新并发读；plan 的地板推进照常淘汰陈块（chunk 0
        // 已越过供给点，清出窗口），地板之上的就绪块仍可命中。
        assert!(window.plan(CHUNK, size, CHUNK).is_empty());
        assert!(
            window.take(0, CHUNK as usize).is_none(),
            "below-floor chunk is purged"
        );
        window.complete(2 * CHUNK, vec![0_u8; CHUNK as usize]);
        assert!(window.take(2 * CHUNK, CHUNK as usize).is_some());
    }

    #[test]
    fn clear_drops_buffer_and_in_flight_but_keeps_degrade() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 8 * CHUNK;
        window.plan(0, size, CHUNK);
        window.complete(0, vec![0_u8; CHUNK as usize]);
        window.fail(CHUNK);
        window.clear();
        assert_eq!(window.buffered(), 0);
        assert_eq!(window.in_flight_count(), 0);
        assert!(window.is_degraded(), "degrade survives clear");
        assert!(window.plan(0, size, CHUNK).is_empty());
    }

    #[test]
    fn plan_beyond_eof_is_empty_and_zero_chunk_is_safe() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        assert!(window.plan(0, 0, CHUNK).is_empty());
        assert!(window.plan(usize::MAX as u64, u64::MAX, CHUNK).is_empty());
        // chunk_size 0 防御：不推进也不死循环。
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        assert!(window.plan(0, 8 * CHUNK, 0).is_empty());
    }

    #[test]
    fn plan_at_last_chunk_only_short_tail() {
        let mut window = ReadaheadWindow::new(MAX_STREAMS);
        let size = 4 * CHUNK + 1;
        // 供给已到末块起点：窗口只剩 1 字节短尾。
        let plan = window.plan(4 * CHUNK, size, CHUNK);
        assert_eq!(plan, vec![(4 * CHUNK, 1)]);
    }
}
