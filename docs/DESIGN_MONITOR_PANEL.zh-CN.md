# 设计：多服务器监控面板（Monitor Panel）

> 状态：待评审 → 批准后转 `writing-plans` 拆实现计划
> 对标：motty（/Users/Jinpy/btroot/motty）`remotestats` + `monitoring` + `workbench/monitor*.go`
> 关联需求：罗列多个 SSH 服务器的监控卡片，按分组配色等排列；学 motty 补齐缺失特性

## 0. 决策记录（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 监控范围 | 已连接会话为主；未连接主机通过 `reopenConnection` 托管拉起（宿主已有 API，`PluginWorkbenchHost.vue:590`） |
| 分组数据来源 | 宿主连接树已有分组（`sidebarLayout`，`connectionStore.ts:4750`）但 `listConnections` 未暴露 → **在宿主仓库提 issue → 认领 → 开发 → PR** |
| 发布时序 | **方案 A 两阶段解耦**：插件先行，分组缺失时降级平铺；宿主 API 落地后零改动自动启用 |
| 面板形态 | **独立 workbench contribution**（与 `io.dbx.ssh.tunnels` 同范式），不碰 App.vue |
| 未连接策略 | **逐主机开关**：开启才拉起并采集，关闭停采集（不断开 SSH，宿主无 disconnect API） |
| 采集方式 | **长驻流式**（学 motty）：每会话常驻 exec channel，秒级计数器行协议，sidecar 差分 |
| V1 范围 | 核心 dashboard + 直达终端按钮 + 慢采样详情 + 隐私模式 |

## 1. 架构总览

```
DBX 宿主
 ├─ sidebarLayout 分组树 ──(Phase 2: listConnections 暴露 groupId)──┐
 ├─ reopenConnection(connId) ──→ connection/connect 凭据推送 ──┐   │
 └─ host.storage（watched 开关表 / 隐私模式）                   │   │
                                                               ▼   ▼
插件前端（新增，全部不碰 App.vue）                     MonitorPanel.vue
 ├─ main.ts 第三个路由分支（isMonitorContext）
 ├─ composables/useMonitorPanel.ts（编排：开关/storage/snapshot 轮询）
 └─ components/MonitorPanel.vue + MonitorCard.vue
                                                               │ monitor/*（新协议族）
                                                               ▼
Rust sidecar backend/src/monitor.rs（新）
 ├─ MonitorRegistry：connectionId → MonitorTask（常驻 tokio 任务）
 │   ├─ 快通道：常驻 exec channel，1s 一行计数器（CPU/内存/网络）
 │   ├─ 慢通道：常驻 exec channel，5s 一行（load/df/uptime/who）
 │   └─ 内存环形缓冲（cap 720 点，断档记 gap，不落盘）
 └─ 复用 metrics.rs 脚本改造 + metrics_history.rs 的环形 cap 模式
```

工作台内现有 F2 浮卡（`ssh/metrics` pull 制）**保持不动**：那是单机深度视图，与本面板是多机总览，互不依赖。

## 2. sidecar 协议：`monitor/*` 方法族

命名遵循 `docs/PROTOCOL.zh-CN.md` 的 `<域>/<动作>` + camelCase，需同步文档。

| 方法 | 入参 | 返回 |
|---|---|---|
| `monitor/start` | `{connectionId}` | `{state, since}`；幂等：已存在返回现状态 |
| `monitor/stop` | `{connectionId}` | `{state:"stopped"}` |
| `monitor/status` | 无 | `{tasks:[{connectionId,state,error?,since,primaryInterface?}]}` |
| `monitor/snapshot` | `{connectionIds?:string[], points?:number=120}` | `{samples:{[connectionId]:{state, live:Sample, history:(Sample|Gap)[], details?:Details}}}` |
| `monitor/details` | `{connectionId}` | Details（load/df/who，慢通道最新值） |

`Sample`（camelCase，单位与现有 `ssh/metrics` 一致）：`{t, cpuPct, memTotalMb, memUsedMb, netRxKbps, netTxKbps, iface?}`；
`Gap`：`{t, gap:true}`（断档标记，前端 sparkline 跳线不插值）；
`Details`：`{load1, load5, load15, uptimeSec, disks:[{mount,totalMb,usedMb}], users:[{user,tty,from}]}`。

### 任务状态机（学 motty 六态精简为五态）

```
connecting ──脚本就绪──▶ live ──ssh 会话关闭/超时──▶ failed(error) ──Retry──▶ connecting
                            │ 脚本报 unsupported          │
                            ▼                            ▼
                       unsupported                    stopped（显式 stop）
```

- **failed 即终态**，不静默重试；面板卡片给显式 Retry 按钮（学 motty，避免静默后台重试制造意外流量）。
- `connecting`：`monitor/start` 已发出但尚未收到第一行输出（超时 10s → failed）。
- 底层 ssh 会话消失（宿主断开/用户关闭终端最后一个引用）：任务转 failed，error 记原因；面板置灰并提示「会话已关闭」。

## 3. 长驻流式采集（学 motty stats.go v2）

### 3.1 行协议

