# DBX 插件 UI 贡献点体系与宿主交互规范（设计提案 v1）

> **一句话结论**：首版只在现有 5 类贡献点之外增加 `command` 与 `menus`
> 两类，形成 **7 类稳定贡献点**；工具栏、侧栏与命令面板只是 command 的摆放位置，
> 不再各自发明动作类型。底部 panel 由 command 的打开方式决定，不固化在 workbench
> 内容定义上。状态栏、动态 badge、树视图、对象查看器与宿主模态留待运行时状态协议明确后再发布。
>
> **文档状态**：提案（待宿主仓评审）。本文取代
> `HOST_TERMINAL_SURFACE.zh-CN.md` 与 `HOST_UI_CONTRIBUTIONS.zh-CN.md`。
> 首个消费者——SSH 插件本地终端——见 §8。
> 面向最终宿主 PR reviewer 的三方对齐、PR 切片和否决门见
> [`HOST_PLUGIN_UI_PR_REVIEW_GUIDE.zh-CN.md`](./HOST_PLUGIN_UI_PR_REVIEW_GUIDE.zh-CN.md)。
>
> **规范用词**：必须/不得表示发布契约；应当表示强烈建议；可以表示可选行为。

---

## 1. 背景与现状

### 1.1 已确认的宿主事实

| 事实 | 出处 |
| --- | --- |
| 当前仅有 `connection-provider`、`workbench`、`filesystem-provider`、`context-menu`、`result-view` 5 类贡献点 | `crates/dbx-plugin-runtime/src/plugins/manifest.rs:227` |
| Manifest v1 对未知贡献类型和已知类型的未知字段均严格拒绝 | 同上 `:226`、`:111/:120/:129` |
| `workbench` 当前只定义内容入口，不定义工具栏、侧栏或 panel 摆放 | 同上 `:638` |
| 插件中心可以无连接打开 workbench，但不会自动生成某个插件私有的模式 context | `PluginContributionsPanel.vue`、`queryStore.openPluginWorkbench` |
| `window.dbxPlugin.openWorkbench` 只能打开本插件贡献点，桥已绑定插件身份 | `pluginHostBridge.ts` 与 Host API 1.x |
| 当前 tab 复用主要按 `pluginId + contributionId + connectionId` 判定 | `queryStore.ts:3484` |
| 工具栏显隐与设置搜索已有统一数据源，溢出项进入 More 菜单 | `settingsStore.ts`、`settingsSearch.ts`、`AppToolbar.vue` |
| 无连接 tab 的崩溃恢复行为尚无完整回归矩阵 | `queryStore.reconnectRestoredPluginTabs.spec.ts` |

### 1.2 要解决的问题

1. 插件无法声明宿主工具栏、侧栏、命令面板和底部 panel 的入口。
2. 现有动作语义分散：工作台打开、连接表单 action、连接右键 action 各走不同路径。
3. 新贡献点缺少安全的版本协商与降级规则。
4. 插件自定义 context 与宿主生命周期字段尚未形成明确的所有权边界。

### 1.3 非目标

- 首版不把 `connection-provider.actions` 或 `context-menu` 强行迁移成 command；它们有独立的表单、连接上下文和响应语义。
- 首版不允许 command 任意调用 Sidecar RPC。
- 首版不发布动态状态栏、badge、原生树视图或后台模态 API。
- 宿主不实现 PTY、SSH 或业务协议；宿主只提供容器、入口和生命周期。

---

## 2. 设计原则

1. **command 是通用宿主入口的动作原子**：命令面板、工具栏、侧栏和默认快捷键只引用 command。
2. **表面与内容分离**：workbench 定义内容；`menus` 定义入口放在哪里；command 定义点击后做什么。
3. **领域动作不强行抽象**：连接表单 action 和连接生命周期继续使用现有专用契约，直到通用 command 能完整表达其输入与输出。
4. **宿主身份不可由插件声明**：插件 ID、workbench 实例 ID、surface、restored 等均由宿主产生或覆盖。
5. **首版严格、未来按 feature 降级**：A1 不引入逐条 `optional`；未来可选能力以完整 feature fragment 为最小降级单元。
6. **声明不等于激活**：静态入口不得启动 Sidecar；打开 workbench 或执行未来 RPC command 时才激活。
7. **可见与可执行分离**：placement 决定是否显示；command enablement 决定显示后能否执行。
8. **运行时对象必须有作用域**：连接、workbench、command invocation 和插件进程各自拥有明确的关闭与回收边界。

