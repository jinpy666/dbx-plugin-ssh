# PR-A4 多 Agent 并发实施计划（SSH 插件侧）

> 依据：`HOST_PLUGIN_UI_SPEC.zh-CN.md` §8.1 三项迁移任务 + §4/§5 契约，
> `HOST_PLUGIN_UI_PR_REVIEW_GUIDE.zh-CN.md` §6 PR-A4 切片与 §7 检查表。
> 本计划只覆盖**本仓库可执行**的插件侧工作；宿主侧 PR-A1/A2/A3/P2 属宿主仓
> （`btroot/dbx`）工作流，本文仅登记接口契约与并行关系，本仓 agent 不触碰宿主仓
> （工作区规则：本仓只提交插件代码与文档；安装/合并不自动化）。

## 0. 现状锚点（已核实）

| 迁移任务 | 当前代码 | 目标契约 |
| --- | --- | --- |
| context 形状 | 发送/读取 `{ localTerminal: true }`（`App.vue:2854`、`App.vue:7560`、`mockDbxHost.ts:43`） | `{ plugin: { mode: "local-terminal" } }`（规范 §4.1：插件载荷只进 `context.plugin`） |
| workbenchId 权威性 | 自开桥显式传 `workbenchId: crypto.randomUUID()`（`App.vue:2854`） | 插件不再传；宿主注入。读取侧保留 fallback（`App.vue:1039-1040`，旧宿主无注入时兜底会话隔离） |
| restored 语义 | 直通分支无条件 `startLocalTerminal()`（`App.vue:7560-7564` 附近），`restored` 只在 SSH 路径处理（`:7568`） | `restored === true` 时**不得**自动建 shell：进入本地退出态外壳（复用既有 exit overlay + 重开按钮），等待用户显式启动（规范 §8.1/§8.4） |

manifest 现状：`engines.dbx >= 0.6.16`、`host_api >= 1.0.0`（`manifest.json:12-15`）；
无 command/menus 贡献。**宿主 A1 未发布前，manifest 里出现新贡献类型会被现行
宿主拒装**（严格解析）——这是 W2 轨道合并门控的根因。

## 1. 并行结构（总览）

```
        base = codex/ssh/local-terminal HEAD
          │
   ┌──────┼──────────────┬─────────────────┐
   W1（并行）           W2（并行，分支态）    W3（并行）
   webview 契约迁移      manifest 贡献声明     验收装备与文档
   App.vue+mock          manifest.json+资产   scripts+检查表
   │                     │【合并门控：宿主A1】  │
   └──────┴──── integrator 按 W1→W3→(W2) 顺序合并 ──┘
                       │
                  V（串行，收尾）
                  集成验证 agent：全量门禁+浏览器走查+冒烟
```

- **W1 / W2 / W3 文件集两两不相交**（见 §2 所有权表），可三 agent 同时开工，
  每人一个独立 worktree（工作区规则：one branch/worktree per agent）。
- **V 必须串行收尾**（验证依赖三者结果）。
- 宿主侧 PR-A1（manifest/runtime 模型）→ PR-A2（command registry）→ PR-A3
  （menus 表面）按评审指南 §6 顺序在宿主仓推进，与本仓 W1/W3 无依赖冲突；
  W2 的**合并**以宿主 A1 发布为前置。

## 2. Agent 轨道定义

### W1 — webview 契约迁移（`codex/ssh/a4-webview-contract`）

| 项 | 内容 |
| --- | --- |
| worktree | `../dbx-plugin-ssh-a4-w1` |
| 文件所有权 | `frontend/src/App.vue`、`frontend/src/mockDbxHost.ts`、`frontend/src/mockDbxHost.spec.ts`、`frontend/src/env.d.ts`（如需 context 类型）、`ui/`（build 再生成） |
| 禁区 | manifest.json、backend/、scripts/、docs/ |

任务：

