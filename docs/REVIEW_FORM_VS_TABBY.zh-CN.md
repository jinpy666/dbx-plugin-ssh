# SSH 连接表单对标 Tabby 评审（2026-09-05）

对标对象：Tabby `tabby-ssh/src/components/sshProfileSettings.component.pug` +
`profiles.ts`（General/Ports/Advanced/Ciphers/Colors/Login scripts/Input 七页签）。
评审范围：manifest 连接表单 21 字段、`model.rs from_lifecycle_params` 校验、
显隐组合（宿主 `PluginFieldCondition` 单字段 one_of 契约）。

## 一、结论综述

认证与 sudo 编排（全局 Quick Sudo、TOTP 防重放轮换、sudo 白名单、只读门禁、
2FA 自动应答）**强于 Tabby**；连接拓扑（跳板/代理）由**宿主传输层覆盖**（见 §三）；
高级项（算法协商、登录脚本、X11/agent forwarding、-L/-R 端口转发）存在差距，
多数建议登记 deferred。三个表单缺陷见 §二 P1。

## 二、问题清单

### P1 表单缺陷（插件侧可修）

1. **`sudo_whitelist` 用单行 `text` 承载多行内容**：描述写 "one entry per line"，
   text 输入框无法正常输入/粘贴多行。宿主契约有 `textarea` 类型，改类型即可。
2. **`read_only=true` 时 sudo 块照常显示**：字段描述声明 "Ignored on
   read-only"，但 7 个 sudo 字段原样露出、配了不生效。根因：宿主
   `PluginFieldCondition` 只支持单字段 `one_of`，无法表达
   "sudo_source=custom 且 read_only=false"。短期在 description 注明互斥；
   长期提宿主契约多条件。
3. **登录期 keyboard-interactive 无兜底指路**：无 TOTP secret 时服务器只发 KI
   密码提问 → 自动应答无从发生、认证失败，用户不知道配哪里。连接失败错误
   文案应指路（"请在 2FA/TOTP 字段配置应答"）。（Tabby 有 Interactive 面板，
   插件以自动应答编排替代，缺的是失败时的可发现性。）
   **2026-09-16 已修**（issue #17/#30）：KI 失败信息现在带上服务器实际提问
   （`name`/`instructions`/提问文本）并指路"配置 TOTP 密钥或 OTP 提示词"；
    `password_then_otp` 的首因子判定、koko 提问识别与提示词优先级同步修复，
    见 `docs/PROTOCOL.zh-CN.md`「登录期 2FA」与 `scripts/smoke_login_mfa_test.py`。
   **2026-09-17 表单文案与顺序**（同一 issue 的二次反馈）：`Off` 选项由
   "手动输入 OTP"改为"不自动应答 OTP"（插件没有手工应答通道，旧文案名不副实）；
   `2FA` 说明补选型指引（先问验证码 / 合并提问请选「密码与 OTP 合并」）；
   `totp_prompt_hint` 前移到 `password_prompt_hint` 之前（#30 用户是把
   `OTP Code` 填进了密码提示词），两处提示词说明补"填错字段不会生效"；
   TOTP 密钥说明点明同时服务登录期 MFA。七语本地化同步更新。
   **2026-09-17 表单信息架构（同一问题的第三轮）**：`sudo_source` 与
   `auth_flow_mode`（2FA）不再位于「显示高级选项」之后——它俩连同明细字段
   原本被一个默认关闭的开关整体隐藏，用户根本找不到 MFA 配置位置，这正是
   #17/#30 反复出现"不知道去哪配"的结构性原因。现在两个入口常显（默认
   `off`，默认表单只多两行），明细仍按来源/模式按需展开；`advanced_options`
   移到 sudo/2FA 块**之后**，只收起超时/保活/环境变量/自动应答/只读，说明
   也改成列出内容。顺带确认：宿主已支持 `all_of`/`any_of`/`not` 复合条件，
   但 `not` 要求操作数本身**可见**，所以"只读连接隐藏 sudo 明细"这类规则在
   `read_only` 仍属高级字段时表达不出来（求值恒为假），继续以字段说明兜底。
   **2026-09-17 第四轮（宿主分组能力落地后）**：`advanced_options` 全局开关
   正式退役——宿主新增字段级 `group`（可折叠分区，标题常显、带已填计数）与
   `options_style: "suggest"`（输入 + 建议，用于"全局 Quick Sudo 配置"这类
   既可手输又可选的字段）。表单改为四分区：Sudo 凭据 / 2FA（默认展开）、
   终端与自动化 / 超时·保活·只读（默认折叠）；`sudo_source` 默认值刻意保持
   `custom`——空 sudo 密码会回退登录密码，改默认等于静默关掉"用登录密码应答
   sudo 提示"，所以只改展示不改行为。字段排版问题（P3-7「21 字段平铺无分组」）
   至此由宿主契约解决，不再需要短期文案合并的权宜手段。
   **2026-09-17 第五轮（卡片层）**：在分区之上再加一层宿主 `panel` 卡片
   （基本信息／身份与安全／高级选项，带内置图标、标题常显、可折叠，高级默认
   折叠），表单形成「卡片 → 分区 → 字段」三级阅读层级；字段可只属于卡片、
   只属于分区或两者都不属于，渲染与旧行为兼容。
   **2026-09-17 第六轮（卡片改页签）**：三级嵌套被判定过深——外层由卡片改为
   **页签**（宿主 `panel.presentation: "tabs"`，页签不折叠、一次只看一组），
   内层分区标题改为整行浅底 + 右侧已填计数，字段块紧随其下；`cards` 仍是宿主
   默认渲染，其他插件不受影响。