---

## 3. 贡献点体系

### 3.1 首版稳定类型：5 + 2 = 7

| 类型 | 处置 | 说明 |
| --- | --- | --- |
| `connection-provider` | 保留 | 连接表单、Secret、连接生命周期和专用 actions |
| `workbench` | 保持内容定义 | 不增加固定 `surface` 字段 |
| `filesystem-provider` | 保留 | 通用文件管理器协议 |
| `context-menu` | 首版保留 | 仍调用 `contextMenu/<id>`；未来满足无损迁移条件后再弃用 |
| `result-view` | 保留 | 结果快照入口 |
| `command` | 新增 | 通用、静态、宿主可展示的动作定义 |
| `menus` | 新增 | 把 command 摆放到宿主位置 |

### 3.2 后续候选类型（不属于 v1 发布面）

| 候选 | 发布前置条件 |
| --- | --- |
| `status-bar-item` | 动态状态更新、激活、限流、清理协议完成 |
| `view-container` / `view` | 视图生命周期、懒加载、选择与菜单事件协议完成 |
| `object-viewer` | 资源类型注册、open-with 选择和数据上限完成 |
| `viewsWelcome` / `badge` | 所属 view/container 契约先稳定 |

`toolbar-item` 不作为独立贡献类型：工具栏项是 `menus.location = "appToolbar"`。
`keybinding` 首版也不作为独立贡献类型；默认键位在宿主键位体系完成冲突治理后再作为 command 的摆放方式增加。

---

## 4. `command` 规范

### 4.1 v1 唯一动作：`open-workbench`

```json
{
  "type": "command",
  "id": "open-local-terminal",
  "label": "Local terminal",
  "description": "Open a local terminal.",
  "icon": "assets/local-terminal.svg",
  "action": {
    "type": "open-workbench",
    "workbench": "io.dbx.ssh.workbench",
    "presentation": "tab",
    "reuse": "singleton",
    "instance_key": "local-terminal",
    "restore": "none",
    "context": {
      "plugin": { "mode": "local-terminal" }
    }
  }
}
```

字段规则：

- `id` 在插件内唯一；宿主内部规范化为 `${pluginId}.${id}`。
- `label`、`description`、`icon` 复用现有贡献点国际化和资产规则。
- `action.type` v1 只能是 `open-workbench`。
- `workbench` 必须引用同插件已经声明的 workbench。
- `presentation`：A1 只接受 `tab`；§8.3 BottomDock 上线后新增 `panel` 枚举值，使用它的插件必须提升最低宿主版本。缺省 `tab`。
- `reuse`：
  - `singleton`：复用相同 command 实例；
  - `new`：每次由宿主创建新实例。
- `instance_key` 仅用于 `singleton`，宿主以
  `pluginId + commandId + presentation + instance_key` 形成复用键；插件不得直接提供 `workbenchId`。
- `restore`：A1 只接受 `none`；Runtime 里程碑再增加 `placeholder`、`state`、`reattach`，完整语义见 §7.6。缺省 `none`。
- `context` 必须是 JSON 数据；插件载荷放在 `context.plugin`，不得写宿主保留字段。
- 宿主必须在最终 context 中注入权威的 `workbenchId`、`restored`、`surface`，并在适用时注入 `connectionId`。

command 可以声明 `enablement`，其结构与 §5.3 的条件对象一致。宿主必须只基于当前 context 快照求值，不得为了绘制菜单同步调用 Sidecar。

### 4.2 v1 不包含 RPC command

