# 实现计划：多服务器监控面板（Monitor Panel）

> Spec：`docs/DESIGN_MONITOR_PANEL.zh-CN.md`（已批准）。本计划是唯一实现依据；与 spec 冲突时以本计划为准（差异：采样时间戳由 sidecar 到达时刻打点，不依赖远端 `date +%s%3N`——busybox 无 `%3N`）。
> 执行方式：三个并行 lane，各在独立 git worktree（AGENTS.md：一 agent 一 worktree，本 checkout 内禁止并发 agent）。
> 交付纪律：协议/manifest 属 high-risk，最终交人工 review；安装与 DBX 重启永不自动执行。

## 0. 环境与硬规则（每个 agent 必读）

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:$PATH"
# Rust 固定 1.88.0（rust-toolchain 固定），Node v22.21.0，pnpm
```

- 禁止真实 SSH 凭据/生产主机；测试全部走单测 fixture 与 mock host。
- 远端命令一律 POSIX sh + 单引号转义纪律（沿用 `metrics.rs` 脚本风格）。
- 提交信息用 conventional commits（`feat(monitor): …` / `test(monitor): …`），每任务一提交。
- **不要**动 `Cargo.lock`、`ui/`（生成物）、版本号——集成者所有。
- 不要跑 `scripts/build.sh` 打包或任何安装动作。

## 1. 协议契约（锁死，三 lane 共同唯一来源）

新增 sidecar 方法族（同步进 `docs/PROTOCOL.zh-CN.md`，风格照抄 `ssh/metrics` 条目）：

| 方法 | 入参 | 返回 |
|---|---|---|
| `monitor/start` | `{connectionId}` | `{state, since}` 幂等：已存在返回现状态 |
| `monitor/stop` | `{connectionId}` | `{state:"stopped"}` 幂等 |
| `monitor/status` | `{}` | `{tasks:[{connectionId, state, error?, since, primaryInterface?}]}` |
| `monitor/snapshot` | `{connectionIds?: string[], points?: number=120}` | `{samples:{[connectionId]:{state, live: Sample|null, history: (Sample|Gap)[], details: Details|null}}}` |
| `monitor/details` | `{connectionId}` | `Details` |

```ts
type MonitorState = "connecting" | "live" | "failed" | "unsupported" | "stopped";
type Sample = { t: number; cpuPct: number; memTotalMb: number; memUsedMb: number; netRxKbps: number; netTxKbps: number; iface?: string };
type Gap = { t: number; gap: true };
type Details = { load1: number; load5: number; load15: number; uptimeSec: number; disks: { mount: string; totalKb: number; usedKb: number }[]; users: { user: string; tty: string; from: string }[] };
```

单位约定（写进 PROTOCOL）：`t` = sidecar 到达时刻 unix ms；`cpuPct` 0..100 一位小数；内存 MB=1024²B；`netRxKbps/netTxKbps` = KiB/s（1024 B/s）一位小数；磁盘 KB=1024B。

状态机：`connecting →(首行计数器)→ live`；`→(cap 行报不支持)→ unsupported`；`→(通道 EOF/超时)→ failed{error}`；任何态 `→(monitor/stop)→ stopped`。failed/unsupported **终态**，仅显式 retry（stop+start）可复活。watchdog：快通道 >3s 无行 → 重开通道；连续 2 次失败 → failed。并发上限 24 任务，超限 `monitor/start` 返回 `Err("monitor task limit reached (24)")`。

## 2. Worktree 与 lane 划分

```bash
# 集成者（主会话）创建；agent 只在指派给它的 worktree 里工作
git -C /Users/Jinpy/btroot/dbx-plugin-ssh worktree add ../dbx-plugin-ssh-mon-a -b feat/monitor-backend
git -C /Users/Jinpy/btroot/dbx-plugin-ssh worktree add ../dbx-plugin-ssh-mon-b -b feat/monitor-frontend
git -C /Users/Jinpy/btroot/dbx-plugin-ssh-mon-a checkout main -- backend  # 无需，worktree 自带全量文件
```

- **Lane A**（worktree `../dbx-plugin-ssh-mon-a`，分支 `feat/monitor-backend`）：backend 采集任务 + 协议 + PROTOCOL 文档。
- **Lane B**（worktree `../dbx-plugin-ssh-mon-b`，分支 `feat/monitor-frontend`）：前端面板 + i18n + mock + spec（i18n 新键允许新增，不改既有键；`manifest.json` 不碰，归 Lane C）。
- **Lane C**（worktree `../dbx-plugin-ssh-mon-c`，分支 `feat/monitor-manifest`）：manifest contribution + 七语 localizations + 宿主 issue 草案 + FEATURE_PARITY 条目。
- 集成：主线 merge 三分支 → cargo test + pnpm test/typecheck + build + 协议审计 → 人工 review。

## 3. Lane A：backend（worktree mon-a）

### A1. 流式采集脚本与解析（TDD：先写解析测试）

**`backend/src/monitor.rs` 新文件**，头部注释沿用 `metrics.rs:1-11` 的风格。常量：

```rust
//! Resident streaming monitor: one long-lived exec channel per connection
//! emitting counter lines once per second; all rate math lives on this side.