### P2 功能缺口（对标差距）

4. ~~跳板机表单入口~~ **修订：非缺口**，见 §三。插件 `external_config.jump_hosts`
   保留为高级能力（宿主隧道覆盖不了的场景），**表单不加字段**（硬性规则 3）。
5. **连接级启动命令（Tabby Login scripts）**：`startup_commands`（textarea 每行
   一条），PTY 就绪后按序键盘语义写入。与批量发送/快速命令闭环，插件可自助。
6. **认证 Auto 模式**：Tabby 有 Auto（依次尝试）；插件显式五选一。可加
   "Auto (key, then password)"，`method_offered` 探测逻辑已有。

### P3 体验

7. 21 字段平铺无分组（Tabby 页签式）：sudo 7 件套占半屏。宿主契约加分组/折叠；
   短期合并 `*_prompt_hint` 的 label/描述。
8. `port`/`connect_timeout_secs` 无 min/max 提示（契约无 min/max 属性，用
   placeholder+description）；后端 connect_timeout 只 `max(1)` 无上限。
9. `display_name` 默认 "SSH server" 易重名；建议 description 推荐
   `user@host:port` 命名（Tabby getSuggestedName 同思路）。
10. username 必填（Tabby 支持 "Ask every time"）：需宿主连接模型允许空，低优。

### 维持不做 / 归宿主

- **-L/-R 端口转发**（Tabby Ports 页签）：宿主已有传输层隧道与本地转发端点
  机制（`proxy_connection_uses_local_forward_endpoint`），-L/-R 用户面功能的
  自然归属是宿主；插件不重复（硬性规则 3）。FEATURE_PARITY deferred 行已注记。
- **X11 / Agent forwarding**：后端未实现（russh 成本高），登记 deferred。
- **算法协商（Ciphers/KEX/HMAC/压缩）**：2026-09-15 起不再提供用户档位——每条
  连接一律协商全量支持面（`ssh_algorithms::preferred`）：现代套件保持首选，
  hmac-sha1、SHA-1 DH 固定组（group14 在 GEX-SHA1 之前）、AES-CBC、3DES 按
  弱到强追加尾部；DH GEX 组大小界对齐 ssh(1)（2048/3072/8192），修复老设备
  模数 ≤2048 位时 GEX 握手中止的问题。
- **配色 per-profile**：宿主外观域。
- **OpenSSH config 导入**：Tabby 有 importer；可后置（宿主隧道 UI 已支持
  ssh config host 别名预填，部分覆盖）。

## 三、宿主转发能力核实（修订 2026-09-05 初版评审）

初版把"跳板机"列为插件表单缺口，核实后**定性修正**：

- 宿主 `TransportLayerConfig` = `ssh`（SSH 跳板）/ `proxy`（SOCKS）/ 
  `http_tunnel`（HTTP CONNECT）三种传输层隧道；proxy 底层经本地转发端点
  （connection.rs 测试 `proxy_connection_uses_local_forward_endpoint`）。
- 连接对话框"SSH 隧道"页签对**插件连接同样可用**（`canUseTransportLayers`
  不排除 `db_type=plugin`），UI 为 TunnelProfileManager（隧道 profile 复用、
  ssh config host 别名预填）。
- 转发后的本地端点与所有数据库类型同路径注入：连接池建立时把解析出的
  `host/port` 传给 `plugin_host.connect_connection`，进插件 lifecycle 的
  `runtime.host/port`；sidecar 用 runtime 拨号、用原始 `connection.host/port`
  做主机密钥校验（PROTOCOL"生命周期与状态隔离"已承诺，插件已实现）。
- 因此 Tabby 的 Connection mode（Direct/Jump host/SOCKS/HTTP proxy）四模式
  宿主全部覆盖（proxyCommand 除外），插件表单**不需要也不应该**自建跳板字段。