不得用 `dispatch: "rpc"` 之类的预留值制造“已声明但当前不可执行”的状态。
未来若增加 Sidecar command，使用新的判别动作，例如：

```json
{ "action": { "type": "invoke-sidecar", "method": "..." } }
```

该动作必须随新的 Host API/Manifest 版本发布，并同时定义权限、确认、审计、超时、取消和来源标识。旧的 `open-workbench` command 永远不得被重新解释成 RPC。

### 4.3 与领域动作的边界

- `connection-provider.actions` 保持现状：继续接收未保存表单、Secret 安全视图并允许返回 `fieldValues`。
- `context-menu` 保持现状：继续携带非敏感连接摘要并调用 `contextMenu/<id>`。
- 只有新 command 能完全覆盖旧动作的输入、输出和安全语义时，才允许启动弃用流程。

---

## 5. `menus` 规范

### 5.1 v1 位置词表

- `commandPalette`：命令面板；
- `appToolbar`：主工具栏；
- `appSidebar`：侧栏插件入口区。

连接右键、对象树、数据网格、编辑器标题和 tab 右键等上下文位置，待 command 上下文注入规则完成后再逐项增加。位置名一旦发布只能新增，不能改名或改变语义。

### 5.2 示例

```json
{
  "type": "menus",
  "id": "global-entrypoints",
  "items": [
    {
      "location": "commandPalette",
      "command": "open-local-terminal",
      "group": "primary",
      "order": 100
    },
    {
      "location": "appToolbar",
      "command": "open-local-terminal",
      "default_visible": false,
      "group": "navigation",
      "order": 100
    },
    {
      "location": "appSidebar",
      "command": "open-local-terminal",
      "default_visible": true,
      "group": "primary",
      "order": 100
    }
  ]
}
```

规则：

- `command` 引用本插件 command 的短 ID；跨插件引用禁止。
- `appToolbar`/`appSidebar` 是持久 chrome，必须进入设置显隐和设置搜索；`commandPalette` 不生成单独的外观开关。
- 插件工具栏项缺省隐藏；每个插件最多一个 `default_visible: true` 的工具栏项。
- `group` 只能使用宿主发布的稳定词表：v1 为 `navigation`、`primary`、`secondary`、`destructive`。
- `order` 是 group 内的整数排序键；相同值按全限定 command ID 稳定排序。插件不得声明任意全局 group，也不得使用 before/after 指向另一个插件。
- 宿主必须对 command 数量、menu item 数量、label/description/context 长度和图标资源设置上限；具体值在 Schema PR 中冻结并进入 conformance 测试。
- 所有宿主渲染的插件入口必须显示插件来源或可访问的来源提示，避免伪装成宿主内置命令。
- 国际化只使用现有顶层 `localizations.<locale>.contributions.<id>`，不得新增 `label_i18n` 平行机制。

### 5.3 `when` 条件

v1 不引入字符串表达式语言，使用可由 JSON Schema 校验的结构化条件：

```json
{
  "when": {
    "all": [
      { "key": "connection.state", "operator": "equals", "value": "connected" },
      { "key": "object.type", "operator": "oneOf", "value": ["table", "view"] },
      { "key": "readOnly", "operator": "notEquals", "value": true }
    ]
  }
}
```

- v1 operator：`equals`、`notEquals`、`oneOf`；`all` 内隐式 AND。
- v1 宿主 key：`connection.state`、`object.type`、`surface`、`readOnly`。
- `when`/`enablement` 缺省为 true；条件中引用不存在的 key 时，该 predicate 对所有 operator 均求值为 false。
- key 和 operator 为宿主保留词表；A1 遇到未知值时整个 Manifest 校验失败。
- 新 operator/key 是增量契约，但使用它的插件必须声明相应的最低宿主版本。

### 5.4 可见与可执行