改造 `metrics.rs` 的 `METRICS_SCRIPT` 为循环版（版本行 `# dbx-mon-v1`）：

```
dbx-mon-cap <uname>              # 能力行；procfs 不可读 → 打 dbx-mon-unsupported 后退出
dbx-mon <epoch_ms> c=<cpu_total_ticks>,<cpu_idle_ticks> m=<mem_total_kb>,<mem_avail_kb> n=<rx>,<tx>,<iface> l=<load1x100>
```

- **服务端零算术**（学 motty）：脚本只输出内核累计计数器（`/proc/stat`、`/proc/meminfo`、`/proc/net/dev`、`/proc/loadavg`），差分、速率、百分比全在 sidecar。
- 主网卡选择沿用 motty 思路：`/proc/net/route` 默认路由接口，**接口切换即断轴**（记一次 Gap）。
- `MemAvailable` 缺失时按 motty 公式自算（`MemFree+Buffers+Cached+SReclaimable-Shmem`，clamp）。
- 非 Linux 远端（BSD/macOS）：V1 先 `unsupported` 优雅降级；V2 考虑复用现有 `ssh/metrics` 的 sysctl 分支。
- 首采样基线（学 motty 0.25s 双快照）：任务启动时先连发两次快照取基线，首屏几乎立即出图。

### 3.2 任务模型（backend/src/monitor.rs 新文件）

- `MonitorRegistry`（`Mutex<HashMap<connectionId, MonitorTask>>`），每任务 2 条常驻 exec channel（快 1s / 慢 5s，互不阻塞——学 motty 快慢分离，慢 df 不卡 CPU 曲线）。
- 快通道空转看门狗：>3×周期未收到行 → 重开通道；连续 2 次失败 → failed 终态。
- 内存环形缓冲 `VecDeque<Sample|Gap>`，cap 720 点（12 分钟 @1s；点数对齐 `metrics_history.rs::MAX_SAMPLES` 语义）。**不落盘**（与 motty 边界一致；V2 可选持久化）。
- 慢通道独立缓冲，cap 144 点（12 分钟 @5s）。
- 并发上限 24 任务，超出 `monitor/start` 返回错误（防通道风暴）。
- 会话引用：sidecar 收到连接关闭事件时任务自动终态化。

## 4. 逐主机开关与生命周期

- **storage 结构**（`host.storage`，插件侧 `shared/frontend/pluginStorage`）：`monitor:{version:1, watched:{[connectionId]:{addedAt}}, privacy:false}`。
- **开启**：写 watched → 未连接则 `reopenConnection(connectionId)`（密码未保存时宿主弹密码框，属预期交互）→ 宿主推 `connection/connect` → `monitor/start`。**连接建立感知机制**：面板不依赖推送事件，由 `useMonitorPanel` 低频轮询 `ssh/sessions/list`（复用现有轮询模式），发现 `watched ∩ connected` 中存在未启任务者即补 `monitor/start`（同时覆盖「面板未开时新连接不自动启采」空窗的面板 boot 恢复）。
- **关闭**：`monitor/stop` + 从 watched 移除；**不断开 SSH 连接**（宿主无 disconnect 插件 API，已列入 feature request 可选项）。
- **恢复**（学 motty「采样与可见性解耦」，适配我们模型）：sidecar 任务与面板可见性解耦——面板关闭任务照跑；面板 boot 时读 watched 表，对其中已连接者补 `monitor/start`（覆盖「面板未开时新连接不自动启采」的空窗）。
- **列表数据源**：`host.listConnections({all:true})`（全量、secret-free、含 `connected` 布尔）∪ sidecar `ssh/sessions/list`（交叉校验）。

## 5. UI：MonitorPanel.vue

- **路由**：`main.ts` 仿 `isTunnelManagerContext` 加 `isMonitorContext` 分支（依据宿主 context 的 contributionId）。
- **布局**：分组区块按序排列；每组 = 组头（色条 + 组名 + 计数）+ 组内**等宽网格** `repeat(auto-fill, minmax(260px,1fr))`；无分组 → 单一平铺区。
- **配色**：组名 hash → 8 色板索引（固定色板，跟随宿主侧栏组色语义；Phase 1 无分组时不着色）。
- **卡片**（MonitorCard.vue）：
  - 头部：主机名（隐私模式下「Server #序号」）+ 状态徽标（五态）+「打开终端」按钮（复用 `openWorkbench` 现有调用模式）+ 未连接卡片显示「加入监控」开关
  - 中部：三条 sparkline（CPU/内存/网络），复用 `lib/metricsSparkline.ts`，Gap 断档跳线
  - 底部：实时值 + 展开按钮 → 详情抽屉（load/df/who，慢通道数据）
- **工具栏**：全局隐私模式开关、全局刷新间隔选择（2/5/10/30/60s，默认 5s）、状态筛选（全部/Live/异常）。
- **i18n**：`frontend/src/lib/i18n.ts` 七语新增键；manifest contribution label/description 七语。

## 6. 宿主侧 feature request（issue → 认领 → PR）

在宿主仓库提 issue（先 issue 后 claim，按用户工作流）：

