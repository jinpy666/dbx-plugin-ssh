# Issue #326 / #327 / #328 跟进报告（2026-11-26）

工作分支：`codex/ssh/issue-326-328`（worktree
`~/dbx-plugin-ssh-issue-326-328`）。宿主 `host/` 全程只读，未改动。

## 总览

| Issue | 结论 | 本轮处置 |
| --- | --- | --- |
| #326 SSH 建立连接很慢 | **插件侧可优化（部分已落）**；剩余大头需宿主/产品决策 | 落一处可验证的首屏优化（预览链路惰性装载），补测量证据与后续方案 |
| #327 多选连接 + 分屏 + 批量命令 | **needs host**（插件侧只差「选择数据」与「分屏编排」两块宿主 API） | 只出提案；插件侧现有能力（分屏、批量命令）已覆盖一半需求 |
| #328 自动检测延迟并显示在连接列表 | **needs host**（宿主按设计尚未发布动态 badge/状态协议） | 只出提案；已确认插件侧现有手动延迟探测面（连接信息气泡） |

上一级结论先行：三个 issue 里只有 #326 存在「插件自己就能改、且有测量收益」
的入口；#327/#328 的关键缺口都在宿主契约，按 AGENTS 规则 8 不改 `host/`。

---

## #326 「SSH 建立连接很慢」

### 结论

- 插件 sidecar 的连接链路**没有** 可删的固定等待、重试或串行探针；本机实测
  已经贴着 SSH 协议下界（见下表）。
- 连接首屏真正的大块成本在**插件的单文件 UI**：`ui/index.html` 目前
  **25.1 MB**，其中文件预览 renderer 约 **11.4 MB**，而宿主以
  `<iframe srcdoc>` 加载（每次工作台开屏都要解析整份文档）。
- 本轮落了一处低风险优化（预览组件惰性装载），实测 frontend 首屏
  `domContentLoaded` **中位 565ms → 533ms**。剩下约 11.4 MB 的字节成本
  要移出 single-file 文档，涉及宿主 CSP/资源加载，属提案项。

### 调用链取证

1. **宿主点击连接 → 插件 `connection/connect` 只登记配置，不拨号。**
   `host/apps/desktop/src/stores/connectionStore.ts` 的 `ensureConnected`
   触发插件生命周期；sidecar 侧：
   - `backend/src/main.rs:487-509`：`connection/connect` 解析
     `RuntimeEndpoint`/`StoredConnection` 后仅 `store_connection`，
     注释明确「非 SSH 会话只暂存凭据」；不发 TCP。
2. **首个 `ssh/session/open` 才真正拨号**：`backend/src/ssh.rs:2273` 起，
   先查连接注册表 `:2291-2297`（未登记报
   `Connection is not active; reopen it from DBX`），随后
   `resolve_password_command`（`:2375` 前）→ `connect_authenticated`
   （`:3327`）→ `dial_and_authenticate`（`:3384`）。
3. **握手/认证**：`ssh_client_config`（`:112-119`）只设 nodelay/keepalive；
   `client::connect`（`:3427`/`:3442`）带动态 deadline；`none` 认证探测
   （`:3487-3491`）拿服务器广告集，再按配置分派
   `authenticate_password_or_interactive`（`:11842`）。这里的 RTT 数
   （TCP 1 + KEX 2 + none 1 + password 1）与 OpenSSH 客户端一致，
   `none` 探测也是 OpenSSH 自身会发的。
4. **认证后**：`channel_open_session` + `request_pty` + `request_shell`
   （`:2406-2440`），`detect_remote_shell` 另开一条 exec 通道在后台跑
   （`:2538-2547`，超时 5s，常量 `:308`）。它只影响**首屏输出可见时机**：
   读循环把初始输出缓冲到 shell 探测回来且提示符尾静默 150ms 后
   （`:2589-2598`、`:2631-2645`、判据 `:13674-13679`，常量 `:309-315`）。
