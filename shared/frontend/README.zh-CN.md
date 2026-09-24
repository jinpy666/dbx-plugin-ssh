# shared/frontend — 插件前端宿主适配公共层

宿主桥/宿主特性的**前端适配公共代码唯一实现点**。四插件（ssh / files / ldap /
kafka）前端一律以相对路径引用这里的模块，**禁止在插件内各抄一份**（背景：binary
事件契约变更曾在 ssh/files 各落一份相同修复，收敛后单点演进）。

## 引用方式

插件前端源码相对引用（Vite / vue-tsc 均无需额外配置，tsconfig 随 import
自动纳入检查）：

```ts
// 位于 <plugin>/frontend/src/App.vue：
import { bridgeBinaryBytes } from "../../shared/frontend/binaryEvent";
// 位于 <plugin>/frontend/src/lib/*.spec.ts：
import { bridgeBinaryBytes } from "../../../shared/frontend/binaryEvent";
```

## 约定

- 每个插件保留薄 spec 引用 shared 模块跑断言（证明该插件工具链下 import
  解析、打包、行为都成立）；实现与文档只在 shared 维护。
- 收敛候选：宿主桥 binary 事件（binaryEvent.ts）、主题令牌兜底、
  workbenchState/fileTransfer 降级 shim、七语工具等跨插件同构逻辑。
- 宿主契约变更的发现与跟进流程见 `AGENTS.md` 硬性规则 7 与
  `scripts/host-sync.sh contract`。

## 现有模块

| 模块 | 用途 | 接入方 |
| --- | --- | --- |
| `binaryEvent.ts` | 宿主桥 binary 事件双形状归一化（`data: Uint8Array` / 旧 `dataBase64`） | ssh（终端输出帧、SFTP 下载分块）、files（files/download 分块） |
| `uiIntent.ts` | MCP UI intent 通道公共 composable（`useUiIntent(domain, handlers)`）：订阅 `<domain>/ui/intent` 事件（形状归一化）→ 分派 handler → 自动调 `<domain>/ui/state/report` 回报 applied/rejected/summary；`reportSnapshot` 上报无 intentId 的快照型 report | ldap（M1 先行）；files / kafka（M2/M3 沿用） |
| `editorTheme.ts` | CodeMirror 6 语法高亮调色板单点维护（`EDITOR_TOKEN_COLORS` / `syntaxTokenSpecs` / `dbxSyntaxHighlight`）：暗色为提亮后的 GitHub Dark 系（用户反馈 basicSetup 内置浅底配色与标准 Dark+ 偏暗），浅色 VS Code Light+ 同源；**零运行时依赖**，codemirror 系对象由调用方注入。kafka CodeEditor 因 CSS 变量驱动无法 import 色值，其 `--cm-*` 暗色块按 `dark` 调色板镜像（各插件 `editorTheme.spec.ts` 源码断言防漂移） | ssh / files（TextPreview 追加在 basicSetup 后，各带薄 spec）；kafka（CSS 镜像 + 薄 spec） |
| `themeSync.ts` | 宿主主题令牌 → 插件 CSS 变量桥（`themeBridgeCss` / `installHostThemeBridge`）：把 `--background` 等插件变量声明为宿主 `--color-*`/`--radius-*`/`--font-*` 令牌的引用，首绘即命中宿主主题、主题变化经 SDK 令牌更新自动跟随；含 `data-dbx-theme` color-scheme 同步。宿主无令牌时回退暗色规范值（optional 降级）。另下发**语义状态色** `--success`/`--success-bg`/`--warning`/`--warning-bg`（跟随宿主 `--color-success*`/`--color-warning*`，缺失时按宿主明暗规范值回退）与**模态遮罩** `--overlay`（亮色黑 40%、暗色背景 mix）。明暗分支统一双属性匹配 `data-dbx-theme`（宿主 SDK）+ `data-theme`（插件 applyAppearance），谁先到都生效；状态徽章/横幅一律引用语义令牌，禁止散装 hex（#10b981/#22c55e/#f97316/#d97706 等） | ssh / ldap / files / kafka（`main.ts` 挂载前 `installHostThemeBridge()`，各带薄 spec） |
| `pluginStorage.ts` | 工作台 UI 持久化单点适配（`createPluginKvStore`）：封装宿主 `window.dbxPlugin.storage`（Host API 1.2，`capabilities.storage` 探测 + manifest `host.storage` 权限），对调用点暴露同步 `getItem/setItem/removeItem`（实现为启动水合 + 写穿缓存）；通道降级 宿主桥 → guarded localStorage（web 直连/dev host）→ 内存；宿主档水合时对 localStorage 旧键一次性惰性搬家。只存非敏感 UI 状态（宿主端单值 256 KiB / 总量 1 MiB），凭据仍走连接表单 `binding:"secret"`，大数据归 sidecar `DBX_PLUGIN_DATA_DIR` | 本插件（键集合显式声明建 store；`main.ts` 挂载前 `await ready`；sidecar 权威数据的 web 缓存键不迁；带薄 spec） |

## MCP 两阶段/digest/cursor 验收用例清单（设计 §7，防形状漂移）

状态机纯逻辑三插件同构（Go/Rust 各一份实现、测试用例同表）。M1（ldap）
用例已落地 `ldap/backend/internal/mcp/*_test.go`，编号即测试覆盖面：

**S-SET（settings）**：默认值 = 设计值；越界值 clamp 回硬上限（报告等待
30s / 截断宽度 / 组数 20 / topN 10 / 样本 5 / rows 20 / 响应 1 MiB）；缺
文件或损坏文件逐项回落默认；白名单外字段忽略、非数值与越界 set 拒绝且
不污染当前值；持久化往返；nil store（数据目录不可用）Save 静默 Load 回默认。

**S-INT（intent 状态机）**：pending → applied 带 summary；rejected 带
reason；非法状态值拒绝；TTL 60s 过期读为 expired 且条目清除、过期后
report 不复活；LRU 只留最近 N 条、同 id 重发视为最新；快照写入/读取双端
复制（调用方改动不渗漏）；无快照返回 nil。

**S-CUR（cursor）**：缺省批量 20、n>20 clamp、会话内游标续读（offset 缺省
= 续读、显式 0 = 从头）；末批 done、读尽后仍 found；TTL 10 分钟过期读为
expired 并清除；LRU ≤8 会话淘汰最旧；物化上限 1 万行截断置
cursorTruncated；投影属性随行携带。

**S-CONF（confirmToken）**：同参数 hash 稳定、参数变 hash 变；签发 TTL
60s；一次性消费（二次 unknown）；过期 expired；hash 失配 hash_mismatch 且
令牌作废；未知令牌 unknown。

**S-DIG（digest 聚合）**：objectClass 分布计数；组数截断置 limit 标；
子树计数按 base 直接子 DN 收拢（base 外原样、base 自身成键）；distinct
值域统计（值数 + top 计数）；单元格截断宽度生效、DN 定位字段永不截断；
样本行数 clamp（≤5 与条目数取小）。

**S-SRV（Server 编排）**：settings get/set 往返与持久化；响应超限按
sample→rows→stats 丢弃并置 truncated，不可丢弃字段超限回占位响应；未知
工具报错；无 intentId 的 `ldap_ui_state` 返回最新快照；未知 cursorId
报错；`mcp/tools` 对只读连接剔除写工具并附 omittedWriteTools 原因、可写
连接全量 8 工具。