- `menus.items[].when` 控制当前 placement 是否可见；同一个 command 在不同位置可以使用不同的 `when`。
- `command.enablement` 控制 command 是否可执行；所有 placement 共用同一 enablement。
- placement 可见但 command 不可执行时，支持 disabled item 的表面必须显示禁用态；不支持禁用态的表面可以隐藏，但行为必须进入表面降级矩阵。
- command 真正执行前必须重新校验 enablement，不能只相信上一次渲染结果。
- 需要网络、磁盘或 Sidecar 状态才能判断的条件不能进入同步 enablement；执行后由业务层返回可理解的拒绝原因。

---

## 6. Manifest 解析、版本协商与降级

### 6.1 不能追溯修复旧宿主

旧宿主仍然会拒绝它不认识的新字段和贡献类型。首次引入本规范必须遵循：

1. 宿主先发布支持新 envelope/贡献类型的版本；
2. 插件随后提升 `engines.dbx` 或 `engines.host_api` 下限；
3. 新宿主从此以后才能对未来 Manifest v2 的可选 feature fragment 执行安全降级。

不得声称“插件可以天然领先所有旧宿主发布”。

### 6.2 解析顺序

新宿主必须按以下顺序处理 Manifest：

1. 从原始 JSON 读取最小 envelope：`manifest_version`、`id`、`version`、`publisher`、`engines`；
2. 先执行版本门槛检查，版本不足时返回明确的“不兼容宿主版本”，不得落成泛化 JSON 解析错误；
3. 再逐条解析 contributions；
4. 执行 ID 唯一性、引用图、权限和资源路径校验。

### 6.3 A1 不引入逐条 optional

首个 `command + menus` PR 继续使用严格 Manifest：未知类型、未知字段、未知枚举、格式错误和悬空引用均拒绝安装。插件使用新贡献点时必须提升最低宿主版本。

这样做的理由是：逐条跳过会破坏 command、menus、workbench 之间的引用图，也会把字段拼写错误伪装成正常降级。A1 的兼容边界必须简单到 reviewer 可以穷举。

### 6.4 后续 feature fragment（Manifest v2 候选）

跨 Desktop/Web、不同宿主能力的可选功能应以完整 feature 为降级单元，而不是在每条 contribution 上增加 `optional`：

```json
{
  "manifest_version": 2,
  "features": [
    {
      "id": "bottom-panel",
      "optional": true,
      "requires": {
        "host_capabilities": ["ui.panel"]
      },
      "contributions": [
        { "type": "command", "id": "open-local-panel", "label": "Local terminal panel", "action": { "type": "open-workbench", "workbench": "io.dbx.ssh.workbench", "presentation": "panel", "reuse": "singleton", "instance_key": "local-terminal-panel", "restore": "none" } },
        { "type": "menus", "id": "panel-entry", "items": [{ "location": "appToolbar", "command": "open-local-panel", "group": "navigation", "order": 100, "default_visible": false }] }
      ]
    }
  ]
}
```

- feature 内部单独执行严格 Schema、ID 和引用图校验。
- capability 不满足且 feature optional 时，整体跳过并展示一次可理解警告。
- capability 满足但 feature 自身格式错误时仍拒装，不能降级掩盖作者错误。
- 核心 contributions 不得引用 optional feature 内部 ID；feature 可以引用核心贡献。
- 该设计增加 Manifest 顶层字段，应通过 Manifest v2 或同等明确的格式版本发布，不进入 A1 PR。

### 6.5 Conformance 门禁

宿主 CI 必须覆盖：

1. envelope 先于 contributions 的版本判断；
2. A1 未知类型、字段、枚举和悬空引用全部拒装；
3. 已知贡献拼写错误拒装；
4. Manifest v2 feature fragment 另建矩阵，不与 A1 测试混杂；
5. 老 Manifest × 新宿主回放；
6. 新 Manifest × 版本不足宿主的清晰错误；
7. command/menu 数量与载荷上限；
8. 国际化、图标、设置显隐和来源标识。

---

## 7. Host API 与运行时交互

### 7.1 现有 API 不改语义

`window.dbxPlugin.notify(method, params)` 继续表示“向本插件 Sidecar 发送无响应通知”。
新的宿主 UI 原语不得复用 `notify` 名称，也不得要求插件传入 `pluginId`。