- 插件 `jump_hosts` 的差异化价值：≤3 跳链、逐跳独立认证/2FA/主机密钥校验；
  宿主 `SshTunnelConfig` 是单跳、仅密码/密钥。jump_hosts 保留为 API/高级能力
  （配置后整链替换 runtime 隧道），FEATURE_PARITY 注明分工。

## 四、建议落地顺序

1. P1-1 whitelist 改 textarea（一行）；P1-3 失败文案指路；P1-2 description 注明。
2. P2-5 启动命令（插件自助，走 IMPL_PLAN 流程）。
3. P2-6 Auto 认证。
4. P3 各项随宿主契约演进。

## 五、2026-09-16 修复标注（表单保存报错）

用户侧症状是"保存报错"。核对宿主实现后确认：宿主连接对话框能产生的保存期
文案只有 `connection.pluginRequiredField`（"请填写{字段}"），且保存/保存并
连接按钮在「可见 ∧ 必填 ∧ 为空」时本来就是禁用的（`pluginFieldConditions.ts`
+ `ConnectionDialog.connectionConfigForSubmit`）。因此真正的报错来自
`保存并连接` 之后的 test/connect：宿主 Rust 层
（`validate_plugin_connection_values_for_action`：必填、值类型、`port` 绑定
1..65535、`connection_secrets` 必须声明为 secret）与 sidecar
`from_lifecycle_params`（凭据规则）各校验一遍。穷举 960 个表单状态后，唯一会
**卡死保存**的是 `password` 的 `required_when`，本轮修复如下：

1. **登录密码改为显式「密码来源」二选一（P1，标准产品做法）**：密码类的真实
   规则是 OR——`password` ∨ `password_command`（D9 外部密码管理器），而宿主
   契约只能表达单字段 `required_when`，写死"密码必填"会让"留空 + 密码命令"
   的连接**根本保存不了**（按钮灰掉且没有任何解释）。修法是把它变成用户可
   显式选择的一个字段：新增 `password_source`（`direct`/`command`，默认
   `direct`，仅密码类认证可见），`password` 与 `password_command` 分别挂在
   两个取值上做 `visible_when` + `required_when`——既恢复"选中即必填"的严格
   校验，又没有死路（换个来源即可）；`password_command` 随之从高级区搬到凭据
   区。解析层照来源执行：`direct` 缺密码、`command` 缺命令都直接报错并点名
   两个字段；`command` 模式下存量密码让位，保证用户选定的命令真的执行；没有
   来源字段的老配置（0.4.x 与 MCP 内联参数）保持原 OR 语义，**不需要重存也
   不会被卡住**，重开表单时把「密码来源」选回「本地命令取回」即可（本机
   DB 中 0 条连接用到该功能）。
2. **私钥"路径或内容二选一"文案指路（P1）**：同样无法在契约里表达 OR，
   保持两个字段都不 required；`private_key_path` / `private_key` 的 7 语描述
   明确"至少填一项，内容优先于路径"，sidecar 报错点名
   `"Private key path"` / `"Private key content"`。选私钥认证却什么都不填时，
   保存会成功，随后在连接/测试阶段报出可操作的错误（这是契约能力上限，不是
   可修的表单 bug）。
3. **端口范围提示（P1）**：`port` 只受 `type: number` 约束，宿主 Rust 层与
   sidecar 各自校验 1..65535（填 0 会"保存成功、连接报错"）。契约无 min/max
   属性，改在 7 语 description 写明范围与默认值。
4. **依赖下限（P2）**：`engines.dbx` 从 `>=0.5.77` 抬到 `>=0.6.14`——条件
   显隐/条件必填是宿主 0.6.14 才实现的能力，低于该版本的表单会平铺全部字段、
   忽略 `required_when`，与本契约声明的行为不符。
5. **回归网**：新增 `model.rs` 契约测试
   `form_save_state_matches_parser_acceptance`——按宿主语义穷举
   authentication × password_source × sudo_source × auth_flow_mode ×
   read_only × triggers_enabled × 六种凭据取值，断言
   「表单拦下 ⇒ 解析层也必须拒绝」（否则就是死锁）且「表单放行而解析层拒绝 ⇒
   报错必须点名表单字段」；`credential_requirements_are_form_satisfiable`
   锁住"凭据不得静态必填、必填必须挂在用户可切换的选择器上"；
   `password_source_is_honored_by_the_parser` 锁住三种来源语义。前端契约脚本
   `scripts/connection-forms/verify.mjs` 同步断言七语描述与 credential 契约。

仍未修（宿主契约能力上限，不改表单）：`read_only=true` 时 sudo 块照常显示
（需宿主多条件 `visible_when`）；私钥"路径∨内容"仍无选择器，因此只能在连接
时报错（文案已点名两个字段），后续可仿 `password_source` 增加来源选择器。