5. **前端首屏**：`initialize()`（`frontend/src/App.vue:9031`）先
   `await pluginStore.ready`（`:9043`，宿主 storage 水合，UI 状态恢复
   依赖它）。`initialize()` 后半段（`:9085-9175`）先并行打 4 个
   非 SSH 协议会话清单（`:9193-9210`，webview 重建接回用），然后
   `resolveStoredConnectionProtocol`（`:4510-4532`，常规 2×250ms、
   恢复态 4×250ms 的短重试，sidecar 已登记时首个查询即命中），最后
   `ssh/session/open`（`:4702`）+ 一次本地 `ssh/terminal/replay`
   （`:4737-4743`，读 sidecar 内存缓冲，交代初始输出空洞）。
   这些调用都是本地 stdio/桥往返，单次亚毫秒到几毫秒量级，没有固定秒级等待。

### 实测（本机，2026-11-26）

**Sidecar 拨号（127.0.0.1:2222 测试容器 `dbx-ssh-test`，password 认证，
每轮新建会话；release 二进制，main HEAD）**

| 轮次 | 总耗时 | TCP+握手+none | password 完成 | 认证后（channel+PTY+shell+spawn 收尾） |
| --- | --- | --- | --- | --- |
| 1 | 27.0 ms | 18.9 ms | 25.6 ms | 1.4 ms |
| 2 | 20.8 ms | 10.6 ms | 19.2 ms | 1.6 ms |
| 3 | 18.2 ms | 10.5 ms | 16.5 ms | 1.6 ms |
| 4 | 25.8 ms | 16.2 ms | 24.3 ms | 1.5 ms |
| 5 | 20.0 ms | 12.0 ms | 18.4 ms | 1.6 ms |
| 平均 | **22.4 ms** | — | — | **~1.5 ms** |

补充：sidecar 进程 spawn → `plugin/initialize` 完成 **6.0 ms**。
结论：本机没有可捡的插件侧拨号开销；广域网下总时间基本由
「约 7 个串行 RTT + 服务器 shell 启动」决定，和原生 ssh 客户端同阶。

**Plugin UI 首屏（headless Chrome，同一 25.1MB 产物，baseline / 本轮改动
交替 5 对，`file://` 加载）**

| 指标 | baseline 中位 | 改动后中位 | 变化 |
| --- | --- | --- | --- |
| `domContentLoadedEventEnd` | 565 ms | **533 ms** | −32 ms（−5.7%），5 对全部变快 |
| `first-paint` | 364 ms | **328 ms** | −36 ms（−10%） |

上限实测（临时把 `@file-viewer` 装配替换为空 preset 后重新构建）：
产物 25.10 MB → **13.66 MB**，`domContentLoaded` 中位 ≈ **340 ms**。
即余下约 11.4 MB 的 renderer 字节仍随首屏付文本解析成本。

模块体积取证（rolldown `generateBundle`，本轮改动后的产物）：

```
4,089,377  src/lib/completion/worker/engine.worker.ts?worker&inline   (base64 inline worker)
2,009,607  @file-viewer/renderer-pdf/vendor/pdfjs/.../pdf.worker.mjs
1,366,455  heic2any
1,188,138  rtf.js
1,053,919  prettier/plugins/typescript.mjs
  888,811  @file-viewer/renderer-pdf/vendor/pdfjs/.../pdf.mjs
  777,535  @file-viewer/pptx/dist/worker.js
  723,684  styled-exceljs
  639,412  src/lib/i18n.ts
  609,376  src/App.vue
  ...
```

### 本轮改动（已完成）

- `frontend/src/App.vue:451-459`：`TextPreview` / `PreviewPane` /
  `JsonPreviewPanel` 由静态 import 改为
  `defineAsyncComponent(() => import(...))`。产物仍是单文件（
  `codeSplitting: false`，见 `frontend/build.mjs:25-29`），但模块体留在
  惰性工厂里，首屏不再求值整条预览链路（CodeMirror 语言包 +
  `@file-viewer` renderer）。
- `frontend/src/lib/workbench.spec.ts:926-941`：模板组件解析守卫把
  `const X = defineAsyncComponent(...)` 视为合法 script-setup 绑定，
  否则异步组件会被误报「未导入」。
