# DBX 插件扩展点宿主 PR 评审指南

本文从最终宿主 PR reviewer 的视角，对齐 VS Code、IntelliJ Platform 与 DBX 的插件扩展模型，并给出可合并范围、必须拆分的后续工作和明确否决条件。

规范正文见 [`HOST_PLUGIN_UI_SPEC.zh-CN.md`](./HOST_PLUGIN_UI_SPEC.zh-CN.md)。本文不替代 Schema、Rust 类型定义或 Host API 类型声明；PR 中三者必须一致。

## 1. Reviewer 结论先行

首个宿主 PR 建议只接受以下闭环：

1. 新增严格校验的 `command` 与 `menus` contribution；
2. command v1 只支持宿主执行的 `open-workbench`；
3. menus v1 只支持 `commandPalette`、`appToolbar`、`appSidebar`；
4. 分离 placement `when` 与 command `enablement`；
5. 定义稳定的 `group/order`、来源标识和工具栏默认隐藏策略；
6. 插件使用新能力时提升最低宿主版本；旧 Manifest 行为完全不变。

以下内容不应混入首个 PR：

- Sidecar RPC command；
- 模态 API、状态栏、badge 或动态 view；
- 插件自定义 context key；
- BottomDock 实现；
- Manifest v2 feature fragments；
- 跨插件 command/extension point；
- 动态卸载协议的大规模重构。

原因不是这些能力不重要，而是它们分别改变执行面、资源生命周期或 Manifest 格式，无法与静态入口贡献点放在同一个可穷举的 review 单元中。

## 2. 三方模型对齐

| 关注点 | VS Code | IntelliJ Platform | DBX 当前 | DBX 目标 | 评审结论 |
| --- | --- | --- | --- | --- | --- |
| 插件描述文件 | `package.json`，`contributes`、`activationEvents`、`engines.vscode` | `plugin.xml`，extensions、actions、depends、版本范围 | `manifest.json`，严格 Manifest v1 | A1 继续严格；新能力要求宿主先行和 engines 门槛 | 采用 DBX 严格模型，不复制宽松未知字段行为 |
| 扩展能力声明 | 每类 contribution 有独立 Schema | 平台声明 extension point，插件注册实现 | 5 类固定 contribution | A1 增加 `command`、`menus`；复杂 provider 以后独立提案 | 类型按渲染/调用契约划分，不追求数量 |
| 命令/动作 | command 元数据与运行时 `registerCommand` 分离 | `AnAction` 同时实现 `update()` 与 `actionPerformed()` | openWorkbench、表单 action、context-menu 分散 | command 是通用入口原子，v1 handler 仅 `open-workbench` | 不强行迁移领域 action |
| UI 摆放 | `menus` 引用 command，支持 `when`、group | action group、place、anchor/order | 无统一入口摆放 | `menus.location + when + group + order` | 明确采用 |
| 可见/可用 | menu `when` 与 command `enablement` 分开 | `update()` 分别更新 visible/enabled | 未统一 | placement `when` 与 command `enablement` 分开 | A1 必须完成 |
| 上下文 | 宿主 context key + 扩展 `setContext` | `DataContext` 传给 action update/perform | workbench context 快照 | A1 仅宿主 key；后续受限 plugin context key | 禁止渲染路径同步调用 Sidecar |
| 激活 | command/view 等事件触发懒激活 | extension/factory/service 按需实例化 | workbench/Sidecar 按现有路径启动 | 静态入口不激活；执行/打开时激活 | A1 必须有“不启动 Sidecar”测试 |
| 面板/视图 | View Container/View 与 Webview Panel 分开 | declarative Tool Window 与 programmatic Tool Window 分开 | workbench tab，无通用 dock | command panel 处理临时内容；未来 view-container/view 处理持久视图 | 不用一个 `surface` 字段覆盖所有场景 |
| 运行时状态 | ExtensionContext subscriptions、Disposable | application/project service 与 Disposable | 主要按 plugin/connection/workbench 隐式管理 | plugin/connection/workbench/invocation scope | 生命周期单独 PR，但数据模型需预留 |
| 恢复 | webview state + serializer，恢复不等于重跑 command | Tool Window 工厂按需重建内容 | `restored` 布尔，语义不完整 | `none/placeholder/state/reattach` | BottomDock 前必须冻结 |
| 可选能力 | engines + 不同 contribution；平台能力由产品决定 | optional dependency + 独立 config file | 单一严格 Manifest | Manifest v2 feature fragment + capability gate | 不采用逐 contribution optional |
| 动态卸载 | subscriptions/dispose，Extension Host 重载 | dynamic extension + unload 检查 + Disposable | Sidecar/子进程清理缺统一协议 | prepareUnload → close scopes → deactivate → kill fallback | 原生插件发布前必须补齐 |
| 插件间扩展 | command/API 导出，但受扩展宿主管理 | 插件可定义自有 extension point | 禁止跨插件 Host API 调用 | 继续禁止，直到依赖、权限和版本隔离完整 | 当前明确拒绝 |