1. **主项**：`host.listConnections({all:true})` 返回值增加 `groupId` / `groupName`（可选 `groupOrder`，或保证数组顺序即侧栏布局顺序）。数据源已在 `connectionStore.ts`（`appendConnectionToLayout`、`renameConnectionGroup`）；改动点参照 #12603 那次 `listConnections` 扩展提交的模式（`PluginWorkbenchHost.vue:593` scrub + 类型声明 + 沙箱 SDK shim `pluginHostBridge.ts:1454`）。
2. **可选子项**：`host.disconnectConnection(connectionId)`——支撑监控开关「关闭则断开」语义；缺失时 V1 关开关只停采集。

插件侧消费方式：`listConnections` 响应中**字段探测**（有 `groupId` 键则启用分组渲染），不依赖 host_api 版本号，满足 `engines.host_api: ">=1.0.0"` 基线的 optional 降级纪律。

## 7. motty 特性取舍表

| motty 特性 | V1 | V2+ | 不做 |
|---|---|---|---|
| 多机 dashboard 多面板制（面板=主机集合+间隔+保留期） | 简化为单面板全局间隔 | 多面板配置 | — |
| 分组来自主机目录 + 组筛选/搜索/拖拽排序 | 组区块排列 + 状态筛选 | 搜索、拖拽排序 | — |
| 长驻流式脚本、服务端零算术 | ✅ | — | — |
| NaN 断档语义、网卡切换断轴 | ✅ | — | — |
| 快慢双采样（慢 df/load/who 不卡 CPU） | ✅ | — | — |
| 0.25s 双快照首采样 | ✅ | — | — |
| 状态徽标 | 五态 | — | — |
| 错误终态化 + 显式 Retry | ✅ | — | — |
| 每行直达终端 | ✅ | — | — |
| 隐私模式 | ✅ | — | — |
| 采样与可见性解耦 | 适配版（见 §4） | — | — |
| 环形缓冲不落盘 | ✅ | 可选持久化 | — |
| 告警/导出/阈值 | — | — | ✅（与 motty 边界一致） |

## 8. 兼容与降级

- Host API ≥1.0 基线：`reopenConnection`（1.0 已有）、`listConnections`（**provider-scoped 分支**，无新权限依赖——本插件即 DBX 的 SSH provider，`io.dbx.ssh.connection` 下的全部连接可枚举；带 `all` 的分支需 `host.connections:read` 权限，manifest 未声明，不采用）、`host.storage`（capabilities.storage 缺失时 watched 不持久化，降级为会话内状态）、分组字段探测（§6）。
- 连接过滤：provider-scoped 列表已天然限于 SSH/VNC/RDP/本地 shell 等 `io.dbx.ssh.*` provider；监控列表再按 dbType 过滤仅留 `ssh`，排除本地 shell 与远程桌面。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 长驻 channel 弱网断流 | 看门狗重开（§3.2）+ failed 终态不重试 |
| N 台常驻通道开销 | 24 任务上限；快慢通道各一条/会话，非轮询风暴 |
| 面板未开时新连接不自动启采 | 面板 boot 恢复逻辑（§4）+ status 兜底 |
| 宿主分组 API 排期不定 | 字段探测降级平铺，功能不残 |
| 改动面 | App.vue 零改动；协议新增为平行族，`ssh/metrics` 不动 |

## 10. 测试策略

- **Rust**：`monitor.rs` 单测——行协议解析（含 unsupported/cap 行）、差分与速率、环形缓冲 Gap 语义、状态机迁移、并发上限；沿用 `metrics.rs`/`metrics_history.rs` 既有测试风格。
- **前端**：`MonitorPanel.spec.ts`——分组渲染/降级平铺、隐私模式、开关编排（mock bridge）、五态徽标、sparkline Gap 跳线；`useMonitorPanel` 纯逻辑抽测。
- **协议一致性**：`PROTOCOL.zh-CN.md` 同步 `monitor/*` 五方法；跑 `scripts/` 下协议审计脚本。
- **手工验证**：mock host（`mockDbxHost.ts` 扩展）+ 真机 1/3/10 台服务器对比基线。

## 11. 交付物清单

| 层 | 文件 |
|---|---|
| manifest | 第三个 workbench contribution `io.dbx.ssh.monitor`（七语）、七语 i18n |
| backend | 新 `monitor.rs`（任务模型/协议/缓冲/方法）；`model.rs` 注册；`main.rs` 路由 |
| frontend | `MonitorPanel.vue`、`MonitorCard.vue`、`useMonitorPanel.ts`、`main.ts` 路由分支、`env.d.ts` 能力位注释、`mockDbxHost.ts` |
| 复用 | `metrics.rs` 脚本改造（新增循环版常量，保留原版）、`metricsSparkline.ts`、`shared/frontend/pluginStorage` |
| 文档 | `PROTOCOL.zh-CN.md`、`FEATURE_PARITY.zh-CN.md` 新条目、本设计文档 |
| 宿主仓库 | feature request issue（主项+可选子项）→ 认领 → 宿主 PR（独立工作流，不阻塞插件 Phase 1） |