### 7.2 后续宿主模态 API 命名

如后续确有需求，使用宿主自动绑定身份的命名空间：

```ts
window.dbxPlugin.ui.showMessage(options)
window.dbxPlugin.ui.showQuickPick(options)
window.dbxPlugin.ui.showInput(options)
```

发布前必须定义：

- 每插件单飞、跨插件排队；
- Esc/关闭返回 `null`；
- 默认超时和显式上限；
- 文本、选项、action 数量和总载荷上限；
- 插件来源标识、防钓鱼展示；
- web/docker 的明确降级；
- webview 销毁、插件卸载和 Sidecar 退出时的取消行为。

这些 API 只允许活动的沙箱 UI 调用。若未来需要“没有 webview 时由 Sidecar 主动通知”，必须另行设计 Sidecar→Host 能力、权限和激活模型，不能借用 UI bridge。

### 7.3 动态宿主 UI 延后

状态栏文字、badge、panel 活动点等需要运行时更新。发布这些贡献点之前必须先定义：

- 谁负责激活 Sidecar/webview；
- 状态更新 API 和最大更新频率；
- 宿主重启、webview 销毁和插件卸载时的清理；
- 后台插件的资源预算；
- 静态占位与动态状态不可用时的降级。

在该协议完成前，BottomDock v1 不显示“有输出/命令运行中”动态呼吸点。

### 7.4 运行时作用域

| Scope | 宿主身份 | 典型资源 | 结束条件 |
| --- | --- | --- | --- |
| plugin | `pluginId` | Sidecar 进程、全局缓存 | 禁用、更新、卸载、宿主退出 |
| connection | `connectionId` | SSH/数据库连接、隧道引用 | disconnect、删除连接、插件卸载 |
| workbench | `workbenchId` | webview、PTY、订阅、临时状态 | tab/panel 关闭、插件卸载 |
| invocation | `invocationId` | 单次 command/RPC、取消句柄 | 完成、取消、超时 |

- 子 scope 不得比父 scope 活得更久；关闭顺序为 invocation → workbench/connection → plugin。
- 宿主生成所有 scope ID，插件只能把它们作为不透明引用使用。
- 任何长任务必须绑定 invocation 或更长生命周期的显式 scope，不能成为无主后台任务。
- `workbench/close` 只关闭 workbench scope，不能代替整个插件的 deactivate/unload 协议。

### 7.5 插件 context key

后续允许插件发布有限的动态 context key，以支持纯宿主求值的 menus/enablement：

```ts
await window.dbxPlugin.contextKeys.set("localSessionRunning", true)
await window.dbxPlugin.contextKeys.delete("localSessionRunning")
```

宿主内部完整键为 `plugin.<pluginId>.<key>`。约束：

- 值仅允许 `null`、boolean、有限 number、短 string 或小型标量数组；
- 禁止 Secret、连接配置、任意对象和大型集合；
- 每插件键数量、单值大小和更新频率必须设上限；
- webview/Sidecar/scope 销毁时清除所属键；
- 插件不能设置、覆盖或伪造宿主 context key；
- A1 只支持宿主 key，插件 context key API 独立评审后上线。

### 7.6 恢复模型

`open-workbench` action 的 `restore` 明确内容实例的恢复等级：

| 模式 | 宿主恢复 | 插件责任 |
| --- | --- | --- |
| `none` | 不把该实例加入下次会话恢复 | 无恢复回调；用户需要重新执行 command |
| `placeholder` | 恢复 tab/panel 外壳与来源元数据 | 显示未运行态，等待用户重新打开 |
| `state` | 恢复有界 JSON `workbenchState` | 从状态重建 UI，不自动重放命令或副作用 |
| `reattach` | 恢复状态并提供旧 scope 引用 | 验证 Sidecar 中仍存在资源后重连，失败回退 placeholder |

