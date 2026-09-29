//! SFTP 压缩传输（gzip 混合方案）：决策、扩展名黑名单、比率守卫、gzip
//! 流式编解码与远端命令构造。
//!
//! 分工：压缩端用程序内置 flate2（纯 Rust），对端必须落回原样文件——解压/
//! 压缩动作由远端 `gzip`/`gunzip`/`tar` 工具承担（任务开始时 `command -v`
//! 探测）。任何一环不满足（偏好关闭、低于阈值、不可压缩类型、远端缺工具、
//! 只读连接、latin-1 裸包车道、压缩率不划算、弱 CPU）都静默回退普通传输
//! ——功能可降但不可死。latin-1 车道整条不参与：用户路径进 shell 有编码雷
//! 区。CPU 综合判断（M33 补充）：auto 策略下本机并行度 ≤2 直接跳过（决策
//! 层），上传压缩预压另有运行时吞吐守卫（实测压缩速率过低即中止回退，比
//! 核数更真实，对所有策略生效）。

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 压缩传输生效的模式。序列化进 RPC 响应（`compression` 字段）与进度事件。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CompressionMode {
    /// 普通传输（现状管线，协议零变化）。
    None,
    /// gzip 压缩通道：本地 flate2 + 远端 gzip/gunzip（树为 tar.gz）。
    Gzip,
}

impl CompressionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CompressionMode::None => "none",
            CompressionMode::Gzip => "gzip",
        }
    }
}

/// 压缩策略（偏好 `transfer_compress_mode`，设置→传输）：auto=智能综合
/// 判断（默认，含弱 CPU 门槛）；on=始终尝试（跳过 CPU 门槛，其余回退条件
/// 与运行时吞吐守卫仍然生效）；off=关闭。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CompressPolicy {
    Auto,
    On,
    Off,
}

impl CompressPolicy {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(CompressPolicy::Auto),
            "on" => Some(CompressPolicy::On),
            "off" => Some(CompressPolicy::Off),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CompressPolicy::Auto => "auto",
            CompressPolicy::On => "on",
            CompressPolicy::Off => "off",
        }
    }
}

/// 默认生效阈值：64 MiB 以下不压缩（小文件压缩收益盖不住 CPU 与固定开销）。
pub const THRESHOLD_MIB_DEFAULT: u64 = 64;
/// 阈值上限（MiB）：设置面钳制，防呆不防饿。
pub const THRESHOLD_MIB_MAX: u64 = 65536;
/// 比率守卫：压缩后体积 ≥ 原始体积的 95% 即判定不划算，回退普通传输。
/// （已压缩数据偶尔缩 1-2%，网络节省盖不住两端 CPU 与额外磁盘写。）
pub const WORTHWHILE_PERCENT: u128 = 95;
/// 弱 CPU 门槛（auto 策略）：本机并行度 ≤2 核直接跳过压缩——压缩吃满单核
/// 会拖垮整机，收益在慢网低配机上是负的。`on` 策略跳过本门槛。
pub const WEAK_CPU_PARALLELISM: u64 = 2;
/// 运行时吞吐守卫（上传预压，所有策略生效）：处理满 8 MiB 且耗时满 1s 时
/// 做一次速率检查，压缩速率低于该下限（MiB/s）即中止回退普通推送——
/// 比核数更真实的「CPU 不行」信号，弱单核/被限流的容器都能兜住。
pub const RATE_GUARD_MIN_BYTES: u64 = 8 * 1024 * 1024;
pub const RATE_GUARD_MIN_ELAPSED: std::time::Duration = std::time::Duration::from_secs(1);
pub const RATE_GUARD_FLOOR_MIB_S: u64 = 20;

/// 已压缩/不可压缩类型：再压一遍几乎不缩，纯浪费两端 CPU。大小写不敏感，
/// 只看末段扩展名。
const INCOMPRESSIBLE_EXTENSIONS: &[&str] = &[
    "7z", "avi", "apk", "bz2", "deb", "dll", "dmg", "exe", "flac", "gif", "gz", "iso", "jpeg",
    "jpg", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg", "ogg", "png", "rar", "rpm",
    "svgz", "tbz", "tgz", "webm", "webp", "xz", "zip", "zst",
];

