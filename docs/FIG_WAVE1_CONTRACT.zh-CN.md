# FIG 补全引擎实施契约（最终架构版）

> 基线 `codex/ssh/fig-wave1-base`；方案全文 `docs/FIG_AUTOCOMPLETE_INTEGRATION_PLAN.zh-CN.md`。
> 本版按「放弃历史包袱、直达最终架构」指令修订：**集成 amazon-q-developer-cli 的
> autocomplete parser（Fig 开源引擎）+ withfig/autocomplete 全量语料，legacy
> `lib/completions/` 退役**。lane 细则：LANE_A（最终架构版）/ LANE_B（不变）/
> LANE_C（最终架构版）；验证：FIG_VERIFICATION。

## 1. 冻结文件（只 import 不改；变更须协调者裁决）

- `frontend/src/lib/completion/core/types.ts`（CompletionItem/Edit/BufferState/Response…）
- `frontend/src/lib/completion/core/tokenize.ts`（splitCommandLine，自 legacy spec.ts 上移）
- `frontend/src/lib/completion/host/protocol.ts`（completion/execute 线协议）
- `frontend/src/lib/completion/fig/source.ts`（FigCompletionSource 接缝：A 面向它编码，C 实现它）

## 2. 总线决策

1. **revision 纪律**：异步结果须 `revision` + `sessionId`（+requestId）匹配，否则静默丢弃（§5.1/§30/§43）。
2. **键盘所有权**（§21，`keyboard.ts` 纯函数 + 表驱动单测固化）：

   | 菜单状态 | Enter | Tab | ↑↓ | Esc |
   |---|---|---|---|---|
   | 静态候选 | 放行 shell | accept | 移动 | 关闭 |
   | 动态/generator 位置或 loading | 放行 shell | 放行 shell | 移动 | 关闭 |
   | 关闭 | shell | shell | shell | — |

   菜单显示 ≠ 键盘所有权；补全任何一层失败不得影响 PTY 输入链路。
3. **设置**：`ssh-completion-engine` ∈ {`fig-safe`(默认), `fig`, `off`}；`ssh-completion-spec` 退役；新文案七语（zh-CN/zh-TW/en/es/it/ja/pt）。
4. **accept 范围**：仅行尾补全（`cursor === text.length`）；任意光标批次 3（§22/§23）。
5. **RPC 命名**：`completion/execute`；camelCase；错误为字符串 Err、`completion:` 前缀。
6. **语义权威** = vendored amazon-q parser（别名/persistent/variadic/嵌套/`--` 不自研）；generator 一律经 `completion/execute` 目标机执行（批次 2 接线），前端不直连 shell。
7. **legacy 退役**：`lib/completions/**` 删除；无 spec 命中 → pass-through（§34），不造假候选。

## 3. completion/execute 契约（与 host/protocol.ts 一致）

- target `{kind:"local"|"ssh", sessionId}`；`timeoutMs` clamp [200,3000] 默认 1200；`maxOutputBytes` 默认 256KiB；`mode:"completion-generator"`。
- sudo 恒 false；只读连接拒绝；超时 completion 层竞速 + `cancel_exec` 回收；**不修改** `SshRuntime::exec` 的 `clamp(5,300)`。
- local 用短生命周期子进程（tokio），禁止注入交互 PTY；审计对齐 `ssh/exec`。
- 批次 1 不做 `completion/listDirectory` / `completion/environment` / WSL。

## 4. 文件归属（越界即冲突）

| Lane | 拥有（新增/修改/删除） |
|---|---|
| A' | `lib/completion/core/{edit,ranking}.ts`、`lib/completion/keyboard.ts`、`CompletionController.ts`；`App.vue`；`components/CompletionMenu.vue(+spec)`；`lib/i18n.ts`；`components/SettingsDialog.vue`；`lib/pluginStore.ts`（键位 swap）与 `pluginStorage.spec.ts` 相应更新；**`lib/completions/**` 删除**；对应 `*.spec.ts` |
| B | `backend/src/completion/*`；`backend/src/main.rs`（路由+audit 接线）；`backend/src/ssh.rs`（仅预批最小只读查询 fn，报告列明）；`docs/PROTOCOL.zh-CN.md`；`scripts/smoke_completion.py` |
| C' | `lib/completion/fig/**`（`source.ts` 除外）；`frontend/vendor/**`；`scripts/sync_fig_specs.mjs`、`scripts/verify_fig_specs.mjs`、`scripts/import-fig-specs.mjs` 删除；`frontend/package.json`（scripts + devDeps 论证制）；`tsconfig.json`（如需）；`docs/fig-specs-size-report.md` |

## 5. 门禁

- A'：`pnpm --dir frontend install --prefer-offline` → typecheck → test → build；
  `grep -rn "lib/completions" frontend/src` 与 `grep -rn "ssh-completion-spec" frontend/src` 均无结果。
- C'：前端三件套 + `pnpm --dir frontend fig:verify` + `fig:sync` 幂等自查。
- B：`cargo fmt --check` / `clippy --locked --all-targets -- -D warnings` / `test --locked`；docker 可用时 `smoke_completion.py`。
- 全 lane：`git diff --stat codex/ssh/fig-wave1-base` 只落 §4 归属文件；零新增运行时依赖（C' build-time devDeps 论证制）；测试零联网；不 push / 不 merge / 不安装。

## 6. 提交与移交

zh conventional commits（`feat(completion): …`）；lane 报告含 base SHA、commit 列表、变更文件、验证摘要、与细则偏差、风险、follow-up。
