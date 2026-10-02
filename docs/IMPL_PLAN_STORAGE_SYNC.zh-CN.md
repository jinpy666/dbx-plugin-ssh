# 存储迁移实施计划：sidecar 配置 → DBX host.storage（吃上配置加密同步）

> 目标：插件的**配置类**数据（全局偏好 + 连接级设置）尽量落进 DBX 提供的
> `host.storage`（`plugin-data/<id>/ui-storage.json`），从而跟随宿主的云同步
> 与 secrets 加密体系；历史/审计/录制/密钥类按性质留 sidecar，并说明边界。
>
> 状态标记：✅ 已完成 / 🔜 待实施 / ⛔ 明确不做（含理由）。

## 0. 宿主能力事实（本仓 review 实证，2026-10）

| 事实 | 证据 |
| --- | --- |
| 云同步只收集每个插件的 `ui-storage.json` | 宿主 `dbx-core/src/persistence/cloud_sync.rs` `load_plugin_ui_storage`：仅 `registry.plugin_data_dir(id).join("ui-storage.json")` |
| ui-storage 仅随 secrets 同步走加密载荷 | 同文件 `build_sync_snapshot_with_selection`：`include_secrets=false` → `selection.plugin_ui_storage = Some(Vec::new())`；开启则整值进 `payload.plugin_ui_storage`，AES-GCM + Argon2(passphrase) |
| 宿主给 sidecar 注入 `DBX_PLUGIN_DATA_DIR=<data>/plugin-data/<id>` | 宿主 `dbx-plugin-runtime/src/plugins.rs:127`（测试 :472）；实机 `~/Library/Application Support/com.dbx.app/plugin-data/io.dbx.ssh/` 双方同树 |
| host.storage 只有 webview TS 层能调（Tauri command），sidecar 无存储 RPC | 宿主 `src-tauri/src/commands/plugin_storage.rs` 头注释；`dbx-plugin-runtime/plugins/host.rs` 无存储面 |
| 容量上限：单值 256KiB / 整库 1MiB / 1024 键 | `plugin_storage.rs` 常量；注释明示 "UI-state store — bulk data belongs to the sidecar" |
| web 直连模式无 ui-storage.json | `shared/frontend/pluginStorage.ts`：web 宿主落顶层文档 localStorage；sidecar 读文件为空 |

sidecar 读宿主文件已有先例：`backend/src/tunnel_menu.rs` 每次调用直读
`ui-storage.json`（只读、无缓存），本计划复用该模式。

## 1. 现状归属（迁移前的对照表）

| 数据 | 现落点 | 跟随同步/加密 | 处置 |
| --- | --- | --- | --- |
| 前端 25 个 UI 偏好键（PLUGIN_STORE_KEYS） | ui-storage.json | ✅（开 secrets 同步时密文上云） | 保持 |
| 连接级凭据（表单 binding:"secret"） | 宿主 connection_secrets，不落 sidecar 盘 | ✅ | 保持 |
| 全局：quick-commands / highlight-rules / sftp-bookmarks / mcp-settings | sidecar 各自 JSON 文件 | ❌ 本地明文（已镜像） | ✅ 批 1 已落地 |
| 连接级：agent-modes / agent-approved-commands / startup-commands / sftp-name-encoding-overrides | sidecar JSON（按 connectionId 分桶） | ❌ 本地明文（已镜像） | ✅ 批 2 已落地 |
| 全局：下载目录/传输并发/压缩/SFTP 兼容/编码/历史建议偏好 | sidecar preferences.json + localStorage web 缓存 | ❌（已镜像） | ✅ 批 3 已落地 |
| 历史/审计/指标/录制/传输 spool | sidecar 文件 | ⛔ | 见 §4 |
| known_hosts（按 host:port） | sidecar 文件 | ⛔ | 见 §4 |
| Quick Sudo 档案 / OTP 库 | sidecar + 插件自建 vault（AES-256-GCM + vault.key） | ⛔（自加密，非宿主体系） | 见 §4 |

## 2. 批次拆解