- 恢复不是再次执行 command。
- `workbenchState` 必须版本化、有大小上限、不得包含 Secret。
- A1 只发布 `none`；`placeholder`、`state`、`reattach` 随 Runtime 里程碑增加。
- 插件必须显式支持非 `none` 模式；宿主不能从当前 UI 猜测。
- 隐藏与恢复不同：隐藏可以 keep-alive；宿主进程重启后的恢复必须走本节协议。

### 7.7 动态卸载

宿主更新、禁用或卸载插件时应执行：

1. 停止接受新的 command invocation；
2. 向 Sidecar 发送有界超时的 `plugin/prepareUnload`；
3. 插件返回活动 scope 摘要和可选阻断原因，不得返回 Secret；
4. 宿主按最深 scope 优先取消 invocation、关闭 workbench/connection；
5. 发送 `plugin/deactivate`，关闭桥、清除 context key、菜单状态和动态 UI；
6. 超时后终止 Sidecar 及其子进程组，并记录诊断；
7. 若无法安全卸载，宿主向用户说明需要重启，而不是假装成功。

`prepareUnload` 只能争取优雅清理时间，不能无限阻止用户卸载；最长等待时间由宿主控制。

---

## 8. 首个消费者：SSH 插件本地终端

### 8.1 当前状态：P0 部分完成

commit `1824c04` 已完成“从现有 SSH workbench 自查自开一个本地终端 tab”，但还不能把插件中心普通打开视为完整入口：插件中心不会自动提供插件私有的本地模式 context。

当前实现仍有三项迁移任务：

1. 将 `{ localTerminal: true }` 迁移为 `{ plugin: { mode: "local-terminal" } }`；
2. 不再由插件传入 `workbenchId`，实例 ID 由宿主生成；
3. `restored: true` 时不得自动创建新 shell，应恢复 tab 外壳并显示退出/重开状态，等待用户显式启动。

因此验收状态应写为：

- [x] 已打开的 SSH workbench 可以显式新建本地终端 tab；
- [ ] 插件中心/全局入口通过 command context 打开本地终端；
- [ ] 无连接 tab 的恢复矩阵完成，恢复不会自动执行本机 shell。

### 8.2 P1：使用 command + menus 提供全局入口

SSH 插件声明一个 `open-local-terminal` command，并分别摆放到：

- `commandPalette`；
- `appSidebar`（默认显示）；
- `appToolbar`（默认隐藏，由用户在设置中打开）。

不得扫描并暴露“所有 workbench”来猜测哪些入口适合全局打开：部分 workbench 必须依赖连接或特定 context。全局可发现性必须由插件显式声明。

### 8.3 P2：BottomDock

BottomDock 是宿主通用容器，不是终端专用实现。

- 本地终端 command 以 `presentation: "panel"` 打开同一个 workbench 内容；workbench 自身不声明固定 surface。
- tab 与 panel 的复用键必须包含 `presentation`，两者可以同时存在。
- `workbenchId` 由宿主分别生成；panel 隐藏仅隐藏 UI，不销毁 webview。
- 宿主在 context 中注入权威 `surface: "panel"`；插件据此使用紧凑布局。
- 关闭走两段式：宿主先向 webview 发送桥消息 `workbench/close`（携带权威 `workbenchId`），插件释放自己的 workbench scope（PTY、订阅、临时状态）后回 `workbench/close-ack`；宿主最多等待一个有限宽限期即拆除 webview，未确认也照常拆除。SDK 在 ready 消息里以 `features: ["workbench.close"]` 声明支持；旧 SDK 不认识该消息，宿主立即拆除，行为与无握手时一致。tab 关闭路径若未走两段式，至少在卸载时 best-effort 发送该消息。
- panel 关闭或插件卸载时发送 `workbench/close`；进程异常退出时 Sidecar 仍必须保证 PTY 子进程组被回收。
- v1 不自动按空闲时间卸载正在运行的终端，避免误杀长任务；自动卸载策略留待宿主能可靠判断运行状态后再设计。
- `Ctrl/⌘+J` 必须先进入宿主统一快捷键冲突治理，不硬编码覆盖用户键位。

### 8.4 恢复语义

