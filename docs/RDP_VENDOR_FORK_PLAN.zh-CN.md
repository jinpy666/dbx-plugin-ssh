# RDP vendored fork 链维护计划（立项材料，Task P3-4 / 差距项 2e）

日期：2026-09-24（2026-09-25 依对抗评审修订：spike 结论回写、锁步补 umbrella、Kerberos 口径对齐）　分支：`codex/ssh/parity-rdp-docs`　状态：**评审门材料——供人工评审，不构成实现决定**。

对应 `docs/IMPL_PLAN_NYATERM_PARITY.zh-CN.md` Task P3-4 与 `docs/PROGRESS-P-SSH.zh-CN.md` M5 遗留第 2 条（"RDP：vendored fork 链 + CredSSP 评审——维持人工评审门"）。CredSSP 安全评审清单独立成文：`docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`。IMPL_PLAN 中 P3-4 还包含**带宽压测方案**，属实现轮产出，本文不覆盖（见 §8 决策项）。

## 1. 范围与现状

- **范围裁剪**（沿 IMPL_PLAN，不得扩大）：密码/NLA 认证 + TLS + 文本剪贴板 + 断线重连；**不做**音频、驱动器重定向、键盘捕获。
- **范围边界显式声明**（补对抗评审缺口）：**不做**网关（MS-TSGU）与 RDCleanPath 代理形态，仅 TCP 直连形态；bitmap cache / 动态虚拟通道沿上游默认、不做定制（范围内唯一的虚拟通道是静态 VC 的 CLIPRDR 文本剪贴板）。
- **本仓库现状**：backend 无任何 RDP 代码；唯一 vendored 目录是 `shared/sdk`（DBX sidecar SDK，非第三方 fork）。VNC（2d）已按"**上游直依 + 插件层加固**"落地（`vnc-rs = "0.6"`，见 `docs/SPIKE_VNC_SESSION.zh-CN.md`）。
- **对照基线**：NyaTerm 侧以 1:1 源码为据——`/Users/Jinpy/btroot/nyaterm/src-tauri/vendor/`（git 全程跟踪）+ `vendor/README.md` + `vendor/WIN7_PATCHES.md`，经 `src-tauri/Cargo.toml` 的 `[patch.crates-io]` 指向本地路径。

## 2. NyaTerm RDP fork 链事实基线

| crate | 上游 | NyaTerm 版本 | 许可证 | 本地补丁面（README 记录） |
| --- | --- | --- | --- | --- |
| `ironrdp-client` | Devolutions/IronRDP | 0.1.0 | MIT OR Apache-2.0 | **3 处**：可注入服务端证书校验器（TLS/RDCleanPath 证书提取后、RDP finalize 前）；可注入 CLIPRDR 后端工厂（text-only 剪贴板桥）；非 Windows 构建下随 clipboard feature 暴露剪贴板模块 |
| `ironrdp-connector` | Devolutions/IronRDP | 0.10.0 | MIT OR Apache-2.0 | 无意图补丁，仅跟随 client 的兼容性修复，**与 client 锁步** |
| `ironrdp-tls` | Devolutions/IronRDP | 0.2.2 | MIT OR Apache-2.0 | ⚠️ **README 未记录**（补丁状态未知，见 §5 缺口 1） |
| `picky` | Devolutions/picky-rs | 7.0.0-rc.25 | MIT OR Apache-2.0 | 无意图补丁，为 connector/sspi 依赖钉版 |
| `sspi` | Devolutions/sspi-rs | 0.21.0 | MIT OR Apache-2.0 | 无意图补丁，CredSSP/NLA 与 connector + pinned picky **锁步** |

补充事实：

