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
   advanced_options × authentication × password_source × sudo_source ×
   auth_flow_mode × read_only × triggers_enabled × 六种凭据取值（30,720
   组合），断言
   「表单拦下 ⇒ 解析层也必须拒绝」（否则就是死锁）且「表单放行而解析层拒绝 ⇒
   报错必须点名表单字段」；`credential_requirements_are_form_satisfiable`
   锁住"凭据不得静态必填、必填必须挂在用户可切换的选择器上"；
   `password_source_is_honored_by_the_parser` 锁住三种来源语义。前端契约脚本
   `scripts/connection-forms/verify.mjs` 同步断言七语描述与 credential 契约。

仍未修（宿主契约能力上限，不改表单）：`read_only=true` 时 sudo 块照常显示
（需宿主多条件 `visible_when`）；私钥"路径∨内容"仍无选择器，因此只能在连接
时报错（文案已点名两个字段），后续可仿 `password_source` 增加来源选择器。
