# 实施计划：多终端连接导入迁入连接设置表单（插件入口归位 + 宿主批量建连扩展）

> 目标：把「第三方终端会话导入」（MobaXterm / Xshell / WindTerm / SecureCRT /
> FinalShell / Electerm / Termius / ~/.ssh/config）从插件工作台侧边栏迁到
> **DBX 宿主连接设置表单的菜单（`connection-provider.actions`）**，并回答「多终端
> （批量）导入要如何扩展」。现状在插件内实现之所以不合理：连接注册表归宿主所有，
> 插件私有连接库已被废弃（`imported-connections.json` 已移除），导入的终点却停在
> 「脱敏 JSON 手工导出」，用户仍要逐条手工建连——能力半成品。
>
> 状态标记：✅ 已完成 / 🔜 待实施 / ⛔ 明确不做（含理由）。
> 本文档是方案（未实施）；工作区尚有 #138 线未提交改动，按仓规「one branch per
> agent」，实施须在当前变更落地后另开分支分批交付。

## 0. 现状与问题

| 事项 | 现状 | 证据 |
| --- | --- | --- |
| 导入入口 | 插件工作台 SFTP 侧栏 tab（`SideNavPanel.vue` → `ImportWizard.vue`，`activeTab === 'import'`） | `frontend/src/components/SideNavPanel.vue:93` |
| 解析管线 | sidecar `import/preview/{start,finish,cancel}` 流式预览 + 脱敏规范化导出，8 种来源，单次 ≤1000 会话、64MiB 预算，凭据永不落盘/出 sidecar | `backend/src/connection_import.rs`；`docs/PROTOCOL.zh-CN.md` 导入节 |
| 导入终点 | **仅**脱敏预览表 + 规范化 JSON 下载；「不创建连接、没有 import/commit、不持久化」 | PROTOCOL 导入节明示 |
| 连接库归属 | 宿主连接注册表 + `connection_secrets` 密钥库；插件私有连接库已废弃 | 仓规「不重复宿主」；PROTOCOL「该插件不再创建或读取 imported-connections.json」 |
| 表单扩展位 | 宿主按 manifest `connection-provider` 渲染表单；`actions` 数组即表单按钮/菜单（现两个：`quick-sudo-profiles` 摘要、`import-private-key` 文件回填） | `manifest.json` contributions[0].actions |

问题一句话：导入能力 80% 在插件里（解析、预览、脱敏），但「变成连接」这最后
20% 缺位，且入口长在 SFTP 侧栏——连接管理的事长在了终端工具身上。

## 1. 宿主能力事实（manifest.schema + 本仓先例，2026-10 核对）

| 事实 | 证据 / 影响 |
| --- | --- |
| 表单动作契约：`{id, label, description, variant, when: create\|edit\|always, close_on_success, requires_valid_form, timeout_ms≤120000}` | manifest.schema `connectionAction`；点击由宿主调 sidecar `connection/action {action, id}` |
| 动作可返回 `fieldValues` 回填**当前表单**（宿主真机行为，`import-private-key` 在用） | `backend/src/main.rs:1855-1873` 返回 `{message, fieldValues:{private_key}}` → 宿主填表、保存时入 vault |
| 动作内可弹**系统文件选择框**（仅桌面；web/docker 降级指引） | `local_fs::pick_file()` + `local_downloads::can_save_local` 探测，main.rs:1856-1862 |
| **表单动作只能回填一个连接**——`fieldValues` 语义就是当前表单；schema 无批量建连能力，`capabilities` 仅 `test/connect/disconnect` | manifest.schema 全文核对（2026-10）；「多终端批量」必须宿主扩能力 |
| 贡献点全集：`connection-provider / workbench / filesystem-provider / context-menu(menu: connection\|table) / result-view / command / menus(location: commandPalette\|appToolbar\|appSidebar) / mcp` | manifest.schema `contributions.items.oneOf` |
| **manifest 未知字段 = 安装即炸**（插件中心 unknown field） | 技能文档故障表；→ 任何新贡献点/新字段都**硬依赖宿主 schema 先行**，插件不能抢跑 |
| 宿主桥（webview）无连接创建 API；sidecar RPC 面亦无 | `frontend/src/mockDbxHost.ts` 桥面只有 invoke/onEvent/sendBinary/saveFile 等 |
| 宿主/插件可并行开发：`DBX_HOST_WORKTREE` 划界，宿主仓独立 | 技能「可选的 DBX host 集成」节 |