- `[patch.crates-io]` 覆盖上述 5 crate（`ironrdp-client` / `ironrdp-connector` / `ironrdp-tls` / `picky` / `sspi`）→ 路径依赖 `vendor/<crate>`；**升级必须整链同轮**，不允许单 crate 漂移。
- **umbrella 依赖同属锁步集合**：NyaTerm 经 `ironrdp = "0.17"` umbrella（features `client` / `client-clipboard` / `cliprdr` / `connector` / `core` / `input` / `pdu`，另按平台加 `rustls` / `native-tls` feature）消费上述 5 crate。umbrella 本身**未打补丁**，但其版本与链内 crate 世代强对应——上游 umbrella 0.17.0 依赖清单要求 `ironrdp-client ^0.1` / `ironrdp-connector ^0.10`（crates.io 已核实）。因此 **umbrella 0.17 与 client 0.1.0 / connector 0.10.0 必须同轮升级**：只升 umbrella 不升链（或反之）正是本计划要防的"单 crate 漂移"入口。
- Win7 兼容侧另有 `windows-core 0.62.2`（ole32 导入补丁）与 `webview2-com-sys 0.38.2`（loader 钉版），由 `WIN7_PATCHES.md` 单独记录、`windows-7-compat.yml` PE 审计守护——本插件**没有 Win7 兼容目标**，是否继承该子链见 §8 决策项（默认不继承）。
- NyaTerm 实测 TLS 后端：Windows = native-tls（Schannel），其余平台 = rustls（`src/core/rdp.rs` `rdp_tls_backend_label()`）。
- NyaTerm 的接线面：`ServerCertificateVerifier` 注入（证书策略默认 `prompt`，120s 确认窗 + remember + generation 防串话）、`.with_credssp(use_nla).with_tls(true)`、text-only CLIPRDR 桥、重连默认 5 次**且按错误类型门控**（`classify_connector_error` / `classify_session_error` + `allow_reconnect`，认证类失败不自动重连）。这些是"为什么需要 fork"的直接原因——**上游客户端 API 若已等价暴露，fork 即无必要**（已按 §3 spike 核实，结论：未暴露）。

## 3. 引入路线决策框架（Route A / B / C）

沿 VNC spike 的 Route 方法论，RDP 评审门需在以下路线中裁决：

| 路线 | 内容 | 成立条件 | 风险 |
| --- | --- | --- | --- |
| **A：上游直依** | crates.io 直依 `ironrdp-*` 系列常规版本，插件层补加固（vnc-rs 先例） | 上游已提供（或近期版本提供）证书校验器注入点与剪贴板后端定制点；上游发版节奏覆盖安全响应 | 上游若不允许注入，证书校验/剪贴板需求无法满足 |
| **B：vendored fork 链** | 复制 NyaTerm 模式：5 crate 路径依赖 + `[patch.crates-io]` + 补丁文档 | 注入点上游未提供，或需与 NyaTerm 逐 commit 对齐评审 | 长期维护税：锁步升级、补丁漂移、安全响应延迟（量化估算见 §4） |
| **C：自研协议栈** | 自实现 RDP/CredSSP/NTLM | — | CredSSP/NTLM 自实现风险极高（见 CredSSP 清单），成本不可比，**不建议**，仅留档为评审备选 |

**裁决规则（覆盖"部分成立"中间态）**：仅当**证书校验器注入**与 **CLIPRDR 后端工厂注入**两项均在上游等价暴露、且上游发版节奏能覆盖安全响应时，Route A 才成立；**任一项缺失即落 Route B**（fork 补丁面按已暴露项相应缩小），不存在"部分成立走 A"的中间路线。

**上游注入点核实 spike（已执行，2026-09-25）**：只读调研 crates.io 发布源码（ironrdp-client 0.1.0 源码包、ironrdp-connector 0.10.0 源码包、umbrella ironrdp 0.17.0 依赖清单；docs.rs 对 client 0.1.0 构建失败，故以源码为准；未引入任何依赖），核实结论：

1. **证书校验器注入——上游未暴露**。client 0.1.0 全源码无 `ServerCertificateVerifier` 或任何校验器 API（`verifier` 全文零匹配）：直连路径 `ironrdp_tls::upgrade`（标准 TLS 校验）→ 提取服务端公钥 → `connect_finalize`，RDCleanPath 路径解码证书后同样仅提取公钥；connector 0.10.0 亦无校验器 API。无任何证书策略（未知证书 prompt / remember）挂点。NyaTerm 补丁 1 无上游等价物。
2. **CLIPRDR 后端工厂注入——上游未暴露**。工厂管道在 client 内部存在（`Option<&dyn CliprdrBackendFactory>` 贯穿三条传输路径），但仅从 `ironrdp_cliprdr_native`（`WinClipboard` / `StubClipboard`）硬编码构造；公开 API 仅 `ClipboardType::{Enable, Disable, Stub}`，无自定义后端入口。上游源码自带 FIXME 注释承认"应支持外插任意 `CliprdrBackendFactory` 实现，而非把特定变体烤进客户端"——即上游已知晓该缺口并计划改造，但无已发布实现与时间表。NyaTerm 补丁 2 无上游等价物。
3. **附带核实（传输面 / RDCleanPath 形态）**：`Transport` 仅 Direct（TCP→TLS）/ Gateway（MS-TSGU）/ RDCleanPath（WebSocket 代理），**无 UDP 多传输路径**；RDCleanPath 为 WebSocket 代理形态且上游内建，其证书提取在 client 内部、不可注入——与 §1"仅直连形态"的裁剪一致。