## 3. 采用、改造与拒绝

| 分类 | 机制 | DBX 决策 |
| --- | --- | --- |
| 采用 | command 与 placement 分离 | command 定义身份、展示与 handler；menus 只负责摆放 |
| 采用 | 懒激活 | 解析、展示、条件求值均不得启动 Sidecar |
| 采用 | 可见与可用分离 | `menus.when` 控制显示；`command.enablement` 控制执行 |
| 采用 | 生命周期清理 | 所有运行时资源必须归属显式 scope |
| 改造 | VS Code `when` 字符串 DSL | DBX 使用结构化 JSON 条件，便于 Schema 校验和安全演进 |
| 改造 | IntelliJ `AnAction.update()` | DBX 只允许宿主本地纯条件求值；不允许高频 Sidecar 回调 |
| 改造 | Tool Window/View Container | 临时 panel 与持久 view container 分开设计 |
| 改造 | optional dependency | DBX 使用 capability-gated feature fragment，并作为 Manifest v2 独立评审 |
| 拒绝 | command 自动进入命令面板 | DBX 要求显式 `menus.location = commandPalette`，避免插件默认污染全局入口 |
| 拒绝 | 插件定义任意全局 menu group/anchor | 只允许宿主稳定词表和整数 order |
| 拒绝 | 插件传 `pluginId`、`workbenchId` 等宿主身份 | 所有身份由桥或宿主生成 |
| 拒绝 | 首版 command 任意 RPC | 防止静态入口一次性升级为远程执行面 |
| 拒绝 | 已知贡献解析失败后静默跳过 | 拼写错误、未知字段和悬空引用必须拒装 |

## 4. A1 数据模型

下面的示例代表 reviewer 应期待的最小 Manifest 形状：

```json
{
  "contributions": [
    {
      "type": "workbench",
      "id": "io.dbx.ssh.workbench",
      "label": "SSH"
    },
    {
      "type": "command",
      "id": "open-local-terminal",
      "label": "Local terminal",
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
    },
    {
      "type": "menus",
      "id": "local-terminal-entrypoints",
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
          "group": "navigation",
          "order": 100,
          "default_visible": false
        },
        {
          "location": "appSidebar",
          "command": "open-local-terminal",
          "group": "primary",
          "order": 100,
          "default_visible": true
        }
      ]
    }
  ]
}
```

Reviewer 应确认 JSON Schema、Rust 反序列化类型、TypeScript 前端 registry 类型和开发文档对字段名、缺省值、枚举值完全一致。

## 5. A1 执行路径

```text
读取原始 Manifest envelope
    → 检查 engines/host_api
    → 严格解析所有 contributions
    → 校验 ID、同插件引用、资源路径和数量上限
    → 注册静态 command/menu 元数据（不得启动 Sidecar）
    → 宿主基于 context 渲染 placement
    → 用户点击
    → 重新检查 command.enablement
    → 宿主执行 open-workbench
    → 创建/复用宿主生成的 workbench scope
```

任何在“用户点击”之前启动 Sidecar、创建 webview 或执行插件代码的实现，都违反懒激活目标。

