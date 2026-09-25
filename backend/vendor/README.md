# Vendored RDP fork 链登记（Route B）

依据 `docs/RDP_VENDOR_FORK_PLAN.zh-CN.md`（§4 维护规则、§5 登记模板、§6 锁步断言）。
对标蓝本：NyaTerm `src-tauri/vendor/`（2026-09 搬运，整链锁步，禁止单 crate 漂移）。

锁步集合（**六个一体升级**，`backend/Cargo.toml` `[patch.crates-io]` + `scripts/check_vendor_lockstep.py` 守护）：

| crate | 版本 | 上游 | 来源 | 许可证 |
| --- | --- | --- | --- | --- |
| `ironrdp`（umbrella） | 0.17.0 | Devolutions/IronRDP | crates.io 0.17.0 tarball（sha256 `0f910b8dc8e7b8e001c61fd742be442e8604fb2499ded713cadf911e7645ade4`，与 NyaTerm Cargo.lock 一致） | MIT OR Apache-2.0 |
| `ironrdp-client` | 0.1.0 | Devolutions/IronRDP | NyaTerm vendor 副本（crates.io 0.1.0 包 + NyaTerm 补丁） | MIT OR Apache-2.0 |
| `ironrdp-connector` | 0.10.0 | Devolutions/IronRDP | NyaTerm vendor 副本（crates.io 0.10.0 包） | MIT OR Apache-2.0 |
| `ironrdp-tls` | 0.2.2 | Devolutions/IronRDP | NyaTerm vendor 副本（crates.io 0.2.2 包） | MIT OR Apache-2.0 |
| `picky` | 7.0.0-rc.25 | Devolutions/picky-rs | NyaTerm vendor 副本（crates.io 7.0.0-rc.25 包） | MIT OR Apache-2.0 |
| `sspi` | 0.21.0 | Devolutions/sspi-rs | NyaTerm vendor 副本（crates.io 0.21.0 包） | MIT OR Apache-2.0 |

世代约束：umbrella `ironrdp` 0.17 依赖 `ironrdp-client ^0.1` / `ironrdp-connector ^0.10`，
与上表版本强绑定；**升级 umbrella 必须整链同轮核对**，不允许只升 umbrella 不升链（或反向）。

TLS 后端：非 Windows = rustls（`cfg(not(windows))` feature），Windows = native-tls/Schannel
（`cfg(windows)` feature），沿 NyaTerm 分平台口径（计划 §8-7）。

## 逐 crate 登记（§5 模板）

### ironrdp（umbrella）

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.17.0（发布包原样，**无本地补丁**）。
- 为何 vendored：本身无补丁，但版本与链内 crate 世代强对应；纳入 vendor +
  `[patch.crates-io]` 是为让锁步断言覆盖 umbrella，堵住"只升 umbrella"的漂移入口。
- 与锁步邻居的约束：要求 client ^0.1 / connector ^0.10（见世代约束）。
- 升级解除条件：无（长期存在；若上游发新 umbrella，整链同轮升级）。

### ironrdp-client

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.1.0 发布包 + NyaTerm 本地补丁。
- 本地补丁清单（沿 NyaTerm `vendor/README.md` 记录，3 处；均为下游消费 API，尚未提上游）：
  1. 可注入服务端证书校验器（`ServerCertificateVerifier`）：TLS/RDCleanPath 证书提取后、
     RDP finalize 前回调——本仓库证书 prompt/remember 策略挂点。涉及 `src/rdp.rs`。
  2. 可注入 CLIPRDR 后端工厂：支持 text-only 剪贴板桥替代原生后端。涉及 `src/clipboard.rs`。
  3. 非 Windows 构建下随 clipboard feature 暴露剪贴板模块。涉及 `src/lib.rs`。
- 上游回灌：补丁 2 有上游 FIXME 背书（上游自认"应支持外插 CliprdrBackendFactory"），
  优先提 PR；补丁 1/3 无公开计划，作为长期回灌项（计划 §3/§5）。
- 升级解除条件：上游发布等价注入 API 后，对应补丁即可删除（升级轮逐条核对）。
- 附注：crates.io 0.1.0 发布包不含 LICENSE 文件（NyaTerm 副本同），本仓库已从同一
  upstream monorepo 的 `ironrdp-connector` 包副本补齐 `LICENSE-APACHE` / `LICENSE-MIT`
  （IronRDP 全仓同源同许可）。

### ironrdp-connector

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.10.0 发布包。
- 本地补丁清单：无意图补丁；仅跟随 vendored client 的兼容性修复，**与 client 锁步**。
- 升级解除条件：无独立解除项（跟随整链）。

### ironrdp-tls

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.2.2 发布包。
- 本地补丁清单：按 NyaTerm 原样搬运。⚠️ NyaTerm `vendor/README.md` 未记录该 crate 的
  补丁状态（计划 §5 缺口 1）；本轮按"原样搬运、无本仓库意图补丁"登记，升级轮须
  `git diff` 对照 crates.io 0.2.2 原包核实并回填本条。
- 升级解除条件：同上，待核实后回填。

### picky

- 上游仓库 / 钉定：Devolutions/picky-rs，crates.io 7.0.0-rc.25。
- 本地补丁清单：无意图补丁；为 vendored connector / sspi 的依赖钉版。
- 与锁步邻居的约束：connector 0.10.0 与 sspi 0.21.0 上游的 picky 版本约束决定本钉版；
  升级（尤其离开 rc）前须核对两者上游约束。
- 解除条件（计划 §5 缺口 2）：connector/sspi 上游把 picky 约束抬到非 rc 正式版后，
  本 crate 随整链升级离开 rc；在此之前维持 rc 钉版。

### sspi

- 上游仓库 / 钉定：Devolutions/sspi-rs，crates.io 0.21.0 发布包。
- 本地补丁清单：无意图补丁；CredSSP/NLA 实现与 vendored connector + pinned picky 锁步。
- 升级解除条件：无独立解除项（跟随整链）。CredSSP 安全评审见
  `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`。

## 更新方法（每轮升级执行）

1. 记录现状：`git diff -- backend/vendor/<crate>`，对照本文逐条核对补丁面。
2. 换入上游目标版本；优先删除"上游已吸收"的本地补丁；六个 crate 同轮处理。
3. `cargo generate-lockfile`（在 `backend/`）再生 lock，跑
   `python3 scripts/check_vendor_lockstep.py`（PASS 才能进 CI）。
4. 验证：`cargo fmt` / `cargo clippy --locked --all-targets -- -D warnings` /
   `cargo test --locked`；真机冒烟矩阵见计划 §6 runbook。
5. 回填本文各条（版本、补丁、解除条件）与 CHANGELOG，升级记录进 PR 描述。