结论：**「入口挪进表单菜单」今天就能做（单连接回填）；「多终端批量落库」必须宿主
配合**——没有第三条路（插件自建连接库已被正确地否决过一次）。

## 2. 分层扩展设计

### ✅ 阶段 1：表单动作「从会话文件导入」（现有宿主能力内，插件仓独立交付——已落地 2026-10-02）

新建表单动作 + `connection/action` 新分支，完全复刻 `import-private-key` 的成熟
形态（桌面选文件 → sidecar 解析 → `fieldValues` 回填）：

1. **manifest**：`connection-provider.actions` 追加
   `{id: "import-sessions", label: "Import from terminal session file", when: "create",
   requires_valid_form: false, timeout_ms: 120000, variant: "outline"}`（`when: create`
   ——只在新建连接表单出现，编辑既有连接无意义）；七语 localization 补 `actions` 文案。
2. **sidecar**：`connection/action` 新分支 `import-sessions`：
   - 桌面探测同 `import-private-key`（`can_save_local` 不过 → 报「桌面限定，去工作台用导入向导」）；
   - `local_fs::pick_file()` 选文件 → **扩展名嗅探来源**（`connection_import::sniff_kind`：
     六个无歧义扩展名 + `.json` 按顶层形态分流 hosts/bookmarks；无扩展名/未识别回落
     sshconfig，交给解析器判定），复用 `parse_uploaded` 全部 8 个解析器与容量上限；
     WindTerm 需主密码的会话无法在无 UI 动作里问密码，报 `WINDTERM_MASTER_PASSWORD_REQUIRED`
     并指引工作台向导；
   - 取**第一条**会话映射 manifest 字段（`session_field_values`）：`display_name / host /
     port / username / authentication / private_key_path`（仅路径，延续「不读密钥材料」红线；
     密码类认证**不回填密码字段**——密码留空，连接时由宿主问），
     `message` 汇报「文件共 N 条，已填第 1 条；批量导入见工作台向导」；
   - 取消选文件 → `{message:"", fieldValues:null}` 安静返回（同先例）；
   - 可选 `path` 参数跳过系统对话框，供冒烟/自测注入固定文件（宿主从不携带；载荷
     仍只有脱敏字段，与预览同边界）。
3. **局限（明示，不遮掩）**：这是「单连接回填」，不是多终端批量；表单模型就是一条
   连接，`fieldValues` 填不了第二行。价值在于入口归位 + 解析管线复用 + 零宿主依赖。
4. **交付物（已交付）**：Rust 单测 5 例（扩展名嗅探矩阵/JSON 分流/凭据只回路径/
   parse_uploaded 全管线首条映射/读盘嗅探）+ `smoke_fs_test.py`
   `connection/action import-sessions` 用例（path 注入过对话框；断言首条回填、
   凭据缺位、「1 of N」消息、无会话文件拒绝）+ `verify.mjs` 新场景（动作契约
   `when=create` / `requires_valid_form=false` / `timeout_ms=120000` /
   `close_on_success` 缺省 + 七语 label/description/OpenSSH 来源枚举）+
   PROTOCOL `connection/action` 行与会话导入节更新 + FEATURE_PARITY 导入行更新。
   验证：cargo test 全绿（含新 5 例）+ clippy `-D warnings` + fmt + verify.mjs
   603 组合 PASS + `validate_repo.py` PASS + smoke 对 debug sidecar
   PASS 91 / FAIL 4（4 例为压缩协商与 watcher 下载移动的**既有**失败，基线对照
   证实与本改动无关：去掉本改动后同 4 例挂、且 import-sessions 用例转 FAIL）。

### 🔜 阶段 1.5：连接列表级入口（现有能力内，可与阶段 1 并行）

批量导入的完整 UI（向导三步流）已经存在且成熟，缺的只是入口位置与落库终点：

- manifest 增 `context-menu` 贡献 `{menu: "table", label: "导入终端会话…", action:
  {type: "open-workbench", workbench: "io.dbx.ssh.workbench", context: {plugin: {mode: "import"}}}}`
  ——在宿主**连接列表**右键即可打开工作台导入 tab（向导按 context 聚焦 import 步骤）；
  另可挂 `menus location: "appSidebar"` 同款入口。工作台 ImportWizard 增加
  「监听 context.mode=import 自动切到导入 tab」的小接线。
- 交付物同阶段 1 口径（manifest 场景进 verify.mjs、i18n 七语、UI walkthrough
  `smoke_ui_settings.mjs` 增入口断言）。

### 🔜 阶段 2：多终端批量落库（需宿主新能力，向宿主提需求；两案供选）

