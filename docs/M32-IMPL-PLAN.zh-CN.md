# M32 实施文档：终端工具条职责归位 + 连接类型补全

> 状态：设计定稿，待实施。基线：integration `9ed6cce2`（M31 收口后）。
> 原则：**终端工具条 = 会话内即时操作；连接管理 = 宿主职责；配置管理 = 设置窗口**。

## 0. 现状事实（逐点核实，实施前请复核）

### 0.1 工具条现状
- toolbar-actions 区（App.vue ~11453 行起）共 **47 个 `<button>`，29 个常驻**（无 v-if）。
- **协议直开图标 4 个**（App.vue 11463-11469 行）：
  - `telnet.open` → `requestTelnet()`（5025 行）
  - `vnc.open` → `requestVnc()`（4717 行）
  - `rdp.open` → `requestRdp()`（4819 行，`rdpExperimental` 门控）
  - `serial.open` → `requestSerial()`（5003 行）
  - 行为：无会话时直接弹对应 ConnectDialog；**有会话时弹互斥确认**（confirm 弹层，4 组共 32 处引用），确认后**替换当前会话视图**——本质是在终端里发起新连接，职责越界。
- `serial.upload.open`（11471 行，`isSerialMode` 才显示）是**会话内动作**，保留。
- **高亮规则**（Popover，App.vue 11657-11716 行，模板 ~60 行 + JS 状态/函数 44 处引用）：含完整编辑器（pattern/color/开关/增删保存），数据走 `ssh/highlightRules/*` RPC。
- **快速命令**（Popover，11562 行起，JS 70 处引用）：Termius Snippets 式三视图（列表/编辑/导入）。
- **sudo 刷新**：`sendSudoRefresh` 纯执行（保留）。
- **快速 sudo profiles**：`openProfilesManager` 打开管理器（→ 设置·sudo 已有编辑器）。
- **端口转发**：PortForwardDialog（连接级、依赖会话上下文，保留）。
- 设置窗口：`SettingsDialog.vue` 9 分类导航（SETTINGS_CATEGORIES，432 行）：appearance/scheme/terminal/hotkeys/sudo/agent/transfer/security/mcp。props 模式 = 权威态在 App、组件只读 + 上抛增量。

### 0.2 连接类型现状
- manifest `contributions[0].fields` 共 34 字段；`protocol` select（index 1）**options 只有 ssh/telnet/vnc**（M9）。
- 后端 `connection/test` 只对 `telnet|vnc` 走 TCP probe 分支（main.rs:309）；`connection/connect` 无 serial/rdp 分支。
- 前端协议路由已通：`openSession()`（App.vue 4193 行起）按 `connectionProtocol` 分发 telnet/vnc → `startXXXFromConnection()`（失败回落 ConnectDialog 预填）。**serial/rdp 缺路由分支**。
- `SerialConnectOptions`：portName/baudRate/dataBits/parity/stopBits/backspaceMode——**无 host/port 语义**，与 TCP 连接表单不同构。
- RDP experimental 门控：`rdpExperimental`（SettingsDialog 有开关，update:rdpExperimental emit）。

## 1. M32-A：终端工具条职责归位（纯前端）

### A1. 移除 4 个协议直开图标
- 删 App.vue 11463-11469 行 4 个按钮；`requestTelnet/requestVnc/requestRdp/requestSerial` 函数体保留但改为**仅供连接路由降级路径使用**——实际上连接路由用的是 `startXXXFromConnection`，这 4 个 request* 函数与对应 confirm 弹层（32 处引用）一并删除。
- 保留 Dialog 组件与 `startXXXSession`（M32-B 的 openSession 路由回落弹窗仍用）。
- i18n 清理：`telnet.open/vnc.open/rdp.open/serial.open` 键保留（M32-B 连接路由回落弹窗标题仍可复用）或标记 deprecated——实施时按实际引用决定，宁可保留不可漏删引用。
- 回归面：`localUiMode` gate 链不动；`isXXXMode` computed 不动（sessionPillText 等仍在用）。

