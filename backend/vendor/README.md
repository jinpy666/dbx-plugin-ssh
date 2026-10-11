# Vendored RDP fork 链登记（Route B）

依据 `docs/RDP_VENDOR_FORK_PLAN.zh-CN.md`（§4 维护规则、§5 登记模板、§6 锁步断言）。
对标蓝本：NyaTerm `src-tauri/vendor/`（2026-09 搬运，整链锁步，禁止单 crate 漂移）。

锁步集合（**六个一体升级**，`backend/Cargo.toml` `[patch.crates-io]` + `scripts/check_vendor_lockstep.py` 守护）：

| crate | 版本 | 上游 | 来源 | 许可证 |
| --- | --- | --- | --- | --- |
| `ironrdp`（umbrella） | 0.17.0 | Devolutions/IronRDP | crates.io 0.17.0 tarball sha256 `0f910b8dc8e7b8e001c61fd742be442e8604fb2499ded713cadf911e7645ade4`（2026-09 下载件逐文件比对一致，无补丁）；树 tree-sha256 `08008fd58cd8fde8c67ef65a2a5d4f3a6fe82c6619b4a0476cc42a07fb514ab2` | MIT OR Apache-2.0 |
| `ironrdp-async` | 0.10.0 | Devolutions/IronRDP | crates.io 0.10.0 tarball sha256 `bea12d80384007fe321eb6b36c9225be9559c655fd581458a6a1386c1774d729`（2026-10 下载件比对，见下文补丁清单）；树 tree-sha256 `e728e68e608b3d603cee02d36964c758dcee33bed019ee84845461585720a3ae` | MIT OR Apache-2.0 |
| `ironrdp-client` | 0.1.0 | Devolutions/IronRDP | crates.io 0.1.0 tarball sha256 `e2a3b44f8af101cf5a8cc5bf80470d64099c95c553d5597dec55ff38a821243e` + NyaTerm 补丁（实际差异面见下文逐 crate 登记）；树 tree-sha256 `7951ad6b8f5c441342736c0d5335d2f9b34e9cb49d67418a1b77fbe9a97eeae7` | MIT OR Apache-2.0 |
| `ironrdp-connector` | 0.10.0 | Devolutions/IronRDP | crates.io 0.10.0 tarball sha256 `d5898b3f1fcaca0f9b923b1463e158aeb64dfdec4ac361b7c086492466ff341c` + NyaTerm 副本差异（见下文）；树 tree-sha256 `e6d35b48b1df61fdaec6059717d5ca03a3acf7a589185b4f651ab364d8a14ce6` | MIT OR Apache-2.0 |
| `ironrdp-tls` | 0.2.2 | Devolutions/IronRDP | crates.io 0.2.2 tarball sha256 `ea5f0bb732e33159834f06a687f5415dae1a82c71c123c1c3a3689d41ed47645` + NyaTerm 副本差异（含 TLS 主机名校验放宽，见下文）；树 tree-sha256 `24e8fb91fed71198ade471114824e3a5a3b16dfda2e7fb374651d682a723f67c` | MIT OR Apache-2.0 |
| `picky` | 7.0.0-rc.25 | Devolutions/picky-rs | crates.io 7.0.0-rc.25 tarball sha256 `c1ae9cd78eb1d61be4790713d28368cf71c844218fcd91542768805423f02666` + NyaTerm 副本差异（见下文）；树 tree-sha256 `a413a5693b1aaf66a639000d39c869d3e27083ed611dc0a2de9447b947465160` | MIT OR Apache-2.0 |
| `sspi` | 0.21.0 | Devolutions/sspi-rs | crates.io 0.21.0 tarball sha256 `3db83308ba07f6c54141f7e34a167353f81250fe8ccab87e90c323f4390b0fb0` + NyaTerm 副本差异（见下文）；树 tree-sha256 `ed6df5ed345cad981eb28ea4af322bdee90ee7b92a7ee2854738d70c78a1c59b` | MIT OR Apache-2.0 |