/// 压缩流的分块读写缓冲（与 TRANSFER_CHUNK_SIZE 同口径，回调节流由调用方做）。
const STREAM_BUFFER_SIZE: usize = 256 * 1024;

/// 判定一次传输是否走压缩通道。`name` 传文件末段名（树模式传 `None`，跳过
/// 扩展名黑名单——混合内容树里总有文本成员）；`local_parallelism` 传本机
/// 可用并行度（`available_parallelism`，0=未知则不启用 CPU 门槛）。所有
/// 回退条件都收敛在这里，调用方（ssh.rs）只补两件本模块不知道的事：远端
/// 工具探测与会话属性。上传方向的运行时吞吐守卫独立于本决策（compress_
/// file_to 内，所有策略生效）。
#[allow(clippy::too_many_arguments)]
pub fn decide(
    policy: CompressPolicy,
    size: u64,
    threshold_mib: u64,
    name: Option<&str>,
    tool_available: bool,
    read_only: bool,
    latin1: bool,
    local_parallelism: u64,
) -> CompressionMode {
    if policy == CompressPolicy::Off || !tool_available || read_only || latin1 {
        return CompressionMode::None;
    }
    // 弱 CPU 门槛（仅 auto）：核数不足不压。`on` 是用户对门槛的显式豁免
    // （慢网上快双核仍可能受益）；运行时吞吐守卫仍然兜底。
    if policy == CompressPolicy::Auto
        && local_parallelism > 0
        && local_parallelism <= WEAK_CPU_PARALLELISM
    {
        return CompressionMode::None;
    }
    // 0 = 不设下限（冒烟/显式全量场景），否则按 MiB 阈值。
    if threshold_mib > 0 && size < threshold_mib.saturating_mul(1024 * 1024) {
        return CompressionMode::None;
    }
    if let Some(name) = name {
        if !is_compressible_name(name) {
            return CompressionMode::None;
        }
    }
    CompressionMode::Gzip
}

/// 本机可用并行度（0 = 探测失败，决策按「不启用 CPU 门槛」处理）。
pub fn local_parallelism() -> u64 {
    std::thread::available_parallelism()
        .map(|value| value.get() as u64)
        .unwrap_or(0)
}

/// 运行时吞吐守卫的错误标记串：调用方据此把中止映射为「不划算回退」而非失败。
pub const RATE_GUARD_ERROR: &str = "compression-rate-guard";

pub fn is_rate_guard_error(error: &std::io::Error) -> bool {
    error.to_string().contains(RATE_GUARD_ERROR)
}

/// 扩展名黑名单判定：大小写不敏感，取最后一个 `.` 之后的段。无扩展名视为
/// 可压缩（数据库 dump、日志、裸文本是大头）。
pub fn is_compressible_name(file_name: &str) -> bool {
    let lowered = file_name.to_lowercase();
    match lowered.rsplit_once('.') {
        Some((_, extension)) => !INCOMPRESSIBLE_EXTENSIONS.contains(&extension),
        None => true,
    }
}

/// 比率守卫：`compressed * 100 < original * 95`（u128 防大文件溢出）。
/// original 为 0 视为不值得（空文件没有传输量可省）。
pub fn worthwhile(original: u64, compressed: u64) -> bool {
    if original == 0 {
        return false;
    }
    u128::from(compressed) * 100 < u128::from(original) * WORTHWHILE_PERCENT
}

/// 远端工具探测命令：退出码 0 且输出含标记串即认为可用。
pub fn probe_command(needs_tar: bool) -> String {
    let base = "command -v gzip >/dev/null 2>&1 && command -v gunzip >/dev/null 2>&1";
    if needs_tar {
        format!("{base} && command -v tar >/dev/null 2>&1 && echo DBX_COMPRESS_OK")
    } else {
        format!("{base} && echo DBX_COMPRESS_OK")
    }
}

/// 下载侧：远端把源文件压成任务临时 .gz（`-c` 写 stdout，源文件原样保留）。
pub fn remote_gzip_command(source: &str, target: &str) -> String {
    format!("gzip -c {} > {}", shell_quote(source), shell_quote(target))
}