1. **context 读写双侧切换**（硬切换，两端同仓同步改）：
   - 发送（`App.vue:2854` 自开桥）：`{ plugin: { mode: "local-terminal" } }`，**删除 `workbenchId` 字段**（宿主权威；旧宿主注入缺失时由 `:1040` fallback 兜底，行为不变）；
   - 读取（`:7560` 直通分支）：新增类型安全的 `readPluginMode(hostContext)` 助手（`context.plugin.mode === "local-terminal"`），替换裸 `localTerminal === true` 判断；
   - mock 夹具（`mockDbxHost.ts:43`）：`?local=1` → `{ plugin: { mode: "local-terminal" } }`；同时模拟宿主权威性——mock 侧在 `openWorkbench` 入口丢弃插件传入的 `workbenchId/restored/surface` 并注入自己的（镜像规范 §11 所有权，为后续宿主行为提供先行测试面）。
2. **restored 语义**（`:7560` 分支内）：
   - `restored === true` → 不调 `startLocalTerminal()`：置 `localState = "exited"`、`localSession = null`，复用既有退出覆盖层（"已退出 + 重新打开/关闭"）作为外壳态，等待用户显式启动；
   - 新 mock 夹具 `?local=1&restored=1` 驱动该路径；
   - SSH 路径的 restored 处理（`:7568`）不动。
3. **mock spec 用例**（`mockDbxHost.spec.ts`）：新 context 形状往返、openWorkbench 身份权威（插件传的保留字段被覆盖）、`?local=1&restored=1` 不自动起 shell。

验收命令：`pnpm --dir frontend typecheck && pnpm --dir frontend test && pnpm --dir frontend build`；
浏览器走查：`?local=1`（直通仍工作）、`?local=1&restored=1`(退出外壳、点重开能起 shell)、自开按钮桥参数（新形状、无 workbenchId）。

### W2 — manifest 贡献声明（`codex/ssh/a4-manifest`，**合并门控**）

| 项 | 内容 |
| --- | --- |
| worktree | `../dbx-plugin-ssh-a4-w2` |
| 文件所有权 | `manifest.json`、`assets/`（新图标）、`docs/HOST_PLUGIN_UI_SPEC.zh-CN.md` §8.1 状态更新（仅勾选其负责项） |
| 禁区 | frontend/、backend/、scripts/ |

任务：

1. 按评审指南 §4 形状在 manifest 声明：
   - `command` `open-local-terminal`（action: open-workbench / presentation: tab / reuse: singleton / instance_key: local-terminal / restore: none / `context.plugin.mode`）；
   - `menus` 三摆放：commandPalette（无 default_visible）+ appToolbar（`default_visible: false`，group navigation）+ appSidebar（`default_visible: true`，group primary）；
   - 国际化走 manifest 顶层 `localizations.<locale>.contributions.<id>` 七语（**不新增 label_i18n 平行机制**）；
   - 图标 `assets/local-terminal.svg`（新增资产，受控 URL 渲染）。
2. `engines` 抬升留 **TODO 标注**（具体 host_api 版本号由 integrator 在宿主 A1 发布时定，agent 不擅定）。
3. 自查并记录：现行 `dbx-plugin package` 对新贡献类型的行为（若 CLI 侧 schema 拒绝 → 记录为预期门控信号，不绕过）。

⚠️ **门控**：本分支完成後**不得合并**进集成分支，直到宿主 A1 发布且 integrator 确认 engines 抬升值（现行宿主严格解析会拒装含新类型的包）。分支存在本身即交付物（宿主 A1 发布后当天可合）。

验收命令：`python3 scripts/validate_repo.py`（身份/路径校验不涉及新类型）+ `node scripts/connection-forms/verify.mjs`（回归）。

### W3 — 验收装备与文档（`codex/ssh/a4-verify-kit`）