- A2 的本地终端 command 使用 `restore: "none"`：宿主重启后不恢复该终端实例，也不重新执行 command。
- Runtime 里程碑可增加 `placeholder`，恢复外壳后显示退出态和“重新打开”按钮。
- 本地 shell 不跨宿主进程恢复；只有确认 Sidecar 内仍存在同一宿主生成的 scope 时才可使用 `reattach`。
- 任何非 `none` 恢复路径都必须先处理 `restored`，再决定 UI 状态，绝不能自动启动 shell。

---

## 9. 里程碑

| 里程碑 | 内容 | 归属 |
| --- | --- | --- |
| 前置 | envelope 版本门槛、严格解析与 conformance 骨架 | 宿主 |
| A1 | `command(open-workbench)` + `menus(commandPalette/appToolbar/appSidebar)` | 宿主 |
| A2 | SSH 插件迁移本地终端 context、声明 command/menus、修复恢复语义 | 插件 |
| P2 | command `presentation: panel` + BottomDock + 实例复用/关闭生命周期 | 宿主 + 插件 |
| Runtime | scope、contextKeys、restore、prepareUnload/deactivate | 宿主 + SDK + Sidecar |
| Manifest v2 | capability-gated feature fragments | 独立提案 |
| 后续 | RPC command、宿主模态、动态状态栏、view-container/view、object-viewer | 独立提案 |
| 验证 | macOS/Windows/Web 降级矩阵与真实宿主回归 | 双方 |

首次发布顺序固定为“宿主先行、插件抬最低版本、插件后发”。

---

## 10. 验收清单

### Manifest 与兼容

- [ ] 版本不足在解析 contributions 前得到明确错误。
- [ ] A1 未知贡献、字段、枚举与悬空引用全部拒装。
- [ ] 已知贡献字段拼写错误拒装，不被静默忽略。
- [ ] 现有 5 类贡献在新宿主行为不变。
- [ ] feature fragment 不进入 A1 Schema；Manifest v2 另行评审。

### command 与 menus

- [ ] command 只能引用同插件 workbench，宿主内部使用全限定 ID。
- [ ] `singleton`/`new` 和 `instance_key` 行为有自动化测试。
- [ ] commandPalette、appToolbar、appSidebar 均展示插件来源。
- [ ] appToolbar 缺省隐藏；每插件最多一个默认显示项。
- [ ] `group/order` 稳定排序，不允许插件跨命名空间锚定。
- [ ] `menus.when` 与 `command.enablement` 独立测试，执行前重新校验 enablement。
- [ ] 外观设置与设置搜索只管理持久 chrome 摆放。
- [ ] 国际化沿用顶层 `localizations`，无 `label_i18n` 平行字段。

### context 与生命周期

- [ ] 插件载荷只进入 `context.plugin`。
- [ ] 宿主覆盖保留字段，插件无法伪造 `workbenchId`、`surface`、`restored` 或 `connectionId`。
- [ ] tab/panel 复用键包含 presentation；同一 workbench 可同时存在两种实例。
- [ ] 恢复 tab/panel 不重新执行 command，不自动启动本地 shell。
- [ ] 关闭、卸载与异常退出均不会遗留 PTY 子进程。
- [ ] plugin/connection/workbench/invocation scope 的父子关系和关闭顺序有自动化测试。
- [ ] A1 `restore: none` 不产生恢复实例；后续 `placeholder/state/reattach` 分别有成功与失败回退测试。
- [ ] 动态卸载清除 context key、菜单状态、webview、Sidecar 和子进程。

### 非桌面形态

- [ ] Web/Docker 对 appToolbar、appSidebar 和 panel 的显示/隐藏/回退行为明确。
- [ ] panel 不可用时，`presentation: panel` 按规范回退到 tab 或返回明确的不支持错误；不得静默丢失入口。

### PR-A4 插件侧本地验证映射