/// 上传侧：远端把推送上来的 .gz 临时件还原成 plain 暂存件（随后走既有原子
/// 提交）。不用 `gunzip` 就地改写——保持「暂存件由本任务创建、提交走
/// rename」的既有原子语义。
pub fn remote_gunzip_command(source: &str, target: &str) -> String {
    format!(
        "gunzip -c {} > {}",
        shell_quote(source),
        shell_quote(target)
    )
}

/// 树下载侧：远端整目录打成单流 .tgz。相对打包（`-C <base_dir> .`），
/// 成员名形如 `./relative/path`——解包后与树扫描的相对路径直接对齐，
/// 不依赖 `--strip-components`（busybox tar 兼容面）。
pub fn remote_tar_command(base_dir: &str, target: &str) -> String {
    format!(
        "tar -czf {} -C {} .",
        shell_quote(target),
        shell_quote(base_dir)
    )
}

/// 与 exec.rs 同款单引号转义（本模块自带一份保持自包含；与
/// `crate::exec::shell_quote` 的一致性由测试对照锁定）。
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// spawn_blocking 用的进度回调：入参是「已处理的源/压缩流字节数」。
pub type ProgressSink = Arc<dyn Fn(u64) + Send + Sync>;

/// 上传压缩预压的运行时吞吐守卫参数（一次成型的一次性检查点）：处理满
/// `min_bytes` 且耗时满 `min_elapsed` 时测一次速率，低于 `floor_mib_s` 即
/// 以 [`RATE_GUARD_ERROR`] 中止（调用方回退普通推送）。文件小于检查点字节
/// 数时守卫自然不触发——小文件压缩的绝对开销可忽略。
#[derive(Clone, Copy, Debug)]
pub struct RateGuard {
    pub min_bytes: u64,
    pub min_elapsed: std::time::Duration,
    pub floor_mib_s: u64,
}

impl RateGuard {
    /// 冒烟/常规口径的默认守卫（8 MiB / 1s / 20 MiB/s）。
    pub fn default_floor() -> Self {
        RateGuard {
            min_bytes: RATE_GUARD_MIN_BYTES,
            min_elapsed: RATE_GUARD_MIN_ELAPSED,
            floor_mib_s: RATE_GUARD_FLOOR_MIB_S,
        }
    }
}

/// 把本地文件流式 gzip 压缩到目标路径。同步阻塞实现——调用方包在
/// `spawn_blocking` 里。`progress` 收「已消费的源字节数」；`cancelled` 置位
/// 时以 `Interrupted` 中止并删除半成品目标；`rate_guard` 命中时以
/// `Other(RATE_GUARD_ERROR)` 中止（同样清理半成品）。返回压缩后体积。
pub fn compress_file_to(
    source: &Path,
    target: &Path,
    cancelled: &AtomicBool,
    progress: &dyn Fn(u64),
    rate_guard: Option<&RateGuard>,
) -> std::io::Result<u64> {
    let started = std::time::Instant::now();
    let mut reader = std::fs::File::open(source)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let writer = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(target)?;
    let mut encoder = flate2::write::GzEncoder::new(writer, flate2::Compression::default());
    let mut buffer = vec![0_u8; STREAM_BUFFER_SIZE];
    let mut consumed = 0_u64;
    let abort_reason: Option<&'static str> = loop {
        if cancelled.load(Ordering::Acquire) {
            break Some("transfer cancelled");
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break None;
        }
        encoder
            .write_all(&buffer[..read])
            .map_err(|error| std::io::Error::other(format!("gzip compress failed: {error}")))?;
        consumed += read as u64;
        if let Some(guard) = rate_guard {
            let elapsed = started.elapsed();
            if consumed >= guard.min_bytes && elapsed >= guard.min_elapsed {
                // MiB/s（u128 防溢出）；速率不足即「CPU 不行」，一次性检查
                // 后不再重复判（后续只会更快或更慢，早停早回退）。
                let mib_s = u128::from(consumed) * 1_000_000
                    / (elapsed.as_micros().max(1) * 1_048_576).max(1);
                if mib_s < u128::from(guard.floor_mib_s) {
                    break Some(RATE_GUARD_ERROR);
                }
            }
        }
        progress(consumed);
    };
    if let Some(reason) = abort_reason {
        // finish() 会尝试把缓冲尾写完，失败无所谓——半成品整个删掉。
        let _ = encoder.finish();
        let _ = std::fs::remove_file(target);
        return Err(if reason == RATE_GUARD_ERROR {
            std::io::Error::other(RATE_GUARD_ERROR)
        } else {
            std::io::Error::new(std::io::ErrorKind::Interrupted, reason)
        });
    }
    encoder
        .finish()
        .map_err(|error| std::io::Error::other(format!("gzip finish failed: {error}")))?;
    Ok(std::fs::metadata(target)?.len())
}