`tree-sha256` 是**补丁后 vendored 树**的确定性内容哈希（文件按相对路径排序、
内容按 LF 规范化后流入 SHA-256），由 `verify_rdp_vendor_integrity.py` 默认校验：
树上任何未回填本表的改动都会让校验失败。`sha256` 是上游 crates.io 发布件的基线哈希。

## 来源与完整性核验

本仓库不伪造未知的上游 tarball hash。每次 vendor 链更新必须在可复现的
维护环境中，以**该版本 crates.io 下载件或记录的上游 revision**为来源，并把已知的
SHA-256 与来源记录在上表；未知项先保持“待核验”，不得猜填。提交前运行：

```bash
python3 scripts/check_vendor_lockstep.py
python3 scripts/verify_rdp_vendor_integrity.py
```

第二个脚本执行离线可验证项：逐一检查六个 vendored crate 的包名/版本、许可证文件、
来源登记，以及不允许将未经登记的额外 Cargo crate 放进 `backend/vendor/`；并**默认**
比对上表 `tree-sha256` 与 vendored 树的实际内容（文件按路径排序、LF 规范化后流入
SHA-256）——树上任何未回填本表的改动都会 FAIL。`--require-recorded-hashes` 进一步
要求六个条目全部登记双哈希（CI 与发布门均已启用，见下）。

**2026-09 首轮核验已完成**：从 crates.io 下载六个发布件，逐一与 vendored 树做
逐文件比对（`diff -rq`）。结论：umbrella `ironrdp` 与发布件逐文件一致；其余五个
crate 的差异面均来自 NyaTerm vendor 副本（已全部归类并回填下文逐 crate 登记）。
此前“connector / ironrdp-tls / picky / sspi 无补丁”的声明与事实不符，已按实际
差异面修正——其中 ironrdp-tls 的 TLS 主机名校验放宽为安全敏感改动，已并入
CredSSP 评审范围（`docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`）。

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
- 本地补丁清单（2026-09 与 crates.io 0.1.0 下载件逐文件比对核定；均沿 NyaTerm
  vendor 副本搬运，尚未提上游）：
  1. 可注入服务端证书校验器（`ServerCertificateVerifier`）：TLS/RDCleanPath 证书
     提取后、RDP finalize 前回调——本仓库证书 prompt/remember 策略挂点。
     涉及 `src/rdp.rs`、`src/config.rs`。
  2. 可注入 CLIPRDR 后端工厂（`CliprdrFactory`，类型实际落在 `src/config.rs`）：
     支持 text-only 剪贴板桥替代原生后端；`Cargo.toml` 相应新增 `ironrdp-bulk`
     依赖。
  3. `src/lib.rs`：剪贴板模块从 `all(windows, clipboard)` 放开为非 Windows 也随
     `clipboard` feature 暴露。
  4. CredSSP 补丁（2026-10，a3eb0bda，安全评审见
     `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`）：`src/rdp.rs` 把
     CredSSP 阶段产出的通道绑定哈希接入 active session 更新——域机 EPA
     （扩展保护）强制下 NTLM 认证不再结构性被域控拒绝。
  （原登记把工厂类型落在 `src/clipboard.rs`；比对证实该文件与发布件一致，已修正。
  `.cargo-ok` 为 cargo vendor 流程产物。）
- 上游回灌：补丁 1/2 有上游 FIXME 背书（上游自认"应支持外插 CliprdrBackendFactory"），
  优先提 PR；补丁 3 无公开计划，作为长期回灌项（计划 §3/§5）。
- 升级解除条件：上游发布等价注入 API 后，对应补丁即可删除（升级轮逐条核对）。
- 附注：crates.io 0.1.0 发布包不含 LICENSE 文件（NyaTerm 副本同），本仓库已从同一
  upstream monorepo 的 `ironrdp-connector` 包副本补齐 `LICENSE-APACHE` / `LICENSE-MIT`
  （IronRDP 全仓同源同许可）。

### ironrdp-async

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.10.0 发布包（第七个
  lockstep 成员，2026-10 随 CredSSP 补丁引入）。