- 新增 `frontend/src/connectFirstPaint.spec.ts`（6 例）：锁住三个预览组件
  必须异步装载、不得回退静态 import。

### 后续方案（按风险从低到高，均属 #326 的下一步）

1. **把预览 renderer 移出 single-file 文档**（收益最大，约 11.4 MB /
   ~300ms 量级）。单文件的成因是双宿主差异：
   - 桌面宿主：`pluginUiHtmlCache.ts:52-56` 给出 `dbx-plugin://…/<pluginId>/`
     资产 base，`pluginHostBridge.ts:1228` 的 CSP 把该资产源放进了
     `script-src`（`script-src 'unsafe-inline' blob:<assetSource>`），
     外链 chunk 在桌面侧可行。
   - Web 宿主：`pluginUiHtmlCache.ts:53` 在非 Tauri 直接返回 `undefined`
     （无 `<base>`），CSP 的 `script-src` 也就没有资产源，
     外链 chunk 会被拦——所以今天必须单文件。
   - 方案 A（需宿主，推荐）：Web 宿主为插件 UI 提供资产 base + CSP 源，
     随后 `frontend/build.mjs` 只内联入口，renderer 作为独立 chunk
     按需 `import()`。桌面侧现有契约已满足，改动集中在 web 宿主。
   - 方案 B（插件侧，但需设计评审）：把 renderer 构建成独立文件，运行时经
     `host.readAsset` 取回后用 `Blob` + `import(blob:...)` 装载；两宿主
     CSP 都允许 `blob:`。难点是跨 bundle 无法共享同一个 Vue 运行时实例，
     需要把 Vue 提到全局共享层并做模块映射，风险中等，建议单独提案。
2. **`password_command` 与拨号并行**（插件侧，收益因用户配置而异）：
   现在 `open_session` 在拨号前串行执行 `resolve_password_command`
   （`backend/src/ssh.rs:2375` 前，实现在 `:212-239`），走本地子进程
   （`backend/src/triggers.rs:378-383`，10s 超时）。可改为在 TCP/KEX 期间
   并行求值、`authenticate_none` 之后再 join，语义不变（命令仍只跑一次）。
   难点是 `connect_authenticated` 需把解析后的连接继续交给 open_session 的
   sudo 编排，属于认证路径的小重构，需单独评审。
3. **按连接缓存远端 shell 探测结果**（插件侧，收益 ~1-2 RTT / 后续会话）：
   `detect_remote_shell` 每会话一条 exec 通道；同一连接同一账号的 shell
   稳定，可在 `SshRuntime` 按 connectionId 缓存 Bash/Zsh 结果
   （`store_connection` / 断开时失效）。只影响重复开会话/重连，
   对「第一次连接」无收益，且 shell 中途切换会退化为「无 CWD 跟踪」，
   需要产品确认是否值得。
4. **拨号预热（`connection/connect` 时预认证）**：能力上可行（宿主本来就是
   「点击即拨号」语义，见 `PluginBottomDock.vue:268-272` 注释），但 MFA/
   host-key 挑战没有 webview 可应答、批量连接可能造成静默失败登录计数，
   **不建议**在没有宿主配合的情况下做。

### 需要报告者补充的信息（回复中已请求）

- 宿主版本 / OS、`[plugin-ui-boot]` 日志里的 `iframeLoad=xxms`（宿主每次
  工作台开屏都打，见
  `host/apps/desktop/src/components/plugins/PluginWorkbenchHost.vue:866`）。
- 「慢」是首次点击就慢，还是重连/开新 tab 慢；对比的客户端（SecureCRT /
  Termius / 系统 ssh）与同机到同一跳板的 `ssh -v` 握手耗时。
- 连接信息气泡（终端右上 Info）里的延迟值、是否经过跳板机/代理。

---

## #327「多选多个 SSH 连接，同时分屏打开 + 批量发送命令」

### 结论：**needs host**（插件侧能力已覆盖一半，缺的是宿主选择数据与分屏编排）

### 现状取证

**插件侧已具备**