**倾向性意见（供评审参考，spike 后更新）**：两大 fork 理由（注入点）在当前上游 0.17 世代**均不成立**，按上述裁决规则 **Route A 不成立，倾向 Route B（vendored fork 链）**，并按 §5"回灌优先"执行：CLIPRDR 后端工厂注入项的上游化意愿有源码注释背书（FIXME），优先提 PR；证书策略注入无公开计划痕迹，作为长期回灌项。Route B 落地时按 §4–§6 收紧维护纪律。上游未来若同时暴露两项注入点并覆盖安全响应节奏，可按 §4 触发条件在升级轮重新评估 Route A。

## 4. fork 链维护责任与触发机制（Route B 生效时）

- **维护责任人**：人工指派（见 §8 决策项 1），职责覆盖补丁清单守护、锁步升级执行、安全公告响应、每轮升级的评审材料产出。
- **升级触发条件**（满足其一即启动）：
  1. 上游（IronRDP / picky-rs / sspi-rs 任一）发布安全修复或新版本；
  2. RustSec / cargo audit 对链内任一 crate 报 advisory；
  3. CredSSP/NTLM 相关新 CVE（见 CredSSP 清单 §3-D 检查点）；
  4. 本仓库 sidecar 其他依赖升级导致链内 crate 版本约束冲突；
  5. 季度例行核对（即使无事件，确认上游与补丁状态）。
- **锁步规则**：`ironrdp-client` / `ironrdp-connector` / `ironrdp-tls` / `picky` / `sspi` 同一轮升级；**umbrella `ironrdp`（0.17）与链内 crate 同属锁步集合**——升级 umbrella 必须整链同轮核对（其依赖约束与 client 0.1.0 / connector 0.10.0 世代绑定，见 §2），禁止"只升 umbrella 不升链"或反向。`picky` 为 rc 版本，升级需先确认 connector/sspi 上游的版本约束兼容性。
- **维护税基线估算**（供 Route A/B 风险栏可比；为估算非承诺）：锁步整链升级每轮约 **0.5–1 人日**（换版、补丁重放核对、登记文档更新、CI 锁步断言核对）；升级频率参照上游 umbrella 0.9→0.17 的持续活跃发版节奏，预估**每年 2–4 轮**常规升级 + 安全事件即时响应；季度例行核对每次约 0.25 人日。年度稳态合计约 **2–5 人日**（另加临时安全响应）。作为对照，Route A 的对应成本趋近于零（常规依赖升级流程）。

## 5. 安全补丁回灌/升级策略

**回灌优先**：本地补丁若具普遍性（如证书校验器注入 API、剪贴板后端工厂），**先提上游 PR**，上游合入后下一轮升级移除本地补丁。fork 只保留"上游明确拒绝或短期未合入"的最小补丁面。

**补丁文档纪律**（修复 NyaTerm 基线发现的缺口）：

1. **缺口 1**：NyaTerm `vendor/README.md` 未记录 `ironrdp-tls` 的本地改动状态。本仓库若走 Route B，五个 crate **必须逐一登记**（上游 tag/revision、diff、理由），缺一不收。
2. **缺口 2**：`picky 7.0.0-rc.25` 为 rc 版本，README 未记录"何时可离开 rc"。登记时补"解除条件"字段。

每 crate 维护条目模板（Route B 时随 PR 提交于 `docs/` 或 vendor 内 README）：

```
- crate / 上游仓库 / 钉定 revision
- 本地补丁清单（每条：目的 / 涉及文件 / 是否已提上游 PR 及链接）
- 与锁步邻居的版本约束
- 链内 umbrella（ironrdp）版本及其与 client / connector 的世代对应约束
- 升级解除条件（补丁何时可删）
```

## 6. 版本固定与升级演练流程

**版本固定**：

- 链内 crate 在 `Cargo.toml` 用精确版本（`=<x.y.z>`）声明意图，实际锁定以 `Cargo.lock` 为准（**integrator 所有**，agent 不改）；`[patch.crates-io]` 仅 Route B 使用。
- CI 加锁步断言（后端单测或脚本）：校验 umbrella `ironrdp` + 5 个被 patch crate 的版本组合与登记文档一致（含 umbrella 与 client/connector 的世代对应约束），防漂移。
- 不使用 `^` 范围需求让链内 crate 静默升级。

**升级演练 runbook**（每轮升级执行，独立分支 `codex/ssh/parity-rdp*`，agents 不自合 PR）：