/// 把 gzip 文件流式解压到目标路径（MultiGzDecoder 兼容多成员 .gz，与
/// `gzip` 命令输出兼容）。返回解压出的总字节数。
pub fn decompress_file_to(
    source: &Path,
    target: &Path,
    cancelled: &AtomicBool,
    progress: &dyn Fn(u64),
) -> std::io::Result<u64> {
    let reader = std::io::BufReader::new(std::fs::File::open(source)?);
    let mut decoder = flate2::read::MultiGzDecoder::new(reader);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut writer = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(target)?;
    let mut buffer = vec![0_u8; STREAM_BUFFER_SIZE];
    let mut written = 0_u64;
    let aborted = loop {
        if cancelled.load(Ordering::Acquire) {
            break true;
        }
        let read = decoder.read(&mut buffer)?;
        if read == 0 {
            break false;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| std::io::Error::other(format!("gunzip write failed: {error}")))?;
        written += read as u64;
        progress(written);
    };
    if aborted {
        let _ = std::fs::remove_file(target);
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "transfer cancelled",
        ));
    }
    writer.flush()?;
    Ok(written)
}

/// 把 tar.gz 归档解包到目标根目录（树下载压缩通道的本地端）。仅普通文件
/// 与目录——符号/硬链接与特殊文件跳过，与普通树管线「不跟随 symlink」的
/// 语义对齐；tar crate 的 `unpack_in` 自带路径穿越防护（`..`/绝对路径条
/// 目报错）。`progress` 收已解包的普通文件累计字节。返回累计字节。
pub fn extract_tar_gz(
    archive: &Path,
    root: &Path,
    cancelled: &AtomicBool,
    progress: &dyn Fn(u64),
) -> std::io::Result<u64> {
    std::fs::create_dir_all(root)?;
    let file = std::fs::File::open(archive)?;
    let decoder = flate2::read::MultiGzDecoder::new(std::io::BufReader::new(file));
    let mut archive = tar::Archive::new(decoder);
    let mut written = 0_u64;
    for entry in archive.entries()? {
        if cancelled.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "transfer cancelled",
            ));
        }
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        if !matches!(
            entry_type,
            tar::EntryType::Regular | tar::EntryType::Directory
        ) {
            continue;
        }
        let size = entry.header().size().unwrap_or(0);
        // unpack_in 对穿越/绝对路径条目静默跳过（Ok(false)）——只有真实
        // 落盘的条目才计入进度与字节。
        if entry.unpack_in(root)? && entry_type == tar::EntryType::Regular {
            written += size;
            progress(written);
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_progress(_: u64) {}

    #[test]
    fn decide_respects_every_fallback_condition() {
        use CompressPolicy::{Auto, Off};
        let big = 200 * 1024 * 1024;
        let cores = 8_u64; // 正常机器并行度
                           // 全绿 → 压缩。
        assert_eq!(
            decide(Auto, big, 64, Some("dump.sql"), true, false, false, cores),
            CompressionMode::Gzip
        );
        // 逐条回退：策略关 / 低于阈值 / 黑名单类型 / 远端缺工具 / 只读 / latin-1。
        assert_eq!(
            decide(Off, big, 64, Some("dump.sql"), true, false, false, cores),
            CompressionMode::None
        );
        assert_eq!(
            decide(
                Auto,
                64 * 1024 * 1024 - 1,
                64,
                Some("dump.sql"),
                true,
                false,
                false,
                cores
            ),
            CompressionMode::None
        );
        assert_eq!(
            decide(Auto, big, 64, Some("clip.mp4"), true, false, false, cores),
            CompressionMode::None
        );
        assert_eq!(
            decide(Auto, big, 64, Some("dump.sql"), false, false, false, cores),
            CompressionMode::None
        );
        assert_eq!(
            decide(Auto, big, 64, Some("dump.sql"), true, true, false, cores),
            CompressionMode::None
        );
        assert_eq!(
            decide(Auto, big, 64, Some("dump.sql"), true, false, true, cores),
            CompressionMode::None
        );
        // 阈值 0 = 不设下限；树模式 name=None 跳过黑名单。
        assert_eq!(
            decide(Auto, 1, 0, Some("a.txt"), true, false, false, cores),
            CompressionMode::Gzip
        );
        assert_eq!(
            decide(Auto, big, 64, None, true, false, false, cores),
            CompressionMode::Gzip
        );
        // 大小写不敏感的扩展名判定。
        assert_eq!(
            decide(Auto, big, 0, Some("Photo.JPG"), true, false, false, cores),
            CompressionMode::None
        );
    }

    #[test]
    fn weak_cpu_gate_applies_to_auto_only() {
        use CompressPolicy::{Auto, On};
        let big = 200 * 1024 * 1024;
        // auto + ≤2 核：跳过压缩（弱 CPU 综合判断）。
        assert_eq!(
            decide(Auto, big, 0, Some("dump.sql"), true, false, false, 2),
            CompressionMode::None
        );
        assert_eq!(
            decide(Auto, big, 0, Some("dump.sql"), true, false, false, 1),
            CompressionMode::None
        );
        // 3 核放行；并行度未知（0）不启用门槛。
        assert_eq!(
            decide(Auto, big, 0, Some("dump.sql"), true, false, false, 3),
            CompressionMode::Gzip
        );
        assert_eq!(
            decide(Auto, big, 0, Some("dump.sql"), true, false, false, 0),
            CompressionMode::Gzip
        );
        // on 策略显式豁免 CPU 门槛（慢网快双核场景）。
        assert_eq!(
            decide(On, big, 0, Some("dump.sql"), true, false, false, 1),
            CompressionMode::Gzip
        );
    }

    #[test]
    fn compress_policy_parses_wire_strings() {
        assert_eq!(CompressPolicy::parse("auto"), Some(CompressPolicy::Auto));
        assert_eq!(CompressPolicy::parse("on"), Some(CompressPolicy::On));
        assert_eq!(CompressPolicy::parse("off"), Some(CompressPolicy::Off));
        assert_eq!(CompressPolicy::parse("yes"), None);
        assert_eq!(CompressPolicy::Auto.as_str(), "auto");
        assert_eq!(CompressPolicy::On.as_str(), "on");
        assert_eq!(CompressPolicy::Off.as_str(), "off");
    }

    #[test]
    fn rate_guard_error_is_recognizable() {
        let error = std::io::Error::other(RATE_GUARD_ERROR);
        assert!(is_rate_guard_error(&error));
        let other = std::io::Error::other("gzip boom");
        assert!(!is_rate_guard_error(&other));
        // 20 MiB/s 下限的换算口径：守卫检查本身在 compress_file_to 内闭环,
        // 这里只锁错误标记串的稳定性。
        assert_eq!(RATE_GUARD_ERROR, "compression-rate-guard");
    }

    #[test]
    fn compressible_name_checks_last_extension_only() {
        assert!(is_compressible_name("backup.sql"));
        assert!(is_compressible_name("no-extension"));
        assert!(is_compressible_name("archive.data")); // 未知扩展名不拦
                                                       // 双扩展名以末段为准：.tar.gz / .sql.gz 都是压缩件。
        assert!(!is_compressible_name("dump.sql.gz"));
        assert!(!is_compressible_name("snapshot.tar.gz"));
        assert!(!is_compressible_name("MOVIE.MP4"));
        assert!(!is_compressible_name("lib.so.dll"));
    }

    #[test]
    fn worthwhile_ratio_and_zero_original() {
        assert!(worthwhile(1000, 949));
        assert!(!worthwhile(1000, 950));
        assert!(!worthwhile(1000, 1000));
        // 4 GiB 级不溢出。
        assert!(worthwhile(4 * 1024 * 1024 * 1024, 1024 * 1024 * 1024));
        assert!(!worthwhile(0, 0));
    }

    #[test]
    fn probe_and_remote_commands_quote_paths() {
        assert!(probe_command(false).contains("command -v gunzip"));
        assert!(probe_command(true).contains("command -v tar"));
        let quoted = remote_gzip_command("/data/my file's.sql", "/data/.dbx-x.gz");
        // 单引号转义成 '\''，路径整体在引号内。
        assert!(quoted.contains("'\\''"));
        assert!(quoted.starts_with("gzip -c '"));
        assert!(remote_gunzip_command("/a.gz", "/b").starts_with("gunzip -c '"));
        let tar = remote_tar_command("/data/my dir's", "/data/.dbx-t.tgz");
        assert!(tar.starts_with("tar -czf '"));
        assert!(tar.ends_with("-C '/data/my dir'\\''s' ."));
    }

    #[test]
    fn shell_quote_matches_exec_module_semantics() {
        // 与 crate::exec::shell_quote 的对照证明：同输入同输出。
        let samples = [
            "plain",
            "it's a test",
            "/data/weird name's (1).sql",
            "back\\slash",
        ];
        for sample in samples {
            assert_eq!(shell_quote(sample), crate::exec::shell_quote(sample));
        }
    }

    #[test]
    fn gzip_roundtrip_preserves_bytes_and_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.bin");
        let compressed = dir.path().join("source.gz");
        let restored = dir.path().join("restored.bin");
        // 高冗余数据（压缩明显）+ 尾部唯一字节（往返保真断言）。
        let mut payload = Vec::new();
        for round in 0..4096 {
            payload.extend_from_slice(
                format!("line {round} of highly repetitive log data\n").as_bytes(),
            );
        }
        payload.extend_from_slice(b"tail-marker-0123456789");
        std::fs::write(&source, &payload).unwrap();

        let consumed = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = consumed.clone();
        let compressed_size = compress_file_to(
            &source,
            &compressed,
            &AtomicBool::new(false),
            &move |bytes| counter.store(bytes, Ordering::Release),
            None,
        )
        .unwrap();
        assert!(
            compressed_size < payload.len() as u64 / 2,
            "repetitive data should halve"
        );
        assert_eq!(consumed.load(Ordering::Acquire), payload.len() as u64);

        let decompressed_size = decompress_file_to(
            &compressed,
            &restored,
            &AtomicBool::new(false),
            &no_progress,
        )
        .unwrap();
        assert_eq!(decompressed_size, payload.len() as u64);
        assert_eq!(std::fs::read(&restored).unwrap(), payload);
    }

    #[test]
    fn compress_abort_cleans_partial_target() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.bin");
        let compressed = dir.path().join("source.gz");
        std::fs::write(&source, vec![b'x'; 1024]).unwrap();
        let cancelled = AtomicBool::new(true);
        let error = compress_file_to(&source, &compressed, &cancelled, &no_progress, None)
            .expect_err("cancelled run must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert!(!compressed.exists(), "partial target must be removed");
    }

    #[test]
    fn decompress_corrupt_input_fails() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("bad.gz");
        let target = dir.path().join("bad.out");
        std::fs::write(&source, b"not gzip at all").unwrap();
        assert!(
            decompress_file_to(&source, &target, &AtomicBool::new(false), &no_progress).is_err()
        );
    }

    #[test]
    fn compression_mode_strings_are_wire_stable() {
        assert_eq!(CompressionMode::None.as_str(), "none");
        assert_eq!(CompressionMode::Gzip.as_str(), "gzip");
    }

    // 多成员 gz（MultiGzDecoder 语义）：解压侧对 `gzip` 命令流的多段输出
    // 保持兼容，将来改坏 read 路径时这条测试兜底。
    #[test]
    fn multi_member_gzip_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let compressed = dir.path().join("multi.gz");
        let restored = dir.path().join("multi.out");
        let raw = std::fs::File::create(&compressed).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(raw, flate2::Compression::default());
        encoder.write_all(b"member-one").unwrap();
        let raw = encoder.finish().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(raw, flate2::Compression::default());
        encoder.write_all(b"member-two").unwrap();
        encoder.finish().unwrap();
        decompress_file_to(
            &compressed,
            &restored,
            &AtomicBool::new(false),
            &no_progress,
        )
        .unwrap();
        assert_eq!(std::fs::read(&restored).unwrap(), b"member-onemember-two");
    }

    // tar.gz 解包：普通文件/目录落位、符号链接跳过（与普通树管线「不跟
    // 随 symlink」语义对齐）、进度累计只算普通文件字节。
    #[test]
    fn extract_tar_gz_unpacks_regular_files_and_skips_links() {
        let dir = tempfile::tempdir().unwrap();
        let archive_path = dir.path().join("tree.tgz");
        let root = dir.path().join("staging");
        let file = std::fs::File::create(&archive_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);

        let log_data = b"2026-09-29 compressed tree entry\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(log_data.len() as u64);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        builder
            .append_data(&mut header, "./logs/app.log", &log_data[..])
            .unwrap();

        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_cksum();
        builder
            .append_link(&mut header, "./link-to-log", "logs/app.log")
            .unwrap();

        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();

        let seen = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = seen.clone();
        let extracted = extract_tar_gz(
            &archive_path,
            &root,
            &AtomicBool::new(false),
            &move |bytes| counter.store(bytes, Ordering::Release),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(root.join("logs/app.log")).unwrap(),
            b"2026-09-29 compressed tree entry\n"
        );
        // 符号链接成员被跳过，不落盘。
        assert!(root.join("link-to-log").symlink_metadata().is_err());
        assert_eq!(extracted, log_data.len() as u64);
        assert_eq!(seen.load(Ordering::Acquire), log_data.len() as u64);
    }

    // 路径穿越防护：`../` 成员条目必须被拒绝，不得逃出解包根。tar crate
    // 在 append/set_path 层就拦 `..`，所以这里手搓原始 ustar 头字节构造
    // 恶意归档，验证 unpack_in 的解包侧防线。
    #[test]
    fn extract_tar_gz_rejects_traversal_entries() {
        fn ustar_header(name: &str, size: u64) -> Vec<u8> {
            let mut header = vec![0_u8; 512];
            let name_bytes = name.as_bytes();
            header[..name_bytes.len()].copy_from_slice(name_bytes);
            header[100..108].copy_from_slice(b"0000644\0");
            header[108..116].copy_from_slice(b"0000000\0");
            header[116..124].copy_from_slice(b"0000000\0");
            header[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
            header[136..148].copy_from_slice(b"00000000000\0");
            header[156] = b'0';
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            for byte in header[148..156].iter_mut() {
                *byte = b' ';
            }
            let sum: u32 = header.iter().map(|&byte| byte as u32).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            header
        }
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        let archive_path = dir.path().join("evil.tgz");
        let root = dir.path().join("staging");
        let raw = tempfile::tempdir().unwrap();
        let tar_path = raw.path().join("evil.tar");
        let mut tar_file = std::fs::File::create(&tar_path).unwrap();
        let data = b"escaped";
        tar_file
            .write_all(&ustar_header("../outside.txt", data.len() as u64))
            .unwrap();
        tar_file.write_all(data).unwrap();
        tar_file.write_all(&vec![0_u8; 512 - data.len()]).unwrap();
        tar_file.write_all(&[0_u8; 1024]).unwrap();
        drop(tar_file);
        let mut encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&archive_path).unwrap(),
            flate2::Compression::default(),
        );
        std::io::copy(&mut std::fs::File::open(&tar_path).unwrap(), &mut encoder).unwrap();
        encoder.finish().unwrap();
        // unpack_in 对 `..` 条目是静默跳过（Ok）而非报错——安全性质是
        // 「不得逃逸」，被跳过成员在树管线里会作为缺失文件入账。
        let extracted =
            extract_tar_gz(&archive_path, &root, &AtomicBool::new(false), &no_progress).unwrap();
        assert_eq!(extracted, 0, "skipped entry contributes no bytes");
        assert!(
            !outside.exists(),
            "traversal entry must not escape the root"
        );
        assert!(!root.join("outside.txt").exists());
    }
}