- 本地补丁清单（2026-10 与 crates.io 0.10.0 下载件逐文件比对核定）：
  `src/connector.rs` 的 `ClientConnector`/`connect_finalize` 增加可选
  `channel_bindings` 参数并透传给 connector 阶段——`tls-server-end-point`
  通道绑定的进入点（域机 EPA 强制所需）；其余为打包流程差异
  (`.cargo-ok`/`Cargo.lock`/`Cargo.toml.orig`/`CHANGELOG.md`）。
- 升级解除条件：无独立解除项（跟随整链）。

### ironrdp-connector

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.10.0 发布包。
- 本地补丁清单（2026-09 比对核定，原"无补丁"声明已修正）：`src/connection.rs`
  移除 `#[expect(single_use_lifetimes)]` 属性（旧工具链兼容）；`Cargo.toml` 把
  picky 钉版收紧为 `=0.21.0`；`CHANGELOG.md` 随 NyaTerm 发布流程差异。
- CredSSP 补丁（2026-10，a3eb0bda，安全评审见
  `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`）：`src/credssp.rs` 在
  `CredSspClientState::EarlyAuthRequest` 阶段补发 `tls-server-end-point`
  通道绑定哈希——域机 EPA（扩展保护）强制下 NTLM 认证不再结构性被域控拒绝。
- 升级解除条件：无独立解除项（跟随整链）。

### ironrdp-tls

- 上游仓库 / 钉定：Devolutions/IronRDP，crates.io 0.2.2 发布包。
- 本地补丁清单（2026-09 比对核定，原"按原样搬运"声明已修正）：
  `src/native_tls.rs` 在 native-tls（Windows）后端追加
  `.danger_accept_invalid_hostnames(true)`——⚠️ **安全敏感**：TLS 主机名校验在
  该后端被放宽，服务器身份改由 ironrdp-client 补丁 1 注入的
  `ServerCertificateVerifier` 承担；本仓库证书策略（fail-closed、prompt/remember）
  必须始终覆盖该路径。已纳入 CredSSP 评审清单范围。
- CredSSP 补丁（2026-10，a3eb0bda）：三个后端（native-tls/rustls/stub）把
  TLS 层证书哈希经 `ClientConfig` 透传给 CredSSP 客户端，供
  `tls-server-end-point` 通道绑定计算（域机 EPA 强制所需）。
- 升级解除条件：上游提供等价校验器注入点后随整链升级删除。

### picky

- 上游仓库 / 钉定：Devolutions/picky-rs，crates.io 7.0.0-rc.25。
- 本地补丁清单（2026-09 比对核定，原"无补丁"声明已修正）：`src/signature.rs`
  import 收窄（`Signer` 不再引 `SignatureEncoding`，对齐 NyaTerm 锁定的 rsa API
  面）；`Cargo.toml` / `CHANGELOG.md` 随 NyaTerm 发布流程差异。
- 与锁步邻居的约束：connector 0.10.0 与 sspi 0.21.0 上游的 picky 版本约束决定本钉版；
  升级（尤其离开 rc）前须核对两者上游约束。
- 解除条件（计划 §5 缺口 2）：connector/sspi 上游把 picky 约束抬到非 rc 正式版后，
  本 crate 随整链升级离开 rc；在此之前维持 rc 钉版。

### sspi

- 上游仓库 / 钉定：Devolutions/sspi-rs，crates.io 0.21.0 发布包。
- 本地补丁清单（2026-09 比对核定，原"无补丁"声明已修正）：`src/auth_identity.rs`
  为 NTLM 凭据补 UPN / DownLevelLogonName 用户名格式的 domain 提取分支；
  `Cargo.toml` 把 picky / connector 等依赖钉版同步到链内版本。
- CredSSP 补丁（2026-10，a3eb0bda，安全评审见
  `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`）：`src/channel_bindings.rs` 新增
  `tls-server-end-point` 哈希装配；`credssp/mod.rs` 把通道绑定与 TLS 证书哈希
  接入 AS Request；`ntlm` 的 `computations.rs` 把 `ChannelBindings` 摘要纳入
  `MIC` 计算——通道绑定缺失即 EPA 域控拒绝的根因。
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