- 工作台内分屏：`frontend/src/composables/useSplitPanes.ts:1-20`（设计契约）、
  `:26`（`SPLIT_PANE_MAX = 3`）、`:220-247`（`addPane`，同连接、复用已认证
  transport）、`:295-315`（镜像副屏 `openPicker`，可挂任意存活会话）。
  「一键并行开满」在 `:284-292`（#304）。
- 跨会话批量发送：`ssh/terminal/batchInput`
  （`docs/PROTOCOL.zh-CN.md:121`、`:968`），目标来自
  `ssh/sessions/list` 的全部活跃会话
  （`frontend/src/composables/useBatchSend.ts:30-31`、`:172-191`），
  与分屏/其它 tab 解耦。

**宿主侧已有**

- 连接多选模型：`host/apps/desktop/src/stores/connectionStore.ts:546-549`
  （`connectionMultiSelectActive`）、`TreeItem.vue:705-745`
  （选择集/复选框）、`useSidebarConnectionMutationRuntime.ts:235-250`
  （对选择集批量 connect）。批量 disconnect 亦同。
- 分屏是宿主 shell 的 editor group：`queryStore.splitTab`
  （`host/apps/desktop/src/stores/queryStore.ts:1612-1640`，上限 4 组），
  由宿主 UI/命令驱动。

**缺口（精确）**

1. 插件拿不到「侧栏当前多选了哪些连接」：插件→宿主桥的方法清单里没有
   `getSelection` 一类入口（`pluginHostBridge.ts:657-1100` 全量分支），
   插件命令的 context 只带单个 `connectionId`（
   `PluginBottomDock.vue:262-280`，
   `connection_targets` 是单选启动器 `:216-260`）。
2. 插件不能创建/移动宿主分屏：桥只暴露
   `host.openWorkbench` / `host.reopenConnection` / `host.getConnections`
   （`pluginHostBridge.ts:194、215、876`），没有 split；manifest 命令动作
   也只有 `open-workbench`（`host/crates/dbx-plugin-runtime/src/plugins/manifest.rs:958-981`）。
3. 即使插件自己弹出连接多选，每个目标连接还需要宿主先下发
   `connection/connect`（`host.reopenConnection` 可做，`pluginHostBridge.ts:859-863`），
   而且 `useSplitPanes.addPane` 目前硬编码当前连接的
   `deps.connectionId()`（`:221`），要扩成「指定连接 + 新拨号」的副屏变体。
   连接清单本身已有免新权限的通路：`host.listConnections` 只要求
   `host.workbench`（`pluginHostBridge.ts:882-893`，插件已在批量发送里使用，
   见 `frontend/src/composables/useBatchSend.ts:186`）。

**插件侧可先做的（不依赖宿主，但只解决一半）**：在插件工作台里做一个
连接多选面板（数据源 `host.listConnections`），对选中的每个连接先
`host.reopenConnection` 再 `host.openWorkbench`（带 `connectionId`，
`queryStore.openPluginWorkbench` 支持任意 connectionId，
`host/apps/desktop/src/stores/queryStore.ts:4686-4688`）——可以一次打开
N 个**标签页**，但仍是宿主 tab 条，不是分屏；分屏位置只能宿主决定。

### 建议的宿主 API（二选一，提案）

- **最小改动（推荐给宿主）**：侧栏多选时提供宿主动作「在分屏中打开所选连接」，
  直接在宿主内完成 `ensureConnected × N` + 打开 N 个 plugin-workbench tab
  + `splitTab` 编排（宿主自己就有 4 组上限与焦点规则）；插件零改动，
  批量命令继续用现成 `ssh/terminal/batchInput`。
- **通用改动**：插件桥增加
  `host.selection()`（返回 `{kind:"connection", ids:[...]}`）或给命令
  context 注入 `connectionIds[]`，并增加
  `host.openWorkbenchMany(contributionId, contexts[])` 或
  `host.splitActiveGroup()`；同时把 split 上限/降级规则写进契约。
  有了这两块，插件可自己实现「多选 → N 个副屏窗格」，复用现有
  `useSplitPanes`（需扩展成可指定 connectionId）。