> 无论哪案，落库主体都是**宿主**：连接注册表、分组、`connection_secrets` 密钥库
> 全在宿主侧，插件只产出规范化载荷。

**方案 B（推荐）：宿主桥新增批量建连 API**——`window.dbxPlugin.connections.create(batch)`
（或 Tauri command `plugin_connections_create`），载荷即现有向导的规范化 schema：

```
{ sourceKind, sessions: [{ name, protocol, host, port, username, groupPath,
  auth: { kind, secretRef | keyPath | agent }, … }] }
```

- 插件侧改动集中在 ImportWizard：第 3 步从「下载脱敏 JSON」升级为「勾选 + 提交宿主」，
  预览→确认两段式不变；sidecar 解析管线零改动（预览仍走 `import/preview/*`）；
  **密钥经宿主 secret 绑定进 `connection_secrets`**（载荷用 `secretRef` 占位，
  明文走桥接加密通道、不落 sidecar 盘——延续既有红线）；
- `groupPath` 映射宿主连接分组；去重按 host+port+user（FEATURE_PARITY 已有
  slug 规则注记，两侧规则不得漂移）；宿主返回逐条结果（created/skipped-duplicate/failed+原因）；
- **optional 降级**：桥上无该方法（旧宿主/web 模式）→ 按钮隐藏，回落脱敏导出
  （现有行为即降级路径，功能可降不可死）。

**方案 A（备选）：扩展 `connection/action` 返回契约**——允许 `{createConnections: [...]}`
批量载荷，宿主在动作回调里建连。改动更小（无新桥），但：manifest 需要 schema 先行
（unknown field 安装即炸 → 必须宿主升版本 + 插件 `engines.dbx` 抬底），且动作无 UI、
无法做「勾选哪几条」的确认步，1000 条全量落库体验差。

**推进方式**：以本节为需求稿向宿主仓提 issue/PR（`DBX_HOST_WORKTREE` 并行划界，
本仓只交插件代码与文档）；宿主能力落地前阶段 1/1.5 已可用，不互相阻塞。

### ⛔ 明确不做

- **插件私有连接库复活**（`imported-connections.json` 类方案）：与宿主注册表双写
  漂移、密钥脱离宿主 secret 体系，2026 年已否决过一次，不再回头。
- **sidecar 直写宿主连接文件**：跨过宿主写入其数据目录属越权，破坏宿主事务与
  cloud_sync 一致性。
- **表单动作里做批量**：见阶段 2 方案 A 的局限，`fieldValues` 语义就不该被撑爆。

## 3. 分批交付与验证（按仓规：单测 + smoke + 文档，三件齐）

| 批次 | 内容 | 宿主依赖 |
| --- | --- | --- |
| 批 1 | ✅ 已落地——阶段 1 表单动作（manifest + Rust 分支 + 七语 + verify 场景 + 单测 + smoke + PROTOCOL/FEATURE_PARITY） | 无 |
| 批 2 | 阶段 1.5 列表级入口（context-menu/menus + 向导 context 聚焦 + UI walkthrough） | 无 |
| 批 3 | 阶段 2 方案 B 接入（宿主 API 落地后：向导提交/降级开关/去重报告/逐条结果 UI + 桥 mock + 七语） | **有** |

每批通用验证：`scripts/test.sh`（cargo test → 前端三件套 → 打包 → 双冒烟）；涉表单
的批次跑 `node scripts/connection-forms/verify.mjs`；文案漏语靠七语断言 + review。

## 4. 开放问题

1. **宿主是否已有自有批量导入**（DB 连接 CSV/JSON 之类）：若有，阶段 2 载荷应优先
   对齐宿主自有格式（不重复宿主原则），需求稿先查证再提。
2. **web/docker 模式**：无系统文件选择框，表单动作天然桌面限定（先例已定）；工作台
   向导用浏览器 File API 不受影响——两入口的降级文案要分开写。
3. **WindTerm 主密码**：无 UI 动作问不了密码，永远指回工作台向导；阶段 2 向导内
   已支持，无需额外设计。
4. **密钥经桥的传输形态**：方案 B 的 `secretRef` 明文段走桥接加密通道的具体机制
   （Tauri command 参数加密？宿主侧一次性缓冲？）需与宿主共同定义，红线是
   sidecar 不落盘、宿主只进 `connection_secrets`。
5. **`context-menu menu:"table"` 的宿主真机渲染范围**未实测（schema 允许 ≠ 渲染
   符合预期），批 2 实施前先在宿主真机验证一次。