1. 记录现状：`git diff -- backend/vendor/<crate>`（对照登记文档核对补丁面，多一行即查明来源）。
2. 换入上游目标 tag/revision；优先删除"上游已吸收"的本地补丁。
3. 整链锁步升级 + `cargo update -p <crates>`；跑 CredSSP 清单 §3-D 的依赖 CVE 复核。
4. 验证：`cargo fmt` / `clippy -D warnings` / `cargo test --locked`；真机冒烟矩阵——Windows 10/11 + Server（非域 NTLM 一例、域环境降级到 NTLM 一例；**Kerberos 非 MVP 范围**，沿 CredSSP 清单 §6-3 口径，列后续扩展项）、NLA on/off、证书 prompt 拒绝/接受路径、text-only 剪贴板（含 16 MiB 超限拒绝行为，见 CredSSP 清单 §3-E）、断线重连（含认证类失败不自动重连的门控行为）。真机项允许标注"待人工"不阻塞 CI。
5. 回滚点：升级前 `Cargo.lock` + vendor diff 打 tag/分支；失败整体 revert，不半程。
6. 更新登记文档与 CHANGELOG，产出升级记录进 PR 描述（基线 SHA、变更、风险）。

## 7. 与 FreeRDP / 自研协议栈的取舍对比

| 维度 | IronRDP 系（Rust，Route A/B） | FreeRDP（C） | 自研协议栈 |
| --- | --- | --- | --- |
| 许可证 | MIT OR Apache-2.0（五 crate 一致，已核实 vendored 副本） | Apache-2.0 | 自有 |
| 语言与现有栈契合 | 纯 Rust，与 sidecar russh/tokio 栈同源；无 FFI | C 库，需 FFI + 交叉编译矩阵 + C 内存安全审计 | 与栈同源但全部自担 |
| CredSSP/NLA 成熟度 | sspi（Devolutions）专注实现，本清单评审对象 | 成熟（多年生产使用，历史上客户端侧 CVE 有修复记录——以评审时官方公告复核为准） | 风险极高（NTLM/CredSSP 协议细节复杂，见 CredSSP 清单） |
| 维护/审计成本 | 依赖审计走常规 RustSec/cargo audit；Route B 另加 fork 税（§4–§6） | 引入 C 依赖链（openssl/winpr 等）审计面显著扩大 | 全量自担，不可行 |
| 功能裁剪匹配度 | 组件化（client/connector/tls 分 crate），按需启用，天然贴合"密码/NLA+TLS+文本剪贴板+重连"裁剪 | 全功能桌面客户端库，裁剪需在构建/绑定层做减法 | 按需，但成本不成比例 |
| 与本仓库先例一致性 | 与 VNC"Rust 引擎 + 插件层加固"先例一致 | 无先例 | 无 |

**结论倾向**：Rust 路线（IronRDP 系）在许可证、栈契合、审计面、裁剪匹配上全面占优；FreeRDP 仅在"需要极成熟 CredSSP/多平台音频重定向"等超出本插件裁剪范围的需求下才有意义。最终裁决进 §8 决策项 2。

## 8. 需人工决策项（不阻塞本材料合入）

| # | 决策项 | 选项与建议 | 建议裁决时点 |
| --- | --- | --- | --- |
| 1 | fork 链维护责任人 | 指派具 Rust + Windows 认证协议背景的维护者；无则 Route B 缓行 | RDP 立项评审会 |
| 2 | 引入路线 A/B/C | spike 已执行（§3）：两项注入点上游均未暴露，Route A 不成立；建议裁决采纳 **Route B**，并按 §5 回灌优先向上游提 PR（CLIPRDR 注入项有上游 FIXME 背书，优先） | RDP 立项评审会 |
| 3 | Win7 兼容子链（windows-core / webview2-com-sys）是否继承 | 本插件无 Win7 目标，建议不继承 | Route 裁决同轮 |
| 4 | 剪贴板范围确认 | 沿范围裁剪取 text-only（NyaTerm 同款）；富文本/文件剪贴板不做 | 实现排期前 |
| 5 | 重连策略参数 | 沿 NyaTerm 默认 5 次与**按错误类型门控**语义（认证类失败不自动重连，`classify_connector_error` / `classify_session_error` + `allow_reconnect` 先例）为起点，退避节奏实现时定 | 实现排期前 |
| 6 | 带宽压测方案 | P3-4 第三项材料（帧率/延迟/带宽档位），属实现轮，与本文分离派发 | RDP 实现立项时 |
| 7 | TLS 后端选型 | Windows Schannel（native-tls）vs 全栈 rustls；涉协议一致性与审计面，沿 NyaTerm 分平台或统一二选一 | Route 裁决同轮 |