pub const MONITOR_TASK_LIMIT: usize = 24;
pub const FAST_RING_CAP: usize = 720;   // 12 min @ 1s
pub const SLOW_RING_CAP: usize = 144;   // 12 min @ 5s
pub const SNAPSHOT_DEFAULT_POINTS: usize = 120;
const MON_FAST_SCRIPT: &str = concat!(
    "echo \"dbx-mon-cap $(uname -sr)\"; ",
    "[ -r /proc/stat ] && [ -r /proc/net/dev ] && [ -r /proc/meminfo ] || ",
    "{ echo \"dbx-mon-unsupported $(uname -s)\"; exit 0; }; ",
    "while :; do ",
    "set -- $(grep '^cpu ' /proc/stat); ",
    "c_total=$(($2 + $3 + $4 + $5 + $6 + $7 + $8)); c_idle=$(($5 + $6)); ",
    "m_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo); ",
    "m_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo); ",
    "case \"$m_avail\" in ''|*[!0-9]*) m_avail=$(awk 'BEGIN{f=b=c=s=sh=0}",
    "/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SReclaimable:/{s=$2}",
    "/^Shmem:/{sh=$2}END{a=f+b+c+s-sh; if(a<0)a=0; print a}' /proc/meminfo);; esac; ",
    "iface=$(awk '$2==\"00000000\"{print $1; exit}' /proc/net/route 2>/dev/null); ",
    "case \"$iface\" in ''|*[!A-Za-z0-9.@_-]*) iface=$(awk 'NR>2{sub(/:.*/,\"\",$1);",
    "if($1!=\"lo\"){print $1; exit}}' /proc/net/dev);; esac; ",
    "n_rx=0; n_tx=0; ",
    "case \"$iface\" in ?*) eval \"$(awk -v IF=\"$iface\" 'NR>2{sub(/:.*/,\"\",$1);",
    "if($1==IF){print \"n_rx=\"$2\"; print \"n_tx=\"$10; exit}}' /proc/net/dev)\";; esac; ",
    "l1=$(awk '{print int($1*100)}' /proc/loadavg); ",
    "printf 'dbx-mon c=%s,%s m=%s,%s n=%s,%s,%s l=%s\\n' ",
    "\"$c_total\" \"$c_idle\" \"$m_total\" \"$m_avail\" \"$n_rx\" \"$n_tx\" \"$iface\" \"$l1\"; ",
    "sleep 1; done",
);
```

慢通道脚本 `MON_SLOW_SCRIPT`（同文件常量，同样风格）：

```text
while :; do
  echo "dbx-det load=$(cut -d' ' -f1-3 /proc/loadavg)"
  echo "dbx-det uptime=$(awk '{print int($1)}' /proc/uptime)"
  df -P -k / 2>/dev/null | tail -n +2 | awk '{printf "dbx-det disk=%s,%s,%s\n", $6, $2, $3}'
  who 2>/dev/null | head -20 | awk '{printf "dbx-det user=%s,%s,%s\n", $1, $2, $3}'
  echo "dbx-det end"
  sleep 5
