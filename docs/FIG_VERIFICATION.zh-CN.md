# FIG 验证计划（最终架构版）

> 环境统一：`export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:$PATH"`

## 1. Lane 交付门禁（完成前自查，全绿才算完）

### Lane A'（frontend-core）

```bash
pnpm --dir <wt>/frontend install --prefer-offline
pnpm --dir <wt>/frontend typecheck && pnpm --dir <wt>/frontend test && pnpm --dir <wt>/frontend build
grep -rn "lib/completions" <wt>/frontend/src      # 必须无结果
grep -rn "ssh-completion-spec" <wt>/frontend/src  # 必须无结果
```

### Lane C'（fig-specs）

```bash
pnpm --dir <wt>/frontend install --prefer-offline
pnpm --dir <wt>/frontend typecheck && pnpm --dir <wt>/frontend test && pnpm --dir <wt>/frontend build
pnpm --dir <wt>/frontend fig:verify
# fig:sync 幂等自查：同 pin 二次运行 diff 为空（有外网时）
```

### Lane B（completion-host，原文不变）

```bash
cargo fmt --manifest-path <wt>/backend/Cargo.toml --check
cargo clippy --locked --manifest-path <wt>/backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path <wt>/backend/Cargo.toml
python3 <wt>/scripts/smoke_completion.py   # docker 容器可用时
```

### 归属检查（全 lane）

`git diff --stat codex/ssh/fig-wave1-base` 只落契约 §4 归属文件（B 的 ssh.rs 预批例外须列报告）。

## 2. 集成阶段（三 lane 合入，integrator/协调者执行）

```bash
git checkout -b codex/ssh/fig-wave1-integration codex/ssh/fig-wave1-base
git merge codex/ssh/fig-wave1-frontend-core
git merge codex/ssh/fig-wave1-completion-host
git merge codex/ssh/fig-wave1-fig-specs

# 全仓门禁（对齐 agent-flow validation.local）
python3 scripts/validate_repo.py
python3 scripts/check_vendor_lockstep.py
python3 scripts/verify_rdp_vendor_integrity.py
node scripts/connection-forms/verify.mjs
pnpm --dir frontend typecheck && pnpm --dir frontend test && pnpm --dir frontend build
pnpm --dir frontend fig:verify
node scripts/smoke_ui_mock.mjs && node scripts/smoke_ui_settings.mjs
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path backend/Cargo.toml
python3 scripts/smoke_completion.py        # 容器可用时

# 退役门禁
grep -rn "lib/completions\|ssh-completion-spec" frontend/src   # 无结果
git grep -l "import-fig-specs"                                  # 无结果
```

## 3. 回归红线（任一破坏即回退整改）

1. **PTY 输入链路零影响**：completion 任何异常（parser 抛错/存储读失败/source 崩）不冒泡到 onData 路径；`off` 时零结构化浮层。
2. **键盘语义表不回归**：Enter 恒执行当前行；动态/generator 位置与 loading 时 Tab 透传 shell；↑↓/Esc 菜单内消费；表驱动单测固化。
3. **既有 ssh/exec 语义零改动**：B 分支对 `backend/src/ssh.rs`、`backend/src/exec.rs` 的 diff 除预批最小只读查询 fn 外为空。
4. **零新增运行时依赖**：`frontend/package.json` dependencies 与 `backend/Cargo.toml` [dependencies] 无新增（C' devDeps 论证制获批除外）。
5. **历史建议 / ghost 不受影响**：独立引擎，行为与基线一致。

## 4. 批次 1 验收清单

- [ ] fig 引擎（vendored amazon-q parser + 全量 manifest）经 `FigCompletionSource` 接缝驱动浮层（别名/嵌套/`--`/flag=value 语义来自 parser）
- [ ] legacy `lib/completions/**` 退役，两个 grep 门禁通过
- [ ] 键盘所有权规则表驱动固化（Enter / 动态 Tab 透传不可回归）
- [ ] `completion/execute` local/SSH 双 target（超时/上限/取消/只读拒绝）
- [ ] PROTOCOL 文档 + smoke（SKIP 语义正确）
- [ ] snapshot 双 pin + verify 预算门禁 + 体积报告（全量 vs Top-N 建议）
- [ ] 设置 `ssh-completion-engine` 三态 + 七语；`ssh-completion-spec` 退役
- [ ] 三 lane 全绿 + 集成全仓门禁全绿 + lane 报告齐备（契约 §6 格式）

## 5. 回滚策略

- lane 独立分支，任一失败可单独弃置。
- C' 产物在批次 2 前无运行时调用方，为零风险携带；B 的 RPC 同理。
- A' 是唯一行为敏感面（App.vue/键盘），靠表驱动单测 + §3 红线 + 手动清单兜底。
- 集成分支问题 → 弃集成分支重做，不动 fig-wave1-base 与各 lane 分支。
