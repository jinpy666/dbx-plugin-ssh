# FIG 补全引擎总体规划（最终架构直达版）

> 2026-09-28 指令：**放弃历史包袱，按最终目标实施**。本文取代原 wave-1 过渡路线；
> 方案全文 `docs/FIG_AUTOCOMPLETE_INTEGRATION_PLAN.zh-CN.md`（§ 引用指该文档）。
> 基线：`codex/ssh/fig-wave1-base`。

## 0. 方案定性（一句话）

**集成 amazon-q-developer-cli 的 autocomplete parser（Fig 补全方案的开源引擎，MIT OR Apache-2.0）+ withfig/autocomplete 全量语料，配对成本插件的结构化补全引擎；Fig 的宿主形态（UI / figterm / 专有运行时）由本插件的 xterm overlay + Rust sidecar + `completion/execute` 替代。**

spec 数据与 parser 引擎是配对资产，二者都要、不改其语义；被抛弃的只有 Fig 的宿主形态和本插件自己的过渡层。

## 1. 取消项（历史包袱，不再做）

| 取消 | 原因 |
|---|---|
| LegacyCompletionProvider 包装 + golden parity 零回归层 | 过渡脚手架；最终架构以 fig 引擎为唯一结构化补全来源 |
| `lib/completions/**`（spec.ts、12 手写 specs、provider、remoteFsProvider、figImport） | §6.1：不转人工维护的 SpecCommand；无 fig spec 的命令按 §34 pass-through |
| `scripts/import-fig-specs.mjs` | 同上 |
| flag 默认 legacy 的过渡语义 | 默认即 `fig-safe` |
| 手写 normalize + 纯数据 snapshot 断言 | spec 模块允许含函数（generator 声明/自定义代码），运行受安全策略与 host facade 约束（§15/§16） |

## 2. 批次

### 批次 1（当前并发）

| Lane | 分支 | 交付 | 细则 |
|---|---|---|---|
| A' 前端引擎/退役 | `codex/ssh/fig-wave1-frontend-core` | fig 引擎接线（经 source 接缝）、键盘/编辑内核、CompletionMenu→CompletionItem、设置三态七语、legacy `lib/completions/**` 退役 | `FIG_WAVE1_LANE_A_FRONTEND_CORE.zh-CN.md`（最终架构版） |
| B Rust Host | `codex/ssh/fig-wave1-completion-host` | `completion/execute`（local+ssh）——**与本次调整正交，已在途，按原文继续** | `FIG_WAVE1_LANE_B_COMPLETION_HOST.zh-CN.md` |
| C' parser/语料 | `codex/ssh/fig-wave1-fig-specs` | vendor amazon-q parser 快照 + 全量语料管线 + `FigCompletionSource` 实现 | `FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md`（最终架构版） |

出口：三 lane 全绿 + 集成全仓门禁 + `FIG_VERIFICATION.zh-CN.md` §4 清单。

### 批次 2（批次 1 集成后）

1. 声明式 generator E2E：generator 位置经 HostClient → `completion/execute` 打目标机 + postProcess（§18）；scheduler 两段渲染（§31）、TTL 缓存（§29）、取消（§30）。
2. inline-worker runner：`?worker&inline` + WebView feature-detect + 崩溃重启（§44）；宿主不支持则主线程定版（source 接缝已保证可迁移）。
3. 体积定版：全量 corpus vs Top-N 裁剪（依据 C' 体积报告与 verify 预算，决策 D2'）。

### 批次 3

custom JS generator host facade（§15 L3）、WSL executor（§14）、`completion/environment`、任意光标位置（§23）。

## 3. 决策记录（D1/D3/D4/D5 继续有效，以下为修订与新增）

| # | 决策 |
|---|---|
| D2' | 单文件构建约束保持；spec 全量 bundled（manifest 静态 import）；体积由 verify 预算门禁管理，超限裁 allowlist 而非引入 chunk |
| D6' | 设置键 `ssh-completion-engine`：`fig-safe`（默认）/ `fig` / `off`；`ssh-completion-spec` 键退役 |
| D7 | 引擎访问只经 `fig/source.ts` 冻结接缝；worker 化延后不阻塞批次 1 |
| D8 | 语义权威 = vendored amazon-q parser；generator 一律经 `completion/execute` 在目标机执行，前端不直连 shell |
| D9 | `lib/completions/**` 由 Lane A' 删除；`splitCommandLine` 上移为冻结 `core/tokenize.ts` 供 fig source 复用 |

## 4. 风险登记（更新）

| 风险 | 缓解 |
|---|---|
| amazon-q parser 包路径/API 与预期不符 | C' 以快照实际为准，facade 隔离，偏差如实写报告 |
| 全量 corpus bundle 体积 | C' verify 预算门禁 + 裁剪序报告；按 D2' 裁 allowlist |
| parser 的 Node API 依赖（fs/process…） | 编译期剥离 + facade 抛 unsupported → 降级（§43），引擎不可因之崩溃 |
| sandbox 无外网导致 sync 不可执行 | sync 是唯一联网点；失败即 blocker 上报，脚本与测试仍须交付（fixture 验证） |
| B 与 A'/C' 集成时序 | B 的 RPC 批次 1 无前端调用方，generator E2E 在批次 2 接线 |

## 5. 治理（不变）

agent 不 push / 不 merge / 不安装；B 属命令执行面变更，PR 需人工 review；冻结文件变更由协调者统一裁决后同步全 lane。