done
```

解析为**纯函数**（无 IO，全部可单测）：

```rust
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Sample { pub t: u64, pub cpu_pct: f64, pub mem_total_mb: f64, pub mem_used_mb: f64,
    pub net_rx_kbps: f64, pub net_tx_kbps: f64, #[serde(skip_serializing_if = "Option::is_none")] pub iface: Option<String> }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GapPoint { pub t: u64, pub gap: bool } // 始终 gap:true；serde 产出 {"t":..,"gap":true}
#[derive(Debug, Clone, PartialEq, serde::Serialize, Default)]
pub struct Details { pub load1: f64, pub load5: f64, pub load15: f64, pub uptime_sec: u64,
    pub disks: Vec<DiskRow>, pub users: Vec<UserRow> }

pub enum CounterLine { Cap(String), Unsupported(String), Counters(Counters), Ignored }
pub struct Counters { pub cpu_total: u64, pub cpu_idle: u64, pub mem_total_kb: u64, pub mem_avail_kb: u64,
    pub rx: u64, pub tx: u64, pub iface: String, pub load1_x100: u64 }

pub fn parse_counter_line(line: &str) -> CounterLine;      // 容错：非法行 → Ignored
pub fn diff_counters(prev: &Counters, next: &Counters, t_ms: u64) -> Sample;
    // Δt<=0 或 iface 变化 → 调用方记 Gap 后丢弃（iface 变化语义见下）
    // cpu_pct = (Δtotal-Δidle)/Δtotal*100 clamp 0..100；Δtotal==0 → cpu 0
    // mem_used_mb = (total-avail)/1024 clamp>=0；kbps = Δbytes*1024/Δt 秒 /1024 → Δbytes/Δt 秒（KiB/s=ΔB/s/1024*1024…实现注释写清：rx 单位是字节，Kbps=(Δrx/Δt_sec)/1024*1024/1024，即 Δrx/Δt_sec/1024*1.0 —— 用 `Δbytes as f64 / dt_secs / 1024.0` 得 KiB/s）
pub fn parse_detail_block(lines: &[&str]) -> Details;       // "dbx-det end" 前的行
```

测试（`monitor.rs` 底部 `#[cfg(test)]`，风格仿 `metrics_history.rs:249` 附近）：合法计数行、不支持行、cap 行、畸形行、`MemAvailable` 缺失回退公式、iface 变化 Gap、cpu clamp、零 Δt、Kbps 换算、detail 块解析。

**提交**：`test(monitor): counter-line parsing and diff math`（先红后绿一次提交完成 TDD 循环，注释标注 fixture 来源）。

### A2. 任务模型与注册表

同文件继续（模式参照 `task_provider.rs` 的 TaskRegistry + `main.rs:569` `self.tasks` 挂法）：

```rust
pub struct MonitorRegistry { tasks: std::sync::Mutex<std::collections::HashMap<String, Arc<TaskHandle>>> }
struct TaskHandle { state: RwLock<MonitorState>, error: RwLock<Option<String>>, since: RwLock<u64>,
    iface: RwLock<Option<String>>, fast: RwLock<VecDeque<Point>>, slow: RwLock<VecDeque<DetailPoint>>,
    last: RwLock<Option<Counters>>, cancel: tokio::sync::watch::Sender<bool>, done: AtomicBool }
enum Point { Sample(Sample), Gap(GapPoint) }
```

- `start(&self, ssh: &SshSessionMap, connection_id: &str, spawner: &tokio::runtime::Runtime) -> Result<Value, String>`：
  1. 查表幂等返回；超 24 上限报错。
  2. 解析 handle：参照 `ssh.rs:4264 attach_session` 的注册表扫描，新增 `SshSessionMap::live_handle_for_connection(connection_id) -> Option<Handle<SshClient>>`（遍历 `self.sessions`，取 `connected==true && entry.connection_id==connection_id` 的 entry；Handle 获取方式与 `ssh.rs:5833 metrics()` 同源——读 `metrics()` 找到 entry→handle 访问器并复用）。
  3. spawn 快慢两个通道循环（共用 cancel watch）：通道生命周期**必须显式关闭**——`exec.rs:1058` 注释明言 drop russh Channel 不发 CLOSE、远端进程泄漏；复用 `exec.rs` 的 `abort_exec_channel` 或先 `cancel` 再 `channel.close()`。
  4. 快循环：`channel_open_session` → `exec(true, MON_FAST_SCRIPT)` → 循环 `channel.wait()`（读法参照 `exec.rs:1370 run_to_completion` 的 while-msg 循环，但**不设总超时**、只设 3s 行间看门狗：`tokio::time::timeout(3s, channel.wait())` 超时即认为断流，break 重开通道；重开计次 ≥2 → 置 failed）。首行 `dbx-mon-cap` 记录 uname；`dbx-mon-unsupported` → unsupported 终态；首个 `dbx-mon` 计数行：`state=live`，存 last 不出样（基线）；后续行 diff 出样 push 快环（cap 720，满则 `pop_front`）；iface 与 last 不同 → push Gap 再 diff（断轴）。
  5. EOF/通道错误 → failed{error}（不重试）。
  6. `stop()`：send cancel → join（带 2s 超时）→ state=stopped；**通道必须走 abort/close 路径**。
- `stop/status/snapshot/details` 方法按 §1 契约；snapshot 的 `points` clamp(1, FAST_RING_CAP)，history 取环尾 N；`live` 仅 live 态非空。
- `main.rs`：`mod monitor;`（照 `mod multi_exec;` 的 flat 列表位置）；Server struct 加 `monitors: monitor::MonitorRegistry`，构造处仿 `self.tasks`（grep `TaskRegistry::new`）；`handle_request` 加 5 个 method 分支（全部 `self.runtime.block_on(...)`，风格照 `"task/start" =>` 一支）。

**提交**：`feat(monitor): resident streaming monitor tasks with ring buffers`。

### A3. 协议文档

`docs/PROTOCOL.zh-CN.md` 在 `ssh/metrics` 族后新增 `monitor/*` 五方法条目（含 §1 的类型表、单位约定、状态机、上限、终态语义）。**提交**：`docs(protocol): monitor/* streaming monitor methods`。

### A4. Lane A 自验

```bash
cd /Users/Jinpy/btroot/dbx-plugin-ssh-mon-a/backend && cargo test 2>&1 | tail -5
# 全绿 + cargo clippy 无新告警（若仓库有 lint 习惯则跟随）
```

## 4. Lane B：frontend（worktree mon-b）

### B1. 路由与上下文（TDD）

`frontend/src/lib/pluginContext.ts` 追加：

```ts
/** Monitor workbench contribution id; routing gate mirrors io.dbx.ssh.tunnels.quick usage in main.ts. */
export const MONITOR_CONTRIBUTION_ID = "io.dbx.ssh.monitor";
export function isMonitorContribution(contributionId: string | undefined | null): boolean {
  return contributionId === MONITOR_CONTRIBUTION_ID;
}
```

`frontend/src/main.ts`：import `MonitorPanel from "./MonitorPanel.vue"` 与 `isMonitorContribution`；115 行路由改为三分支：

```ts
const app = isMonitorContribution(openedContributionId) ? createApp(MonitorPanel, { context })
  : isTunnelManagerContext(context) ? createApp(TunnelManager, { context })
  : createApp(App);
```

测试：`pluginContext.spec.ts`（若已有则追加；否则新建）覆盖 `isMonitorContribution`。

**提交**：`feat(monitor): route monitor workbench contribution to MonitorPanel`。

### B2. Sparkline Gap 支持（TDD）

`frontend/src/lib/metricsSparkline.ts` 追加纯函数：

```ts
/** Gap-aware segmented polyline points: gaps split the series; empty segment → no points. */
export function sparklineSegments(values: readonly number[], gaps: readonly boolean[], width: number, height: number): string[] {
  // 按 gaps 切段；每段各自 sparklinePath（沿用既有归一化/钳制语义）；全 gap → []
}
```

注意：分段后每段**独立归一化**会造成段间比例失真——采用分段共享 max：段前先算全序列 max（同 `sparklinePath` 语义），各段映射 y。实现时可在 `sparklinePath` 加可选 `max?: number` 参数（默认行为不变，既有调用零改动）。spec：`metricsSparkline.spec.ts` 追加：全 gap、单 gap 两段、无 gap 与旧函数输出一致。

**提交**：`feat(monitor): gap-aware segmented sparklines`。

### B3. pluginStore 新键

`frontend/src/lib/pluginStore.ts` 的 `PLUGIN_STORE_KEYS` 追加三键（注释说明用途）：

```ts
"ssh-monitor-watched",     // {"version":1,"watched":{[connectionId]:{"addedAt":number}}} 逐主机监控开关
"ssh-monitor-privacy",     // "1"|"0" 隐私模式（截图安全）
"ssh-monitor-refresh-ms",  // "2000"|"5000"|"10000"|"30000"|"60000" 面板刷新间隔
```

**提交**：`feat(monitor): pluginStore keys for monitor panel preferences`。

### B4. useMonitorPanel.ts（编排核心）

`frontend/src/composables/useMonitorPanel.ts` 新文件。要点（全部逻辑可注入 api 与定时器，便于单测）：

```ts
export interface MonitorApi { invoke: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>; }
export function useMonitorPanel(deps: { api: MonitorApi; storage: KvBacking; /* pluginStore */ timers?: ... }) {
  // 状态
  const connections = ref<ConnRow[]>([]);        // {id,name,dbType,connected}
  const tasks = ref<TaskRow[]>([]);              // monitor/status
  const snapshots = ref<Record<string, Snapshot>>(); // monitor/snapshot
  const watched = ref<Record<string, { addedAt: number }>>({});
  const privacy = ref(false); const refreshMs = ref(5000);
  // 编排
  refreshTimer：每 refreshMs → invoke("monitor/snapshot", {}) 失败静默计数，连续 3 次失败停止并置 pollStopped（仿 docker pollStopped 文案键模式）
  reconcileTimer：5s → ① listConnections（provider-scoped，无参数）过滤 dbType==="ssh" ② invoke("monitor/status") ③ 对 watched∩connected 且无任务者 invoke("monitor/start") ④ 对不在 watched 的有任务者 invoke("monitor/stop")
  // 动作
  async function toggleWatch(connectionId, on): on→写 watched+立即 reconcile；off→start/stop 由 reconcile 收敛（先 invoke stop 再删键）
  function retry(connectionId) { await invoke("monitor/stop",{connectionId}); await invoke("monitor/start",{connectionId}); }
  function openTerminal(connectionId, name, providerId) { // 照抄 App.vue:5485 openConnectionSurface 的调用形状（含 forceNew:true）
  }
}
```

测试：`useMonitorPanel.spec.ts` 用假 api + fake timers 覆盖：watched 恢复补启、未 watched 自动停、快照失败 3 次停轮询、retry 序列（stop→start）、dbType 过滤。

**提交**：`feat(monitor): monitor panel orchestration composable`。

### B5. 组件

`frontend/src/components/MonitorPanel.vue`（面板根，`defineProps<{ context }>` 仿 TunnelManager.vue:8）与 `frontend/src/components/MonitorCard.vue`。渲染要求：

- 分组：`listConnections` 含 `groupId` 字段时按组分区（组头=色条+组名+计数；组内 `grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3`），组顺序按数组首次出现序；无 `groupId` 字段 → 单一平铺区（Phase 1 降级）。
- 组色：`groupColorIndex(groupId)` —— 对 groupId 做 FNV-1a hash % 8 取固定 8 色板（Tailwind 语义色 CSS 变量数组，常量写在组件内），导出为纯函数供 spec。
- 卡片：名（privacy 时 `#序号` 按组内序）、五态徽标（i18n 键）、三条 sparkline（CPU/内存/网络；gap 分段；样本=history 尾部转数值+gapFlags）、实时值行、底部「详情」展开（details: load/uptime/df/users）、右上「终端」按钮（connected 才可点）、「加入监控」开关（未连接时替代 sparkline 区显示灰色占位+说明文案）。failed 卡片整卡降透明度 + Retry 按钮；unsupported 显示说明文案。
- 工具栏：隐私开关、间隔下拉（2/5/10/30/60s）、状态筛选（all/live/issues）。

测试 `MonitorPanel.spec.ts`：分组渲染/降级平铺、隐私改名、五态徽标与 Retry 可见性、gap 断档分段渲染、watched 开关联动。挂载用 stub 子组件 + 注入假 composable（仿 `MetricsPanel.spec.ts` 的既有做法——先读该文件再动手）。

**提交**：`feat(monitor): monitor dashboard panel with grouped cards`。

### B6. i18n 与 mock

- `frontend/src/lib/i18n.ts`：七个 locale 各加 `monitor` 命名空间（键见下方清单，文案语义一致即可，en 为基准）：

```ts
monitor: { title, privacy, privacyHint, refresh, filterAll, filterLive, filterIssues,
  badgeConnecting, badgeLive, badgeFailed, badgeUnsupported, badgeStopped,
  addWatch, removeWatch, openTerminal, retry, details, detailsLoad, detailsUptime,
  detailsDisks, detailsUsers, sessionClosed, pollStopped, emptyGroup, noServers,
  taskLimit, cpu, memory, network }
```

- `frontend/src/mockDbxHost.ts`：追加 `monitor/start|stop|status|snapshot|details` mock（脚本式推进的假计数器，读现有 mock 的风格后仿写）。
- `frontend/src/env.d.ts`：`capabilities` 注释补 `monitorContribution?: boolean` 说明（仅注释，不加字段——分组靠字段探测）。

**提交**：`feat(monitor): seven-locale copy and mock host methods`。

### B7. Lane B 自验

```bash
cd /Users/Jinpy/btroot/dbx-plugin-ssh-mon-b/frontend
pnpm typecheck && pnpm test 2>&1 | tail -5
```

## 5. Lane C：manifest 与宿主 issue（worktree mon-c）

### C1. manifest

- `contributions` 数组在 `io.dbx.ssh.tunnels` 后加：

```json
{ "type": "workbench", "id": "io.dbx.ssh.monitor", "label": "Monitor", "description": "Live resource monitor for multiple SSH servers, grouped and colour-coded.", "icon": "assets/plugin.svg" }
```

- `localizations` 七个 locale 的 `contributions` 各加 `"io.dbx.ssh.monitor": {"label": …, "description": …}`（zh-CN：「监控」「多台 SSH 服务器的实时资源监控，按分组配色排列」；其余语言同语义；注意 pt-BR 键名）。
- 图标复用 `assets/plugin.svg`（新图标归后续视觉任务，不阻塞）。

**提交**：`feat(manifest): monitor workbench contribution with seven-locale copy`。

### C2. 宿主 feature request 草案

新文件 `docs/HOST_ISSUE_MONITOR_GROUP_API.zh-CN.md`，内容（给出可直接粘贴宿主 issue 的中英双语正文）：

- 标题：`Plugin API: expose connection sidebar group in host.listConnections (provider-scoped)`
- 动机：SSH 监控面板按宿主侧栏分组配色排列；分组数据模型已在宿主（`connectionStore.ts` `sidebarLayout`、`appendConnectionToLayout`、`renameConnectionGroup`），插件 API 未暴露。
- 提议：`host.listConnections()`（provider-scoped 分支，`PluginWorkbenchHost.vue:593-663` scrub）返回值增加 `groupId`/`groupName`（可选：数组顺序即侧栏布局顺序，或提供 `groupOrder`）。
- 可选子项：`host.disconnectConnection(connectionId)`——供监控面板「关闭开关断开连接」语义（V1 缺失时只停采集不断连）。
- 宿主改动面（供 claim 后评估）：`PluginWorkbenchHost.vue` listConnections scrub、`pluginHostBridge.ts` SDK shim 类型、宿主插件类型声明、相关 spec。
- 风险：纯增量字段，旧插件不读新键不受影响；无凭据暴露。

### C3. FEATURE_PARITY

`docs/FEATURE_PARITY.zh-CN.md` 监控相关区新增条目：多服务器监控面板（状态：本期新增，对标 motty dashboard，引用 DESIGN 文档 §7 取舍表）。

**提交**：`docs(monitor): host group API issue draft and parity entry`。

## 6. 集成（主会话/集成者执行，非 lane agent）

1. merge 三分支到 main（协议字段/Lane A 先行，Lane B mock 与之对齐核对 §1 契约）。
2. `cargo test`（backend）+ `pnpm typecheck && pnpm test`（frontend）+ `frontend/node build.mjs`。
3. 核对 `docs/PROTOCOL.zh-CN.md` ↔ `main.rs` dispatch ↔ `mockDbxHost.ts` 三方方法名/字段一致。
4. `dbx-plugin.toml` 的 include 无需改（assets/ui 已含）。
5. 汇总 base SHA、变更文件、测试结果、风险清单（协议+manifest=high-risk）提交人工 review。**不打包、不安装、不重启 DBX。**