---

## #328「自动检测延迟，显示在左侧 SSH 连接列表」

### 结论：**needs host**（宿主按设计尚未发布动态 badge / 状态更新协议）

### 现状取证

- manifest 贡献点只有 8 类：
  `host/crates/dbx-plugin-runtime/src/plugins/manifest.rs:280-289`
  （connection-provider / workbench / filesystem / context-menu /
  result-view / command / menus / mcp）；连接提供者字段
  `:713-740` 与能力 `:748-754` 只有 test/connect/disconnect，
  **没有** 状态/徽标/latency 字段或轮询钩子。
- 仓库内的宿主 UI 提案明确把动态 badge 列为「未发布」：
  `docs/HOST_PLUGIN_UI_SPEC.zh-CN.md:6`（「状态栏、动态 badge、树视图…
  留待运行时状态协议明确后再发布」）、`:44`、`:338-344`
  （发布前要先定义状态更新 API、最大更新频率、降级）。
- 侧栏连接行是宿主所有：`TreeItem.vue:1708` 只渲染宿主的
  `ConnectionBadgeIcon`（connected 态）；`ConnectionTree.vue:1046-1056`
  是宿主预留的状态/控件槽（连接行 38px）。插件没有行内渲染位。
- 宿主有 `host.connections:read`（插件侧需声明该权限，当前 SSH manifest
  未声明；`host.listConnections` 走 `host.workbench` 可免新权限但只给本插件
  自己的连接），返回的是 secret-free 摘要
  （`connected`/`readOnly` 等），见
  `host/apps/desktop/src/lib/plugins/pluginHostBridge.ts:876-895` 与
  `host/docs/content/docs/plugin-development.mdx:149、560-590`；
  没有任何「插件上报连接状态」的反向通道。
- 插件已有**手动**延迟面：连接信息气泡里的 echo 往返探测
  （`frontend/src/composables/useConnectionInfo.ts:43-61`，渲染在
  `App.vue:9570-9597` 附近；底层复用 `ssh/exec`，不新增协议）。
  它不自动轮询、不在侧栏、也不跨连接。

### 建议的宿主 API（提案）

1. 连接行状态槽：允许 connection-provider 声明
   `status: { source: "poll" | "event", minIntervalMs }`，宿主在行尾渲染
   `{latencyMs}` 文本/徽标（沿用现在预留的 38px 槽，避免横向跳动）。
2. 数据面（二选一）：
   - 宿主轮询 provider 新方法 `connection/probe`（建议 sidecar 实现为
     「已有会话时 echo 一次；无会话时退化为一次 TCP/banner 探测，
     **不做完整认证**」），返回 `{latencyMs, reachable}`；
   - 或插件用 `host.reportConnectionStatus({connectionId, latencyMs, at})`
     主动上报，宿主按 `minIntervalMs` 限流。
   不建议宿主直接周期调用现有 `connection/test`：那是完整握手
   （`backend/src/ssh.rs:3153` 起），开销与服务器登录审计都不可接受。
3. 降级：无会话/探测失败显示 `—`；不要用 0 或上次缓存冒充在线。

### 插件侧可先做的部分交付（不依赖宿主，供产品取舍）

- 连接信息气泡增加「自动刷新」开关（默认关，间隔 ≥5s，复用现有
  `ssh/exec` 探测）；终端连接成功后自动测一次并记住本会话最近延迟。
- 工作台状态栏（插件自己的 UI 区）显示当前连接延迟；或用
  `host.openFloating`（宿主浮动窗，见
  `host/docs/content/docs/plugin-development.mdx:802`）做一个常驻小挂件，
  显示当前连接/全部活跃会话的延迟。真正「左侧连接列表每行一个延迟」仍然
  必须等宿主槽位。

---

## 可直接贴的回复稿

### #326