## 6. PR 切片建议

| PR | 范围 | 必须包含 | 明确不包含 |
| --- | --- | --- | --- |
| PR-A1 | Manifest/runtime 模型 | Schema、Rust 类型、严格解析、引用校验、golden manifests | UI、BottomDock、RPC |
| PR-A2 | Desktop command registry | command 注册、enablement 求值、来源信息、命令面板 | Sidecar handler |
| PR-A3 | menus surfaces | toolbar/sidebar 渲染、group/order、settings/search、卸载清理 | panel |
| PR-A4 | SSH 消费者 | 新 manifest、context namespace、恢复分支修复、真实宿主测试 | 宿主特例 |
| PR-P2 | BottomDock | panel presentation、实例键、focus、关闭、恢复、Web 降级 | view-container |
| PR-Runtime | 生命周期 | scope、contextKeys、prepareUnload/deactivate、子进程回收 | Manifest v2 |
| PR-M2 | Manifest v2 | feature fragments、capability gate、升级矩阵 | A1 兼容补丁 |
| PR-Views | 持久视图 | view-container/view、lazy factory、状态与动态更新 | 临时 workbench panel 重写 |

如果实现团队希望合并 PR-A1～A3，reviewer 至少应要求提交按上述边界拆分，确保 Schema/runtime 与 UI diff 可以独立审查和回滚。

## 7. Reviewer 检查表

### 契约与兼容

- [ ] 旧的 5 类 contribution 序列化、安装和运行行为完全不变。
- [ ] 使用 `command`/`menus` 的插件声明了正确最低宿主版本。
- [ ] engines 在完整 contribution 反序列化前检查，版本不足错误可理解。
- [ ] 未知类型、未知字段、未知枚举和悬空引用全部拒装。
- [ ] Schema、Rust、TypeScript、dev host mock 和文档字段一致。
- [ ] 不存在“新字段已被某层忽略，但另一层认为生效”的部分实现。

### command

- [ ] command ID 在宿主内部全限定，插件无法伪造 `app.*`、`workbench.*` 等宿主命名空间。
- [ ] v1 action 只有 `open-workbench`，不存在隐藏 RPC/事件派发路径。
- [ ] workbench 引用只能指向同插件已声明贡献。
- [ ] `singleton/new`、`instance_key` 和 presentation 都进入实例复用键测试。
- [ ] workbenchId 由宿主生成，Manifest/context 无法注入或覆盖。
- [ ] 执行前重新校验 enablement。

### menus 与 UX

- [ ] placement 引用本插件 command，不能跨插件引用。
- [ ] `when` 只控制 placement 可见性，不改变 command 业务语义。
- [ ] group 只接受宿主词表，order 排序稳定且与安装顺序无关。
- [ ] 工具栏插件项默认隐藏，单插件默认显示数量受限。
- [ ] 命令面板、工具栏、侧栏显示插件来源或可访问来源提示。
- [ ] 工具栏显隐同时进入设置页面和设置搜索。
- [ ] 插件卸载后动态设置键、registry 项和 UI 元素全部清除。

### 安全与隔离

- [ ] command context 仍遵守 2 MiB JSON 快照约束，且不允许 Secret。
- [ ] 插件载荷只进入 `context.plugin`；宿主保留字段最后写入并覆盖冲突。
- [ ] 静态 contribution 注册不启动 Sidecar、不创建 webview、不发网络请求。
- [ ] 图标继续以受控资产 URL/图片方式渲染，不内联执行 SVG。
- [ ] 来源标识不能被插件 label/icon 完全遮蔽。
- [ ] 数量、字符串长度、嵌套深度和 context 大小均有边界测试。

### 生命周期与恢复

- [ ] A1 没有通过 command replay 实现恢复。
- [ ] `restore: none` 不创建恢复实例，也不重新执行 command。
- [ ] 后续 `placeholder/state/reattach` 必须有版本化、有界、无 Secret 状态格式。
- [ ] tab 与 panel 使用不同 presentation 身份，可以同时存在。
- [ ] 关闭 tab/panel 时只释放对应 workbench scope。
- [ ] 插件更新/卸载的最终方案能清理 Sidecar 和子进程组。

