# FIG Wave 1 验证计划

> 环境统一：`export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:$PATH"`

## 1. 各 lane 交付门禁（agent 完成前自查，全绿才算完成）

### Lane A / C（前端）

```bash
pnpm --dir <worktree>/frontend install --prefer-offline
pnpm --dir <worktree>/frontend typecheck
pnpm --dir <worktree>/frontend test        # A：既有 128 文件零失败 + 新增 spec 全过；C：同 + fig 用例
pnpm --dir <worktree>/frontend build
```

C 追加：`pnpm --dir <worktree>/frontend fig:verify`；sync 幂等性自查一次。

### Lane B（后端）

```bash
cargo fmt --manifest-path <worktree>/backend/Cargo.toml --check
cargo clippy --locked --manifest-path <worktree>/backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path <worktree>/backend/Cargo.toml
# docker 容器可用时（见 SKILL 测试容器章节）：
python3 <worktree>/scripts/smoke_completion.py
```

`git -C <worktree> diff --stat codex/ssh/fig-wave1-base` 必须只落在契约 §6
归属文件内（B 的 ssh.rs 最小只读查询例外需在报告中列明）。

## 2. 集成阶段（三 lane 合入后，integrator/协调者执行）

```bash
# 集成分支：从 fig-wave1-base 起，依序 merge 三条 lane 分支（文件互斥，顺序任意）
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
node scripts/smoke_ui_mock.mjs
node scripts/smoke_ui_settings.mjs
pnpm --dir frontend fig:verify          # C 产物在集成态复验
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path backend/Cargo.toml
python3 scripts/smoke_completion.py     # 容器可用时
```

## 3. 行为回归红线（任一破坏即回退整改）

1. **PTY 输入链路零影响**：A 的 golden parity 测试 + 键盘表驱动单测全绿；
   completion 任何异常（engine 抛错/存储读失败）不冒泡到 onData 路径。
2. **默认行为 = HEAD**：无 `ssh-completion-engine` 存储时，浮层/键盘/接受
   行为与基线逐项一致（手动清单：git ch<Tab>、git checkout -<Tab> 进值层、
   hint 行 Tab 透传、Enter 恒执行、Esc 关闭、总开关关→零浮层）。
3. **既有 ssh/exec 语义零改动**：B 分支 `git diff codex/ssh/fig-wave1-base -- backend/src/ssh.rs backend/src/exec.rs`
   除预批的最小只读查询 fn 外为空。
4. **零新增运行时依赖**：`frontend/package.json` dependencies 与
   `backend/Cargo.toml` [dependencies] 无新增项（scripts/devDeps 变更需报告获批）。

## 4. Wave 1 验收清单（对齐方案 §51 的 wave-1 子集）

- [ ] CompletionItem/CompletionEdit/EditBuffer 落地且 legacy 零回归（A）
- [ ] 键盘所有权规则表驱动固化，Enter/hint-Tab 透传不可回归（A）
- [ ] feature flag `ssh-completion-engine` + 设置项七语（A）
- [ ] `completion/execute` local/SSH 双 target、超时/上限/取消/只读拒绝（B）
- [ ] PROTOCOL 文档 + smoke 用例（SKIP 语义正确）（B）
- [ ] 11 spec snapshot + manifest + verify 脚本（C）
- [ ] 体积实测报告与 wave 2 默认集建议（C）
- [ ] 三 lane 全绿 + 集成全仓门禁全绿
- [ ] lane 报告齐备（契约 §8 格式：base SHA/commits/files/验证/偏差/风险/follow-up）

## 5. 回滚策略

- 每 lane 独立分支，任一 lane 失败可单独弃置，不影响其余两条。
- B/C 合入后默认不改变任何用户可见行为（flag 默认 legacy；completion/execute
  无调用方），可安全随版本携带；A 是唯一行为敏感面，靠 parity 测试兜底。
- 集成分支问题 → 弃集成分支重做，不动 fig-wave1-base 与各 lane 分支。
