# RDP CredSSP 安全评审清单（立项材料，Task P3-4 / 差距项 2e）

日期：2026-09-24　分支：`codex/ssh/parity-rdp-docs`　状态：**评审门材料——人工评审用检查表，不预设结论**。

IMPL_PLAN 将 RDP 列为高风险区（"ironrdp + vendored forks，CredSSP 属高风险区"）。本清单覆盖 CredSSP/NLA 凭据处理评审；fork 链维护计划独立成文：`docs/RDP_VENDOR_FORK_PLAN.zh-CN.md`。

## 1. 范围与评审门

- **适用时点**：RDP 会话实现合入前的立项评审；此后**每次**链内依赖升级（ironrdp* / sspi / picky）或 TLS 栈变更时复评 §5。
- **范围**：CredSSP（NLA）凭据流转、NTLM/Kerberos 协商、TLS 加密与证书策略、已知 CVE 对齐。范围裁剪沿 IMPL_PLAN：密码/NLA + TLS + 文本剪贴板 + 重连；不做音频/驱动器重定向/键盘捕获。
- **评审门位置**：沿 agent-flow 契约，RDP 走独立分支（`codex/ssh/parity-rdp*`），评审通过前不进 integration，agents 不自合 PR。
- **对照基线**：NyaTerm `src/core/rdp.rs` + `src/config/connection.rs`（`RdpSecuritySettings`：`use_nla` 默认 true、`certificate_policy` 默认 `prompt`）。

## 2. 协议事实基线（评审共同语言）

- CredSSP 在 TLS 之上承载 TSRequest；NLA 即经 CredSSP 的认证。**CredSSP 的设计前提是：客户端仅在完成服务器身份验证后才向服务器发送凭据**——服务器验证失败的强度因此决定整个安全模型。
- SSP 协商：客户端通常以 Negotiate（SPNEGO）发起，域环境可落 Kerberos，非域/回退场景基本落 **NTLM**。本插件目标用户（个人/运维直连）以 NTLM 路径为主——NTLM 的已知弱点必须按 §3-A 显式处理，不能假设"有 Kerberos 兜着"。
- 凭据委托模型：CredSSP 成功即**把用户密码实质交付给目标主机**。这与 SSH 的"私钥不出本机"模型有本质差异，是 §3-B 最小化要求的根据。
- 事实来源：[MS-CSSP]（CredSSP）、[MS-NLMP]（NTLM）、[MS-KILE]（Kerberos）；实现以 vendored/上游 `sspi` crate 源码为核对对象，本文不转述超出上述范围的协议细节。

## 3. 检查清单

标记约定：【硬】= 不通过即评审否决；【条】= 可带缓解措施通过，缓解措施须记入评审记录。

### A. NTLM vs Kerberos 约束

- [ ] 【硬】SSP 选择策略显式且 fail-closed：明确 Negotiate 落地行为（Kerberos 不可用时的回退顺序），禁止静默接受未知 SSP。
- [ ] 【硬】禁用 NTLMv1 / LM；仅 NTLMv2。核对 `sspi` 客户端配置面无降级缺口（以当轮 vendored/上游版本源码核实）。
- [ ] 【条】NTLM relay 面：核对 `sspi` 当轮版本对 MIC（Message Integrity Check）语义与 CVE-2019-1040 类缓解的对齐情况（上游 changelog/advisory），结论记入评审记录。
- [ ] 【条】Kerberos 定位为增强项而非阻塞项：非域环境不支持 Kerberos 时，UI/文档明示"当前使用 NTLM 认证"；域内 Kerberos 支持范围（票证获取、缓存策略）作为独立决策项（§6-3）。
- [ ] 【硬】认证失败提示不泄露可区分信息（用户名存在性/密码正确性混合为统一失败语义）；凭据不回显于任何错误文案。
- [ ] 【条】`use_nla` 关闭（退化到非 CredSSP 认证）若保留为高级选项：默认关闭该关闭、开关处七语警示"凭据将以弱化方式暴露"，仅可信网络建议（沿 VNC 安全类型先例）。

### B. 凭据委托范围与最小化

- [ ] 【硬】密码来源沿现有 vault 体系加密存储（`vault.rs` / password binding 先例），不新增明文落盘路径；不写入日志、审计流、错误信息、命令行参数、崩溃报告。
- [ ] 【硬】内存卫生：密码在 sidecar 内存中以清零型容器（`Zeroizing` 族）持有，作用域最小化。已知事实：NyaTerm 将 `Option<String>` 密码 clone 进 connector 配置（`with_password(config.password.clone().unwrap_or_default())`）——本插件实现**不得照搬**该明文 String 常驻面，评审时核对实际代码。
- [ ] 【硬】UI 与文档明示 CredSSP 委托模型："连接即把密码交给目标主机，目标主机被攻破则凭据暴露"；不使用任何暗示"密码仍在本机"的文案。
- [ ] 【硬】不做 SSO / 无约束委托 / 域凭据自动传递；不缓存 CredSSP 上下文跨会话复用；会话关闭即丢弃凭据。
- [ ] 【条】"记住密码"与连接绑定的范围沿现有 SSH 密码语义（本机 vault），不因 RDP 扩大；自动重连（默认 5 次）时的凭据再取用走同一 vault 路径，不内存常驻。
- [ ] 【条】交互式密码输入（连接卡片直填）在 UI 层遮蔽显示，传输走现有 JSON 写通道的既有加密边界；评审核对该通道不落审计日志。