### ✅ 批 0：修 PLUGIN_STORE_KEYS 水合缺口（已落地）

`ssh-command-history-meta` / `ssh-ghost-tab-accept` / `ssh-suggestion-blocklist`
三个键走 pluginStore 但未登记——宿主水合只拉白名单键，真机写穿能落盘、重启
永远读不回（history 面板列丢失、Tab 开关重置、黑名单复活）。已补入白名单 +
`pluginStorage.spec.ts` 键集全等断言更新 + 两个功能 spec 增加成员断言；
`pluginStore.ts` 头注释例外清单同步修正（补 transfer 系 4 键与
sftp-compat/encoding 2 键）。

### ✅ 批 1：全局偏好迁 host.storage（quick-commands / highlight-rules / sftp-bookmarks / mcp-settings，全部落地）

**已落地（快速命令 / 关键词高亮规则 / SFTP 书签）**：这三个域的消费方只有工作台
前端（sidecar 无内部消费），实施取比原方案更简的形态——**前端权威 + sidecar
文件冻结**，零 Rust 改动：

1. 前端成为唯一写方：新增 3 个 PLUGIN_STORE_KEYS（`ssh-quick-commands` /
   `ssh-highlight-rules` / `ssh-sftp-bookmarks`），CRUD 全部走 lib 纯函数
   （`upsertQuickCommand` / `upsertHighlightRule` / `upsertBookmark`，前端生成
   id/时间戳，语义与原后端一致）后整表写穿 pluginStore。接线点：`useQuickCommands`
   （含工具栏/命令条 import）、`useHighlightRules`、`useBatchSend` 内联保存、
   App.vue 书签段。
2. **存量数据一次性搬迁（发布兼容）**：各域 `load*FromStore()` 返回 null（键
   不存在 = 未迁移）才走 sidecar `list` 搬迁并落键；**空清单同样落键**，区分
   "未迁移"与"用户已清空"，杜绝搬迁后旧数据复活。localStorage 同名旧键
   （`ssh-quick-commands`）由 pluginStorage 适配器的惰性搬家自动接力进宿主通道。
3. sidecar 三个 JSON 文件自搬迁后冻结为只读旧档（web 直连降级场景仍可读）；
   RPC 保留 `list` 作种子源，`save`/`delete` 退役不再被工作台调用。
   `docs/PROTOCOL.zh-CN.md` 三个家族已标注 legacy（含此前漏记的
   `ssh/highlightRules/*`，现补记章节并直接标 legacy）。
4. 验证：三域单测新增 13 例（搬迁种子语义/坏 JSON 不复活/round-trip/upsert
   矩阵），全套 vitest 1660 例绿 + typecheck + build 过；sidecar 零改动，
   `smoke_fs_test.py` 17 例不受影响。

**已落地（mcp-settings，镜像模式 Pattern B）**：sidecar 在 MCP serve 时直接
消费自身文件，不适合前端单写，取镜像模式——pluginStore 只存「云同步载荷」，
sidecar 文件仍是即时权威：

1. **保存双写**（`SettingsDialog.saveMcpSettings`）：`mcp/settings/set` 成功后
   把同一份可同步子集（maxRead/maxUpload/maxDownload + 权限档）写入
   `ssh-mcp-settings` 键（settingsModel.ts 助手）。
2. **启动播种/收敛**（App.vue `syncMcpSettingsMirror`）：store 缺失 → 从
   sidecar `get` 播种；存在但与 sidecar 不一致（云同步恢复后）→ 把 store 推回
   sidecar。收敛判定用集合等值（connectionScope 顺序漂移不触发回推）。
3. **两个关键口径**：镜像只取 `persisted*` 权限字段（`execPermissionMode` 是
   生效值，环境变量覆盖不得被回推）；`localTransferRoot` 是设备本地路径，靠
   `set` 的部分更新语义保留，永不进镜像。坏 JSON 镜像回落 null 自愈重播种
   （与批 1 权威数据"坏档不复活"相反——镜像可从 sidecar 安全重建）。
