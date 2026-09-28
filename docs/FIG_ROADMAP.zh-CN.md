# FIG 补全引擎总体规划（Roadmap）

> 基线：`codex/ssh/fig-wave1-base`（main `0da8be89` + wave-1 契约 `19579413` + 本组文档）。
> 上游方案：`docs/FIG_AUTOCOMPLETE_INTEGRATION_PLAN.zh-CN.md`（§ 编号引用均指该文档）。
> 本文档是波次间的唯一规划入口；单波次细则见各 lane 文档。

## 0. 总原则（继承自方案，不重复论证）

- Desktop OS 与 Completion Target OS 解耦：generator 只在目标机执行（§1）。
- 不搬 Fig UI、不在 Rust 重写 parser、不把 generator 跑在桌面机（§49）。
- 编辑操作由 parser/resolver 产生，UI 只执行（§5.2）。
- 补全任何一层失败不得影响 PTY 输入链路（§43）。

## 1. 波次划分

### Wave 0（已完成）

- fig-base worktree/分支建立；基线验证绿（typecheck / 128 文件 1284 用例 / build）。
- 冻结契约类型：`frontend/src/lib/completion/core/types.ts`、`host/protocol.ts`。
- 契约：`docs/FIG_WAVE1_CONTRACT.zh-CN.md`。

### Wave 1（当前波次，三 lane 并发）

| Lane | 分支 | 交付 | 细则 |
|---|---|---|---|
| A 前端核心 | `codex/ssh/fig-wave1-frontend-core` | CompletionItem/Edit 内核、键盘所有权纯函数、CompletionController、legacy adapter 零回归接线、feature flag + 设置项（七语） | `FIG_WAVE1_LANE_A_FRONTEND_CORE.zh-CN.md` |
| B Rust Host | `codex/ssh/fig-wave1-completion-host` | `completion/execute` RPC（local + ssh target）、安全策略、PROTOCOL 文档、smoke 脚本 | `FIG_WAVE1_LANE_B_COMPLETION_HOST.zh-CN.md` |
| C Fig 管线 | `codex/ssh/fig-wave1-fig-specs` | fig 运行时类型、静态 adapter、sync/verify 脚本、11 命令 spec snapshot、体积实测报告 | `FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md` |

三 lane 文件归属互斥（契约 §6），合并顺序任意；集成阶段见 `FIG_VERIFICATION.zh-CN.md`。

**Wave 1 出口判定**：三 lane 全绿合入集成分支 + 全仓门禁通过 + 验收清单（验证文档 §4）勾完。

### Wave 2（依赖 wave 1 全部合入）

1. **fig provider 接线**：C 的 adapter 包装成 `FigCompletionProvider` 进 controller
   provider 链（fig > legacy，§35）；feature flag `ssh-completion-engine` 默认值
   评估切 `fig-safe`。
2. **声明式 generator 端到端**：`git checkout <Tab>` / `kubectl get pods` 经
   B 的 `completion/execute` 打到目标机；stale-guard（revision）+ TTL 缓存
   （§29）+ 取消（§30）+ scheduler 两段渲染（§31：静态先行、动态合并）。
3. **`completion/listDirectory` RPC** + 文件 provider（local fs / SFTP readdir，
   §17）。
4. **Worker spike（决策门）**：DBX WebView（WKWebView/WebView2）里
   `new Worker(blob/data-url)` 可用性验证；可用则把 engine 迁 Worker
   （接口已留 requestId/revision），不可用则永久主线程并记录决策。
5. **spec 集合扩张**：按 C 的体积报告决定默认集是否扩到全量。

### Wave 3

- WSL executor（`wsl.exe -d <distro>`，路径映射，§14）。
- custom JS generator compatibility shim（§15 Level 3，host facade）。
- 全量 spec corpus + legacy specs 退役（§35/§52 Step 13-14）。
- 任意光标位置补全（§23，行尾→行内）。
- `completion/environment` RPC（target os/shell/cwd 元信息）。

## 2. 关键决策记录（已定，不再重议）

| # | 决策 | 依据 |
|---|---|---|
| D1 | wave 1 引擎跑主线程，不做 Worker 化 | `frontend/build.mjs` 单文件内联 + 断言唯一 script 标签；parser 为纯同步计算，当前量级无性能需求 |
| D2 | spec 全量静态进 bundle，不做按命令懒加载 chunk | 同上构建约束；体积取舍由 Lane C 实测报告在 wave 2 裁决 |
| D3 | completion 超时（默认 1.2s）在 completion 层竞速实现，不改 `SshRuntime::exec` 的 `clamp(5,300)` 下限；超时走既有 `cancel_exec` 回收 | 避免动共享 exec 语义；契约 §5 |
| D4 | read-only 连接对 `completion/execute` 一律拒绝（含 local 语义对齐：SSH target 才有 read-only 概念） | generator=命令执行，不能绕过只读承诺 |
| D5 | 联网只发生在显式 `pnpm fig:sync`；测试一律离线 fixture | SKILL 红线 + CI 可重复 |
| D6 | wave 1 flag 默认 `legacy`（行为与 HEAD 完全一致）；`fig-safe` 值可设但等 wave 2 接线后才生效 | 零回归承诺 |

## 3. 风险登记

| 风险 | 缓解 |
|---|---|
| bundle 体积超预期（kubectl/aws 巨型 spec） | C 产出实测报告 + verify 脚本设预算阈值；wave 2 可缩 allowlist |
| DBX WebView 不支持 Worker | wave 2 spike 前不依赖；主线程架构已是兜底形态 |
| completion/execute 被视为命令执行面变更 | agent-flow 规定 human review；B 的 PR 必须人工审后才能合（agent 不自合） |
| 远端 1.2s 超时在高 RTT 链路误杀 | 超时可配（clamp 上限 3s）；wave 2 generator 结果有 TTL 缓存，重复触发少 |
| App.vue 接线回归（13789 行单文件） | A 的 golden parity 测试固化 HEAD 行为；键盘语义表驱动单测；UI mock 走查沿用 |

## 4. 治理

- agent 不 push / 不 merge / 不安装；集成与发版归 integrator/用户。
- B 属命令执行面变更，PR 需人工 review（`.github/agent-flow.yml` security 段）。
- 冻结类型变更只能由协调者统一裁决后同步全 lane。