### C. 加密套件与协商策略

- [ ] 【硬】TLS 版本 ≥1.2；rustls 路径默认配置即为安全基线；Windows 若走 Schannel（native-tls），需禁用系统策略中的弱协议版本与旧套件，并核对结果记入评审记录。
- [ ] 【硬】仅 AEAD 套件（AES-GCM / ChaCha20-Poly1305）；禁 RC4、3DES、NULL、EXPORT、匿名（aNULL）套件；RDP 层历史加密（Non-TLS "标准 RDP security"）不启用。
- [ ] 【硬】服务器证书校验 fail-closed：默认策略沿 NyaTerm `prompt`（未知证书弹确认，120s 超时窗拒绝、remember 记录与 SSH host key 先例对齐作用域）；不存在"静默接受任意证书"路径，调试后门除外且构建期隔离。
- [ ] 【硬】CredSSP Encryption Oracle Remediation（CVE-2018-0886 硬化）语义对齐：客户端不允许与旧服务端协商到"易受 oracle 攻击"的兼容级别；对未打补丁的服务端给出可读错误而非降级放行。
- [ ] 【硬】安全层协商（TLS / CredSSP-hybrid）结果固定且可观测（日志记录协商结果，不含凭据）；禁止从 hybrid 静默降级为非 NLA。
- [ ] 【条】TLS 后端选型（Windows Schannel vs 全栈 rustls）在 Route 裁决时定（fork 计划 §8-7），本清单两分支均可执行，仅要求选型后按上两条复核对应后端。

### D. 已知 CVE 检查点（评审动作，非完整结论清单）

以下为**评审时必须执行的复核动作**；具体结论以当轮 NVD / 上游仓库 advisory 为准，本文不维护 CVE 数据库。

- [ ] 【硬】CVE-2018-0886（CredSSP 预认证 RCE / Encryption Oracle Remediation）：核对 `sspi` + `ironrdp-connector` 当轮版本的硬化实现与本文 §3-C 对齐项。
- [ ] 【硬】CVE-2019-1040（NTLM MIC 绕过 / relay 类）：核对 `sspi` 当轮版本 MIC 校验与上游修复历史；关联 CVE（NTLM relay 族）按上游 advisory 一并核对。
- [ ] 【硬】依赖链扫描：`cargo audit`（或等价 RustSec 核对）覆盖 `ironrdp-client` / `ironrdp-connector` / `ironrdp-tls` / `picky` / `sspi` / TLS 后端 crate，零未处置 advisory 方可通过；有则给出升级或豁免理由。
- [ ] 【条】服务器侧漏洞（BlueKeep 等）不在客户端评审范围内，但用户文档保留"仅连接可信主机"警示（沿 X11/VNC 文档先例）。
- [ ] 【条】新增 CVE 响应流程：并入 fork 计划 §4 触发条件 3——CredSSP/NTLM 相关新 CVE 即启动升级评审，不需等待季度例行。

## 4. 评审通过判据

评审**通过**当且仅当：

1. 全部【硬】项逐条 pass，每条有评审记录中的证据指向（代码位置 / 测试 / 上游文档链接）；
2. 全部【条】项要么 pass，要么给出成文的缓解措施与其责任归属；
3. §6 决策项已有裁决或明确挂起归属，无悬空的阻塞级决策；
4. 升级复评场景另需：fork 计划 §6 runbook 的 1–3 步已执行，依赖扫描零未处置项。

评审**否决**触发：任一【硬】项 fail；缓解措施被评审人认定为不充分；发现清单未覆盖的新风险面（此时先扩清单再复评）。

## 5. 评审记录格式（评审产出模板）

```
评审对象：<分支/PR>  基线 SHA：<sha>  日期：<date>
逐项结论：A1..A6 / B1..B6 / C1..C6 / D1..D5 → pass | pass-with-mitigation(<记录>) | fail(<理由>)
证据：<每条硬项的代码/测试/文档链接>
缓解措施：<条件项的缓解与责任归属>
决策项状态：§6 各项 → 已裁决(<结论>) | 挂起(<归属>)
```

## 6. 需人工决策项（不阻塞本材料合入）

| # | 决策项 | 选项与建议 | 建议裁决时点 |
| --- | --- | --- | --- |
| 1 | `use_nla=false`（关 NLA）是否保留为用户可达选项 | 建议：保留但默认隐藏于高级设置 + 七语强警示；或干脆只读为 true（更严） | 立项评审会 |
| 2 | 证书 remember 的作用域（单主机/全局）与存储形态 | 与 SSH host key 已知主机先例对齐 | 实现排期前 |
| 3 | Kerberos 支持范围 | MVP 不做（NTLM-only，文档明示）；域内支持后置独立立项 | 立项评审会 |
| 4 | 域凭据/智能卡等增强认证 | 超出"密码/NLA"裁剪，默认不做 | 与范围裁剪一并锁定 |
| 5 | 评审责任人 | 指派具认证协议背景的人工评审者；无则评审门挂起即 RDP 线挂起 | 立项评审会 |