4. 验证：镜像单测 8 例（persisted 优先/默认兜底/播种/自愈/集合等值），
   全套 vitest 1668 例绿 + typecheck + build；PROTOCOL `mcp/settings` 行补
   消费模式注（RPC 行为零变化）。


### ✅ 批 2：连接级设置迁 host.storage 镜像（agent-modes / agent-approved-commands / startup-commands / sftp-name-encoding-overrides，全部落地）

四域的 sidecar 消费点都在运行时（审批门、会话启动、SFTP 列目录现读），且
`ssh/settings/*` 是会话级 RPC、没有"列全部连接设置"的批量口——实施取**镜像
模式（Pattern B）+ 条目级机会式播种**，零 Rust 改动：

1. **通用助手** `lib/connectionSettingMirror.ts`：单键
   `Record<connectionId, 条目>` 的读改写。条目级迁移语义——`load` 返回 null
   （整键缺失/坏档/无该条目）= 该连接未迁移，调用方从 sidecar 播种；条目
   存在但内容垃圾 → sanitizer 收紧为域默认后返回（**不**回退种子，防清空
   复活）；坏整键按空表重建（镜像可从 sidecar 按连接回填）。
2. **播种/收敛点**（都在拿到 sidecar 视图的地方）：
   - 启动命令 + SFTP 编码覆盖：`SettingsDialog.loadStartupCommands` /
     `loadConnNameEncoding`（弹窗打开即有 connectionId；编码镜像条目与
     sidecar 同形——「跟随全局」存 null，垃圾条目归一 null 不会误删覆盖）；
   - agent 模式 + 免审批命令：`SettingsDialog.syncAgentSettingsMirror`
     （reloadSettings 内，ssh/settings/get 之后；漂移时只推漂移域——
     `ssh/settings/set` 是部分更新）；
   - 工具栏快速开关：`useAgentTerminalMode.refreshAgentMode`（读时播种）/
     `applyAgentMode`（切换双写，新增 connectionId 注入）。
3. **保存双写**：`persistStartupCommands` / `persistConnNameEncoding` /
   `saveSettings`（agent 两域）在 RPC 成功后写镜像。
4. **键**（4 个新 PLUGIN_STORE_KEYS）：`ssh-startup-commands` /
   `ssh-name-encoding-overrides` / `ssh-agent-modes` /
   `ssh-agent-approved-commands`。
5. **容量口径**：agent-approved-commands 每连接 ≤50 行（sidecar 既有上限）
   ——镜像沿原值不扩容；百连接 × 50 行 ≈ 0.5MiB 逼近整库 1MiB 上限的估算
   在实测连接规模下富余，暂不加前端截断（sidecar 上限已是闸门），超限场景
   由宿主写穿告警兜底。
6. 验证：镜像助手单测 7 例（条目级存在性/垃圾收紧/坏整键自愈/读改写保留
   他连接/空 id 忽略/结构等值），全套 vitest 1676 例绿 + typecheck + build；
   PROTOCOL `local/preferences` 与 `ssh/settings` 行补消费模式注（RPC 行为
   零变化）。

### ✅ 批 3：传输/下载偏好迁 host.storage 镜像（14 键合并单镜像，全部落地）

`downloadDir` / `downloadUseDefaultDir` / `downloadConflictPolicy` /
`transfer_concurrency` / `transfer_duplicate_policy` / `transfer_max_active` /
`transfer_download_limit_kib` / `sftp_compat_mode` / `sftp_name_encoding` /
`transfer_compress_mode` / `transfer_compress_threshold_mib` /
`history_suggestions_enabled` / `history_suggestion_min_chars` /
`history_suggestion_max_chars`——sidecar 在任务启动时现读现用，取 mcp-settings
同款镜像模式，且 **14 键合并为单个镜像键** `ssh-preferences-mirror`（一次
播种/收敛/双写）：

1. **wire 键名同形**：镜像字段名与 `local/preferences/*` 完全一致——get 载荷
   直接提取为镜像、镜像直接作为 set 部分更新载荷，零键名转换；
   `localShell` 等设备本地字段不进镜像。