| 项 | 内容 |
| --- | --- |
| worktree | `../dbx-plugin-ssh-a4-w3` |
| 文件所有权 | `scripts/`（walkthrough 脚本增补）、`docs/HOST_PLUGIN_UI_SPEC.zh-CN.md` §10 验收清单标注（A4 相关项）、`docs/FEATURE_PARITY.zh-CN.md`（条目更新） |
| 禁区 | frontend/、backend/、manifest.json |

任务：

1. mock UI walkthrough（`scripts/smoke_ui_mock.mjs` 或新增变体）补两条锚点断言：
   `?local=1` 直通进入本地终端；`?local=1&restored=1` 不自动产生 `local/terminal/start` 调用（在 mock 层打桩断言零调用）且退出外壳可见。
2. 把评审指南 §7 中 A4 可本地验证的检查项映射成清单一节（context.plugin 归位、恢复不重放、关闭无 PTY 遗留），逐项标注验证方式（本地可验 / 需真实宿主）。
3. 文档状态同步（§8.1 三项任务 → 待 W1/V 完成后勾选；W3 只预建结构不代勾）。

验收命令：`node scripts/smoke_ui_mock.mjs`（或新增脚本）自跑通过；test.sh `--skip-host` 不因新增脚本变红。

### V — 集成验证（`codex/ssh/a4-integration-check`，串行收尾）

前置：W1、W3 已合并（W2 仍分支态）。

1. 全量门禁：`scripts/test.sh --skip-host`（后端 557 + 前端 + 打包 + 双冒烟 + UI walkthrough）。
2. 浏览器走查合同矩阵：新 context 形状直通 / restored 外壳 / 自开桥参数 / SSH tab 回归（`?slow` 确认弹窗等既有用例不回归）。
3. 对照评审指南 §8"必须请求修改的情形"自查（A4 视角）：恢复未重放、插件不传身份字段、无 PTY 遗留。
4. 产出验证报告（PR 描述素材：base SHA、变更文件、测试、风险、后续）。

## 3. 集成顺序与 integrator 职责

| 步骤 | 动作 | 说明 |
| --- | --- | --- |
| 1 | 按 **W1 → W3** 顺序合并（冲突预期为零：文件不相交） | W1 若与近期 App.vue 演进冲突，以 W1 rebase 解决 |
| 2 | V 起动收尾验证 | 失败项回派对应轨道 |
| 3 | W2 保持分支态 | 宿主 A1 发布 + integrator 定 engines 版本后当天合并 |

每轨道交付物统一含：分支名、base SHA、变更文件清单、验证输出、风险与后续。

## 4. 与宿主侧工作的并行关系（不在本仓执行）

| 宿主 PR | 依赖 | 与本仓关系 |
| --- | --- | --- |
| PR-A1 manifest/runtime 模型 | — | W2 分支的合并前置；契约以规范 §4-§6 为准 |
| PR-A2 command registry | A1 | 无直接依赖；A2 落地后插件中心经 command 打开的链路才可用 |
| PR-A3 menus 表面 | A1 | appSidebar/appToolbar 入口渲染；W2 声明对其生效 |
| PR-P2 BottomDock | A1-A3 | 后续（presentation: panel）；插件侧仅需读 `context.surface`（W1 的助手已预留扩展位） |

## 5. 风险与红线

- **R-门控**：W2 误合并会让现行宿主全体拒装——integrator 合并清单必须显式排除 W2，直至宿主 A1 发布。
- **R-旧宿主兼容**：W1 删除自开桥的 `workbenchId` 传参后，旧宿主（不注入 workbenchId）依赖 `:1040` fallback——W1 必须保留 fallback 并加用例。
- **R-竞态**：三轨道并行期若有他人改 App.vue，W1 rebase 优先；mock 文件仅 W1 可碰。
- **R-范围蔓延**：任何轨道不得顺手实现宿主侧行为（命令面板、toolbar 渲染）——mock 只做契约模拟，不做宿主替身。
- 通用红线沿用工作区规则：不动宿主仓、不自动安装/重启 DBX、不自动合并 PR、密钥不入库。