### 测试

- [ ] 每个新 contribution 有合法 golden manifest。
- [ ] 每个枚举值、缺省值和无效组合有 Schema/Rust 双层测试。
- [ ] 至少覆盖两个插件声明相同短 command ID 的隔离测试。
- [ ] 至少覆盖多个插件相同 group/order 的稳定排序测试。
- [ ] 至少覆盖隐藏、禁用、执行前状态变化三种条件测试。
- [ ] 至少覆盖卸载后设置/registry 清理测试。
- [ ] Web/Docker 不支持表面的行为是明确回退或明确错误。

## 8. 必须请求修改的情形

出现以下任一情况，reviewer 应请求修改而不是以“后续再补”合并：

1. 已知 contribution 解析失败后仍安装成功；
2. 新插件在未提升最低宿主版本时依赖新贡献点；
3. command 可调用任意 Sidecar method；
4. UI 渲染为了判断可见性同步调用插件代码；
5. 插件可控制 pluginId、workbenchId、connectionId、surface 或 restored；
6. toolbar/sidebar 扫描全部 workbench 自动暴露入口；
7. toolbar 项默认全部打开或没有数量限制；
8. placement 顺序取决于插件安装/加载顺序；
9. 恢复通过重新执行 command 实现；
10. 宿主、Schema、CLI、dev host 只实现了其中一部分字段；
11. BottomDock 与 command/menus 基础契约塞进同一不可分离 diff；
12. 没有旧 Manifest 回归与无效 Manifest 矩阵。

## 9. 预期宿主代码影响面

最终 PR 描述应列出实际文件；从现有代码结构看，reviewer 至少应关注以下模块：

| 层 | 关注点 |
| --- | --- |
| Manifest runtime | 新 Rust 类型、严格反序列化、ID/引用/上限校验 |
| JSON Schema | command、menus、condition、枚举和条件组合 |
| Installer/registry | engines 检查顺序、错误文案、静态注册和卸载清理 |
| Host bridge | openWorkbench 身份绑定、context 合并顺序、scope ID 生成 |
| Query/workbench store | singleton/new、presentation、instance_key、恢复行为 |
| Command registry | 全限定 ID、enablement、来源信息、执行前复核 |
| Toolbar/sidebar | group/order、默认显隐、More 菜单、来源提示 |
| Settings/search | 动态显隐项、已卸载插件键清理 |
| Dev host/mock | 与真实宿主同字段、同缺省值、同错误行为 |
| Tests | golden manifest、兼容、排序、隔离、生命周期、降级矩阵 |

## 10. 上游依据

- VS Code：[Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- VS Code：[Activation Events](https://code.visualstudio.com/api/references/activation-events)
- VS Code：[When Clause Contexts](https://code.visualstudio.com/api/references/when-clause-contexts)
- VS Code：[Webview Lifecycle and Serialization](https://code.visualstudio.com/api/extension-guides/webview)
- IntelliJ Platform：[Plugin Configuration File](https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html)
- IntelliJ Platform：[Extensions](https://plugins.jetbrains.com/docs/intellij/plugin-extensions.html)
- IntelliJ Platform：[Extension Points](https://plugins.jetbrains.com/docs/intellij/plugin-extension-points.html)
- IntelliJ Platform：[Action System](https://plugins.jetbrains.com/docs/intellij/action-system.html)
- IntelliJ Platform：[Tool Windows](https://plugins.jetbrains.com/docs/intellij/tool-windows.html)
- IntelliJ Platform：[Services](https://plugins.jetbrains.com/docs/intellij/plugin-services.html)
- IntelliJ Platform：[Dynamic Plugins](https://plugins.jetbrains.com/docs/intellij/dynamic-plugins.html)

三方对齐的目标不是让 DBX 长得像任一 IDE，而是确保每个静态声明、运行时实现和资源生命周期都有唯一所有者，并且 reviewer 能从 Manifest 一路追到宿主行为和清理路径。