SSH 插件把本地终端迁移到 `command` + `menus`（PR-A4，实施计划见
`docs/HOST_UI_A4_IMPL_PLAN.zh-CN.md`）。下表把评审指南 §7 中与 A4 相关的检查项
映射到插件侧验证方式：能在本仓本地验证的标注命令/用例名，需要宿主配合的标注
“待宿主联调”，由串行收尾的 V 轨道在宿主 A1-A3 落地后收口。本节只建结构与当前
确定项，不代勾 W1/W2 未完成项（§8.1 状态勾选留待对应轨道完成后更新）。

| 评审指南 §7 检查项 | A4 视角 | 验证方式 |
| --- | --- | --- |
| 插件载荷只进入 `context.plugin`，宿主保留字段最后写入并覆盖冲突（安全与隔离） | 直通 context 从 `{ localTerminal: true }` 迁到 `{ plugin: { mode: "local-terminal" } }`；mock 侧模拟宿主权威 `workbenchId` | 本地可验（W1 合并后生效）：`node scripts/smoke_ui_mock.mjs` A4 锚点 `?local=1` 直通；`pnpm --dir frontend test`（`mockDbxHost.spec.ts` context 形状往返 + openWorkbench 身份权威用例） |
| 插件无法伪造 `workbenchId`、`surface`、`restored`、`connectionId`（command / 安全与隔离） | 自开桥不再传 `workbenchId`，由宿主注入（旧宿主走 fallback） | 本地可验（W1 合并后生效）：`pnpm --dir frontend test` 自开桥参数用例；真实宿主注入行为 **待宿主联调** |
| 恢复不重新执行 command、不自动启动本地 shell（生命周期与恢复） | `?local=1&restored=1` 夹具：0 次 `local/terminal/start`，退出外壳（已退出 + 重新打开/关闭）可见 | 本地可验（W1 合并后生效）：`node scripts/smoke_ui_mock.mjs` A4 锚点 restored 零调用断言；`pnpm --dir frontend test` restored 不自动起 shell 用例 |
| A1 `restore: none` 不创建恢复实例、不重新执行 command（生命周期与恢复） | 本地终端 command 声明 `restore: none`（W2 manifest 分支 `codex/ssh/a4-manifest`） | 声明内容静态审查见 W2 分支；宿主恢复行为 **待宿主联调**（V 轨道合同矩阵） |
| 关闭、卸载与异常退出均不会遗留 PTY 子进程（context 与生命周期） | sidecar `local/session/close` 回收子 shell | 本地可验：`python3 scripts/smoke_local_terminal.py`（用例 5：close 后子进程退出并收到 exited 事件）；宿主 webview 关闭链路 **待宿主联调** |
| commandPalette / appToolbar / appSidebar 摆放与来源提示（menus 与 UX） | W2 manifest 声明三摆放 + `assets/local-terminal.svg` 受控图标 | 声明内容静态审查见 W2 分支；入口渲染与来源提示 **待宿主联调**（宿主 A3） |
| 直通进入本地终端：本地徽标、无 SSH 连接卡片、恰好一次自动启动（A4 直通回归） | `?local=1` 直通路径在 context 迁移后行为不变 | 本地可验（W1 合并后生效）：`node scripts/smoke_ui_mock.mjs` A4 锚点 `?local=1`（徽标 + 无 SSH 卡片 + start 计数=1） |

---

## 11. 发布即冻结的契约

以下内容一经发布只能增加，不能改名或改变既有语义：

- 贡献类型名 `command`、`menus`；
- command action 判别值 `open-workbench`；
- menus 位置 `commandPalette`、`appToolbar`、`appSidebar`；
- `reuse`、`presentation` 和实例复用规则；
- `context.plugin` 与宿主保留字段的所有权；
- A1 严格解析与 host-first 发布规则；
- `menus.when` 与 `command.enablement` 的不同语义；
- menu `group/order` 的稳定排序规则；
- runtime scope、restore 和 unload 的生命周期语义；
- Host API 现有 `notify` 语义；
- 国际化继续使用顶层 `localizations`。

任何 RPC command、动态宿主状态或 Sidecar 主动 UI 能力都必须通过新判别值、新权限和对应版本发布，不得重新解释上述字段。
