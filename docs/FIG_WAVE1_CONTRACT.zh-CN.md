# FIG 补全引擎 Wave 1 实施契约

> 协调者：主会话。基线分支：`codex/ssh/fig-wave1-base`（= main `0da8be89`，已含
> fix-120 #120 系列）。方案全文：`docs/FIG_AUTOCOMPLETE_INTEGRATION_PLAN.zh-CN.md`。
> 三个实施 lane 在各自 worktree/分支并发实施；分支合入由 integrator/用户决定，
> agent 不得自行 merge / push / 安装插件。

## 1. Wave 1 范围

| Lane | 分支 | 范围（对应方案里程碑） |
|---|---|---|
| A 前端核心 | `codex/ssh/fig-wave1-frontend-core` | M1 + M2-lite：core 纯函数（edit/ranking）、Legacy adapter、CompletionController、键盘所有权模块 + 单测、App.vue 接线、feature flag |
| B Rust Host | `codex/ssh/fig-wave1-completion-host` | M4-lite：`backend/src/completion/*`，仅 `completion/execute`（local + ssh target），PROTOCOL 文档，smoke 脚本 |
| C Fig 管线 | `codex/ssh/fig-wave1-fig-specs` | M3 地基：fig/types + adapter（静态子集）、sync/verify 脚本、体积实测报告、vendor LICENSE/NOTICE |

## 2. 非目标（wave 2+，本波次禁止实施）

- **Worker 化**：构建管线 `frontend/build.mjs` 用 `inlineDynamicImports: true` 产出
  单文件自包含 index.html（并断言恰好 1 个 script 标签）。引擎 wave 1 跑主线程；
  接口保留 requestId/revision 字段为将来迁移留位。
- **按命令懒加载 chunk**：同一构建约束下不可行；spec 全量进 bundle，体积是否
  可接受由 Lane C 的实测报告定夺（wave 2 决策输入）。
- WSL executor；declarative generator 与 UI 打通（等 B 合入后 wave 2 做
  `git checkout <Tab>` E2E）；文件 provider 升级（沿用 fix-120 已有的
  `remoteFsProvider` 缓存版思路）；custom JS generator / loadSpec。

## 3. 冻结契约

`frontend/src/lib/completion/core/types.ts` 与 `frontend/src/lib/completion/host/protocol.ts`
是本波次的冻结类型。实现方**只 import，不修改**；确需变更 → 写进 lane 报告，
由协调者统一裁决后再同步给所有 lane。

## 4. 总线决策

1. **revision 纪律**：一切异步结果（provider/generator）回来时必须校验
   `revision` 与 `sessionId` 都匹配当前 buffer，否则静默丢弃（方案 §5.1/§30/§43）。
2. **键盘所有权**（方案 §21，必须以纯函数 + 单测固化，放
   `frontend/src/lib/completion/keyboard.ts`）：

   | 状态 | Enter | Tab | ↑↓ | Esc |
   |---|---|---|---|---|
   | 菜单开 + 静态候选 | 放行 shell | accept | 移动 | 关闭 |
   | 菜单开 + 动态 hint / loading | 放行 shell | 放行 shell | 移动 | 关闭 |
   | 菜单关 | 放行 shell | 放行 shell | shell | — |

   菜单显示 ≠ 键盘所有权；补全任何一层失败不得影响 PTY 输入链路。
3. **feature flag**：pluginStore key `ssh-completion-engine`，值
   `"legacy" | "fig-safe"`，wave 1 默认 `"legacy"`（fig-safe 等 C 的 spec 落地后
   wave 2 再切默认）。SettingsDialog 增加引擎选择；新文案七语全补
   （zh-CN/zh-TW/en/es/it/ja/pt）。
4. **accept 范围**：wave 1 仅行尾补全（`cursor === text.length`）；任意光标位置
   留 wave 2（方案 §22/§23）。
5. **RPC 命名**：方法名 `completion/execute`；字段 camelCase（仓库协议约定，
   见 SKILL 与 `docs/PROTOCOL.zh-CN.md`）；错误沿用 sidecar 字符串 Err 惯例，
   加 `completion:` 前缀分类。

## 5. completion/execute RPC 契约（与 host/protocol.ts 一致）

约束：

- generator 一律 `sudo=false`；只读连接（read_only）直接拒绝；
- `timeoutMs` 在 completion 层 clamp 到 [200, 3000]，默认 1200；
- stdout/stderr 各自按 `maxOutputBytes` 截断并置 `truncated=true`；
- SSH 实现复用 `SshRuntime::exec`（`backend/src/ssh.rs` 约 :3638），带 exec_id；
  completion 层竞速超时，超时后走既有 `ssh/exec/cancel` 同路径回收
  （**不修改** `SshRuntime::exec` 现有 `clamp(5,300)` 下限）；
- local 实现用短生命周期子进程（`std::process::Command` + 超时杀进程），
  **禁止**注入用户交互 PTY（`backend/src/local_terminal.rs` 的 PTY 与本功能无关）；
- 审计与 `ssh/exec` 同模式（`backend/src/main.rs` 现有 audit 调用照搬）；
- wave 1 不做 `completion/listDirectory`、`completion/environment`。

## 6. 文件归属（越界即冲突，禁止）

| Lane | 拥有（新增/修改） |
|---|---|
| A | `frontend/src/lib/completion/core/{engine,edit,ranking}.ts`、`frontend/src/lib/completion/keyboard.ts`、`frontend/src/lib/completion/legacy/*`、`frontend/src/lib/completion/CompletionController.ts`；`frontend/src/App.vue`；`frontend/src/components/CompletionMenu.vue`（仅必要 props 适配）；`frontend/src/lib/i18n.ts`；`frontend/src/components/SettingsDialog.vue`；对应 `*.spec.ts` |
| B | `backend/src/completion/*`；`backend/src/main.rs`（仅路由注册与 audit 接线）；`docs/PROTOCOL.zh-CN.md`；`scripts/smoke_completion.py`；模块内 `#[cfg(test)]` |
| C | `frontend/src/lib/completion/fig/*`；`frontend/vendor/*`；`scripts/sync_fig_specs.mjs`；`scripts/verify_fig_specs.mjs`；`frontend/package.json`（仅 scripts 与必要 devDependencies）；`docs/fig-specs-size-report.md`；对应 `*.spec.ts` |
| 只读共享 | `core/types.ts`、`host/protocol.ts`、`lib/completions/spec.ts`（legacy parser，A 经 adapter 包装、不改语义）、`lib/completions/provider.ts`、`lib/overlayPlacement.ts`、`backend/src/{ssh,exec,local_terminal}.rs`（B 只调用不重构） |

## 7. 验证门禁（交付前必须全绿）

环境：`export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:$PATH"`

- A/C：`pnpm --dir frontend install --prefer-offline` → `typecheck` → `test` → `build`
- B：`cargo fmt --manifest-path backend/Cargo.toml --check` →
  `cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings` →
  `cargo test --locked --manifest-path backend/Cargo.toml`
- 全 lane：不新增运行时依赖（SKILL 红线；C 的 devDependency 例外需在报告里论证）；
  不使用真实 SSH 凭据；单测不得联网（C 的上游拉取只发生在显式 sync 命令，测试用
  fixture）；不 push / 不 merge / 不安装插件。

## 8. 提交与移交

- 每 lane 在自己分支按逻辑单元提交（zh conventional commits，如
  `feat(completion): ...`）；**不 push**。
- lane 最终报告必须包含：base SHA、commit 列表、变更文件、验证结果摘要、
  与契约的偏差、风险与 follow-up。