### A2. 高亮规则 → 设置·终端
- 新组件 `frontend/src/components/HighlightRulesSection.vue`：把弹层模板 + JS（44 处引用中的编辑器部分）迁入，props = `{ rules, saving, limit }`，emits = `save(rule) / delete(id)`——**数据面（ssh/highlightRules/* RPC 调用）留在 App.vue**（SettingsDialog 现有模式：权威态在 App）。
- App.vue 删弹层模板 + 编辑器草稿状态，保留 `loadHighlightRules`/`compiledHighlightRules`（渲染仍需要）。
- SettingsDialog「terminal」分类（terminalBehavior 区域后）新增「高亮规则」节，接线新组件 + 新 props/emits。
- 工具条按钮移除（无"启停开关"简化版——高亮规则本身逐条带 enabled 开关，全局开关是过度设计）。

### A3. 快速命令拆分：执行留工具条，管理进设置
- 保留工具条：Popover 列表态 + 点选执行（高频）。
- 新组件 `QuickCommandsSection.vue`（编辑器 + 导入两个子视图迁入），SettingsDialog「terminal」分类新增「快速命令」节；props/emits 同 A2 模式（数据面 quick-commands RPC 留 App）。
- 工具条弹层删「新建/编辑/导入」按钮，只留列表 + 搜索 + 执行。

### A4. 快速 sudo profiles 管理入口 → 设置·sudo
- 工具条 `openProfilesManager` 按钮移除；SettingsDialog `sudo` 分类已有编辑器，把 profiles 管理列表入口在设置内补足（现有 profilesOpen prop 已支持，确认即可）。

### A5. 预期收益
- 常驻按钮 29 → **~25**（-4 协议直开 -1 高亮 -1 profiles 管理）；弹层内不再有配置编辑器；"新建连接"入口唯一化（宿主连接管理）。

## 2. M32-B：连接类型补全（manifest + 路由，轻量）

### B1. manifest protocol options 补 serial/rdp
- `contributions[0].fields[1]`（protocol select）options 追加：
  - `{ label: "Serial", value: "serial" }`
  - `{ label: "RDP (experimental)", value: "rdp" }`
- description 更新（去掉 "not offered as a connection profile" 的旧表述）。
- 新增字段组（带 `visible_when: { field: "protocol", equals: ... }`，仓库已有 30 条 visible_when 先例）：
  - serial 组：`serial_port`（text，占位 /dev/ttyUSB0 或 COM3）、`serial_baud`（select：9600/19200/38400/57600/115200/230400，默认 115200）、`serial_data_bits`（select 7/8）、`serial_parity`（select none/even/odd）、`serial_stop_bits`（select 1/2）、`serial_backspace`（select del/ctrl_h）——对齐 SerialConnectOptions。
  - rdp 组：`rdp_domain`（text）、`rdp_resolution`（select 或宽/高）、`rdp_certificate_policy`（select）、`rdp_clipboard`（bool）——对齐 RdpConnectOptions。
  - SSH/Telnet/VNC 专属既有字段（private_key/totp/triggers 等）补 `visible_when` 排除 serial/rdp（**回归面**：现有 34 字段的 visible_when 需逐条核对，30 条既有规则只覆盖 telnet/vnc，新增两个值后默认显示的字段（如 host/port/password）需要加排除条件或保留共用——**host/port 对 telnet/vnc/rdp 共用、serial 隐藏**）。
- 注意：manifest.json 是守卫敏感文件——本批是**用户明确要求的连接类型完善**，属于获得授权的修改；仍需人工 review 后合并。

### B2. 前端路由扩展
- `App.vue:1698` protocol 归一化扩展：`raw.protocol === "serial" || raw.protocol === "rdp"` 两个合法值。
- `openSession()`（4193 行起）补两个分支：
  - `serial` → 新 `startSerialFromConnection()`（从连接 config 读 serial_port/baud/… 组装 SerialConnectOptions → `startSerialSession`；失败回落 SerialConnectDialog 预填——与 telnet/vnc 同模式）。
  - `rdp` → 新 `startRdpFromConnection()`（同模式 → `startRdpSession`）。
- 后端不动：serial 走既有 `serial/*` 方法族；`connection/test` 对 serial/rdp 的 TCP probe 分支扩展一行（`endpoint.protocol == "serial"` 时跳过 probe 返回"本地设备，连接时校验"；rdp 走 TCP probe）。
- 会话 pill（1712 行起）已支持 serial/rdp 显示，零改动。

## 3. 验证矩阵（实施后必跑）
| 项 | 基线 |
|---|---|
| vitest | 115 文件 / 1133 用例，只增不减 |
| vue-tsc --noEmit | 0 错 |
| pnpm build | 成功 |
| cargo test --locked | 1000/1000（B1 动 manifest 后 validate_repo 必跑） |
| clippy -D warnings / fmt --check | 0 |
| 容器 smoke | 83/0/0 |
| validate_repo.py（manifest 契约） | PASS |
| 手测清单（人工门） | ① 4 协议图标移除后 Telnet/VNC 连接从宿主建连路由正常 ② 高亮规则设置内增删生效且终端渲染生效 ③ 快速命令设置内编辑/工具条执行 ④ serial/rdp 连接记录创建→打开→会话路由 ⑤ 「更多」弹层各项可达 |

## 4. 拆分与并发
- **M32-A**（纯前端，App.vue + SettingsDialog + 新组件）：A1-A4。规模 ~600 行迁移级改动。
- **M32-B**（manifest + App.vue 路由 + 后端 test 一行）：B1-B2。规模 ~250 行。
- **冲突预判**：两批都碰 App.vue——A 动 toolbar 区（11453+），B 动 1698/4193 区与 manifest；合并冲突概率低但 PROGRESS 尾部必冲突（惯例融合）。串行合并：A 先 B 后。
- **风险**：manifest 改动由用户明确要求（连接类型完善），仍标注需人工 review；serial 的宿主侧设备透传边界维持现状（serial/* 方法族不变）。