> 感谢反馈。我们把连接链路拆开量了一遍：插件的 `connection/connect`
> 只登记配置不拨号，真正的 SSH 握手发生在打开终端时；本机回环实测
> TCP+握手+认证约 10–26ms，认证后开 channel/PTY/shell 约 1.5ms，
> 链路上没有固定 sleep 或多余的串行往返。广域网下它和系统 ssh 客户端
> 一样，主要由「约 7–8 个 RTT + 服务器启动 shell」决定。
>
> 我们确实找到一处插件侧可优化点：工作台 UI 是宿主用 srcdoc 单文件加载的，
> 目前 25MB，其中文件预览（PDF/Office/表格/媒体）的渲染器此前在连接首屏
> 就被装载。已改成按需装载，同机实测首屏可提前约 30–40ms，5 组交替测量
> 全部变快；剩下的字节成本需要宿主侧资源加载配合，已单独提给宿主评审。
>
> 想进一步定位您那边的慢在哪一段，麻烦补充：
> 1) 宿主版本与系统；2) 宿主日志里每次开工作台的
> `[plugin-ui-boot] … iframeLoad=xxx ms`；3) 是首次点开就慢，还是重连/
> 新开标签页慢；4) 同一跳板、同一台机器用系统 `ssh -v` 的握手总耗时；
> 5) 连接是否经过跳板机/代理，以及终端右上「连接信息」里显示的延迟值。
> 有了这些我们能判断是 UI 首屏、网络 RTT 还是跳板/认证链的问题。

### #327

> 感谢建议。现状是：插件内已经支持分屏（同一连接最多 3 个副屏，可挂其他
> 连接已打开的会话）和跨会话批量发送命令（目标包含所有活跃会话，
> 不区分连接）。缺的是「在左侧多选连接 → 一次并行开成多个分屏」这段编排：
> 多选是宿主侧的选择模型，插件的命令/工作台拿不到这份选择集，分屏布局也
> 由宿主管理、插件桥没有创建分屏的接口。
>
> 因此这条需要宿主先开一个入口，两个可选方向：
> 1) 宿主在连接多选时直接提供「在分屏中打开所选连接」（宿主自己
>    ensureConnected 并开 tab/分屏，最省事）；2) 给插件命令注入
>    `connectionIds[]`，并允许插件请求打开多个工作台/分屏。
> 插件侧分屏与批量命令可直接复用，不需要重写。
>
> 也想确认一下您的使用场景：是希望 N 个连接各占一个独立分屏窗格
> （横向平铺），还是希望它们都进同一个窗格组、配合批量命令一起操作？
> 一次最多多少个连接？这会影响宿主分屏上限（当前宿主最多 4 组）的设计。

### #328

> 感谢建议。这个功能本身合理，但目前左侧连接列表是宿主 UI，插件没有
> 「在连接行尾渲染状态/徽标」的贡献点，也没有向宿主上报连接状态的通道——
> 宿主侧的动态 badge/状态协议还在设计阶段（插件清单里目前只有连接类型、
> 工作台、命令等静态贡献点），所以这一条必须先由宿主提供槽位与限流协议，
> 插件才能把延迟值画到连接名后面。
>
> 插件这边已经有可用的底层能力：终端右上「连接信息」里可以手动测一次
> echo 往返延迟（复用现有 exec 通道，无需新协议）。如果宿主提供
> 「状态槽 + 插件轮询/上报」的契约，我们可以直接接上；探测方式建议用
> 轻量 echo/TCP 探测，而不是周期性跑完整连接测试（那会触发真实登录，
> 对服务器审计不友好）。
>
> 想确认几个细节：延迟希望多久刷新一次（5s/10s/30s）？断线或探测失败
> 时显示 `—` 还是保留上次值？是否希望只在连接已打开时显示，还是对
> 未打开的连接也常驻显示？

---

## 附：本轮验证

- `vue-tsc --noEmit`：0 错。
- `vitest run`：**228 文件 / 2366 例全绿**（含新增
  `src/connectFirstPaint.spec.ts` 6 例、`src/lib/workbench.spec.ts` 69 例）。
- `node frontend/build.mjs`：产出单文件 UI 25,102,411 B，自带护栏通过。
- 后端零改动（未跑 cargo；#326 的 sidecar 结论来自 release 二进制实测）。