2. **消毒器下沉**：原 App.vue 内联的 5 个消毒器（conflict policy / compress
   阈值与策略 / 建议长度上下限）下沉 `lib/preferencesMirror.ts` 导出（可单测），
   App 统一导入——镜像消毒与状态消毒同一套函数，无第二实现。
3. **播种/收敛**：`hydratePrefsOnce` 在 sidecar get 之后——store 缺失播种；
   漂移（云同步恢复后）则 store 赢：14 个状态 ref 采纳镜像并 `syncPrefs()`
   推回。坏 JSON 自愈重播种（镜像语义）。web 直连的 localStorage 旧缓存保留
   为启动首拍种子，随后被 sidecar/镜像覆盖（原有语义不变）。
4. **保存双写**：`syncPrefs` RPC 成功后镜像同一份 14 键。
5. 验证：镜像单测 9 例（消毒器边界回归/部分载荷提取/round-trip/坏档自愈/
   收敛等值），全套 vitest 1685 例绿 + typecheck + build；PROTOCOL
   `local/preferences` 行消费模式注更新为批 2/3 并列。

### ⛔ 明确不迁（及理由）

- **历史/审计/指标/录制/传输 spool**（transfer-history 200 条、
  metrics-history 720 行、audit-log 5MiB 轮转、recordings、transfers/）：
  体量与性质都是"设备本地运行痕迹"，host.storage 是 UI-state store（宿主
  注释明示 bulk data 归 sidecar），且把审计/命令历史密文上云属于扩大敏感
  数据暴露面。保持本地。
- **known_hosts**：本地 TOFU 信任态，跨设备共享信任反而有安全语义问题
  （A 机确认的新指纹不应静默注入 B 机）。
- **Quick Sudo 档案 / OTP 库**：宿主 secrets 能力只有"按连接"的
  connection_secrets（字段级、经 lifecycle 注入），无插件级全局 secret
  存储 API；迁入 host.storage 会把密钥从"插件 vault 加密"降级为
  "ui-storage.json 本地明文"。维持自加密 + 不同步，直到宿主提供插件级
  secret 能力（可向宿主提需求）。

## 3. 验证策略（按仓规：单测 + smoke + 文档，三件齐）

每批交付物：

1. 单测：前端迁移种子逻辑（host 空 + legacy 非空 → 写入）、坏 JSON 容错、
   容量截断；sidecar 读穿解析（ui-storage 键缺失/损坏 → legacy 回落）。
2. smoke：`scripts/smoke_fs_test.py` 增补用例——写 host 键后 sidecar 消费点
   能读到（需 mock ui-storage.json 落在 `DBX_PLUGIN_DATA_DIR`）。
3. `docs/PROTOCOL.zh-CN.md` 同步：退役/降级的 RPC 标注；
   `docs/FEATURE_PARITY.zh-CN.md` 对标行更新。
4. 双冒烟验收对安装副本跑（`scripts/test.sh`）。

## 4. 遗留风险与开放问题

- **web 直连模式**（无 Tauri）：host.storage 落浏览器顶层 localStorage，
  sidecar 读不到 ui-storage.json——该模式天然没有加密同步，配置回落
  legacy 文件/浏览器本地，两处各自成立但互不相通（与今天 tunnel profiles
  的降级损失同构）。是否给 web 模式补 sidecar RPC 同步，单独立项。
- **云同步恢复的并发窗口**：宿主恢复快照会整体重写 ui-storage.json
  （`*.json.sync-tmp` + rename），sidecar 读穿无锁——读端是单文件整读+
  解析，rename 原子性保证读到的要么是旧要么是新整档，无半档风险。
- **同步密码未设置时**：ui-storage 不随同步走（宿主显式清空），需在
  插件设置 UI 或文档中说明"配置跟随同步需在 DBX 开启 secrets 同步并设
  同步密码"。
- **App.vue 未提交改动**：本工作区尚有 #138 线的未提交改动（App.vue 等），
  批 1/2 会触碰 App.vue 写入点——实施前先落当前工作区的变更，分批独立
  分支交付（仓规：one branch per agent）。
