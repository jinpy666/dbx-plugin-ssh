# DBX SSH 插件 Open Issue 分诊报告（M30-B）

**仓库**：`jinpy666/dbx-plugin-ssh`
**分诊基线**：`codex/ssh/parity-np30-issues` @ `63931060`（integration = `codex/ssh/nyaterm-parity-integration`）
**对照线**：`integration`（63931060）与 `main`（`03ab46c8`）
**分诊时间**：2026-09-26
**样本**：全部 20 条 open issue（`gh issue list --state open --limit 30`）

## 判据与口径

每条结论都基于三类可核验证据，不使用推测：

1. **代码事实**：`integration` 工作树内的实现（文件路径 + 行号）；
2. **提交/分支事实**：`git merge-base --is-ancestor <commit> HEAD` 与 `git log`（分支是否已进 integration）；
3. **工单讨论**：维护者在 issue 评论中的定性（与代码冲突时以代码为准）。

结论分类：

| 类别 | 含义 |
| --- | --- |
| **已修复-随 XX 并入** | 修复已在 main 或某分支落地，等并入 integration / 随发布即可关闭 |
| **已交付** | 能力已在 integration 实现并可指明文件行号，issue 只是滞后未关 |
| **可自动化-本轮实施** | 低风险、可本地验证、不碰 manifest.json，本轮已动手 |
| **需人工** | 依赖上游宿主、需补充复现信息、或属大改（超 ~150 行 / 涉协议认证语义） |

**重要基线事实**：`main` 与 `integration` 目前只差 3 个 commit，其中 `03ab46c8`（#116 修复）**只在 main、尚未进 integration**；反向 `integration` 领先 main 342 个 commit（终端外观、命令建议、热键、OTP、MCP 归一化等 M19.5-M29 全部批次）。因此"已修但未进 integration"与"已交付"必须分开标注。

---

## 一、结论摘要

| 类别 | 条数 | issue |
| --- | --- | --- |
| 已修复-随 XX 并入 | 1 | #116 |
| 已交付（代码已实现，建议核验后关闭） | 3 | #105、#91、#80 |
| 已交付 + 本轮实施（核心已交付，本轮补残留缺口） | 2 | #73、#77 |
| 需人工（上游依赖 / 需补料 / 大改） | 14 | #108、#103、#100、#96、#95、#90、#78、#76、#75、#72、#66、#57、#25、#23 |

合计 **1 + 3 + 2 + 14 = 20**，与 open issue 总数一致（每条只归一个主类别；#73/#77 的"本轮实施"作为叠加标注，不重复计数）。

> 计数说明：#73 与 #77 的核心修复**早就在 integration**（分别是 `21c66bf2` 与 `dcf42057`/`6c96c1fe`），本轮补的是各自的**残留缺口**——#73 是"主题底色仍会落黑"的另一半来源（viewport 黑边已在 `21c66bf2` 修掉），#77 是"缺少防合并覆盖的自动回归守卫"（该缺陷已复发一次）。因此这两条按"已交付 + 本轮实施"单独成栏，既不冒领已交付的功劳，也不把新缺口混进"需人工"。

**本轮实施 2 条分别是**：#77（新增裸调用回归守卫 `frontend/src/lib/uuidCallSites.spec.ts`，含反向验证）、#73（新增底色净化 `frontend/src/lib/terminalBackground.ts` + `App.vue` 调用点）。

---

## 二、逐条分诊表

| # | 标题 | 类别 | 分诊结论 | 证据 |
| --- | --- | --- | --- | --- |
| 116 | sftp 文件下载出错（bug） | 已修复-随 M30-A 并入 | **修复已在 main（`03ab46c8`），尚未进 integration**；随 M30-A 并入 integration 后即可关闭 | `git merge-base --is-ancestor 03ab46c8 HEAD` = false；`= origin/main` = true。修复内容：`frontend/src/lib/standaloneBuffer.ts`（新增）+ `App.vue` 三处 `fileTransfer.write` 改传独立 ArrayBuffer；根因是宿主桥 transfer 列表只收 ArrayBuffer，Uint8Array 视图被 Chromium 拒绝（`Value at index 0 does not have a transferable type`），凡走该路径的下载 100% 抛 DOMException 而 sidecar 零异常——与 issue 截图"传输卡落已取消/无异常信息"完全吻合 |
| 108 | 阿里云堡垒机不兼容 | 需人工（部分已交付） | 三点诉求：①堡垒机内选目标机（**大改**，需跳板链重构）②**Ctrl+F 终端搜索已交付**（默认 `Ctrl+Shift+F`，可在设置改绑）③**免重认证复制会话已交付** | ②`frontend/src/lib/terminalHotkeys.ts:53`（`search` 默认 `other: ["Ctrl+Shift+F"]`，设置页可改绑）+ `App.vue:11674` `TerminalSearchPanel`；③`App.vue:5315` `openCopiedSessionTab()`（复用已认证 transport，即"复制会话"）；①无实现，需人工立项 |
| 105 | 希望支持命令提示功能 | 已交付（建议核验后关闭） | 输入即提示已完整实现：模糊建议浮层 + 行内 ghost 自动建议，均接命令历史与快速命令，含设置项 | `frontend/src/lib/commandSuggestions.ts:96` `searchCommands()`（fzf 风格子序列匹配 + 评分）；`frontend/src/lib/terminalGhostSuggest.ts:175` `evaluateGhost()`（前缀扩展才提示，→ 一次接受）；`App.vue:11648` `CommandSuggestions` 浮层挂载；设置键 `history_suggestions_enabled`（`SettingsDialog.vue:1940-1955`）。引入提交 `cee2c909`/`81341342`/`19cde734`，三者均 `--is-ancestor HEAD` = true |
| 103 | SSH 插件光标无法聚焦 | 需人工（需补料） | 维护者已按"焦点归属"方向回复并索要两点信息（终端打开方式、是否仅本插件），提问者未回复；无新增定位证据 | issue 评论（jinpy666）；现有焦点路径可见 `App.vue:8840` `focusSftpPaneOnPointerDown` / `modalFocus.ts`，但无法复现"快捷键失效"的宿主侧拦截，需用户环境确认 |
| 100 | SFTP 面板拖拽上传文件失败 | 需人工（需补料 + 复现） | 提问者描述"删同名文件后上传，刷新后文件与同名文件夹都不见"，怀疑删除误伤目录；**代码侧 `recursive` 判定按 `entry.kind === "directory"` 明确区分，未见误删路径**，需按环境复现 | `App.vue:7557`（单条删除 `recursive: deleteTarget.value.kind === "directory"`）与 `App.vue:7704`（批量删除同款判定）；后端 `backend/src/ssh.rs:4595` `sftp_delete` 以 `symlink_metadata` 判型：symlink 走 `remove_file`、dir 才 `remove_dir`/`delete_directory_tree`，**不跟随符号链接**。维护者已在 issue 内追问"都升级到最新了吗"，未获答复 |
| 96 | json 预览格式化 + 复制 | 需人工（中等改动，未立项） | 未实现：`TextPreview.vue` 只有 CodeMirror 语法高亮，无 JSON 美化、无复制字段/整文动作 | `frontend/src/components/TextPreview.vue` 全文 93 行，`grep -c "JSON.parse"` = 0；预览弹窗在 `App.vue:12409`（`previewOpen`）。诉求可拆三项小改动（美化按钮、复制字段值、复制全文），但仍需新 UI 动作与文案，非纯逻辑——本轮未纳入 |
| 95 | 终端执行 git 看不到内容 | 需人工（需复现定位） | 截图形态为**输出被部分吞掉**（只剩红色碎片），属渲染/流解析缺陷；可疑组件已排序但无复现数据 | 上轮盘点（`.workbuddy/reports/issue-triage-2026-09-22.zh-CN.md`）已锁定候选：`terminalCommandMarkers.ts`（OSC 633 流式消费）、`terminalTrzsz.ts` `processServerOutput` 过滤器、`registerOscColorQueryHandlers`、`terminalWriteThrottle` 合并边界。**需提问者给出确切命令 + DBX 版本 + 原始字节**才能二分定位 |
| 91 | 字体/行间距/字间距无法设置 | 已交付（建议核验后关闭） | 行间距、字间距、字重、内边距、光标形态、配色方案全部已实现（含设置项与实时预览） | `frontend/src/lib/terminalAppearance.ts:53,55`（设置模型 `lineHeight` / `letterSpacing`）+ `:403,404`（`TerminalOptionPatch`）+ `:412-417` 默认值；`SettingsDialog.vue:1418-1423` 数字输入项（行高 1-3、字距 -5-10）；预览 `SettingsDialog.vue:1293`。字体族/字号更早由 issue #31 交付（`lib/terminalFont.ts`） |
| 90 | sz 命令下载无反应（enhancement） | 需人工（中等改动，未立项） | zmodem **只有发送方向**（`rz` 上传），`sz` 下载被静默 deny；trzsz 链路已支持下载但 `sz` 用户不会主动改工具 | `frontend/src/App.vue:3229-3234` `handleZmodemDetection`：`pendingZmodemFiles.length` 为 0 或 `role !== "send"` 时直接 `detection.deny()`（无任何用户提示）；`frontend/src/lib/terminalZmodem.ts` 全文仅有 `createZmodemSentry` / `sendZmodemFiles`，`grep -c "receive\|recv"` = 0。维护者已表态"优先级不高，欢迎 PR"；#65 为该条重复项 |
| 80 | 选中即复制/右键粘贴无效果 | 已交付（宿主限制已绕过） | 两条路径都已实现，且**针对宿主沙箱拦截做了降级链**（插件视图剪贴板副本缓存） | `App.vue:2407` `terminal.onSelectionChange`（选中即复制）+ `frontend/src/lib/terminalInteraction.ts:22` `resolveTerminalRightClickAction`（右键四档：off/menu/paste/clipboard）；沙箱降级见 `lib/clipboardBridge.ts`（host bridge → navigator.clipboard → execCommand）与提交 `1a79a92d`（右键粘贴经插件视图副本缓存，`--is-ancestor HEAD` = true）。维护者评论"网页版好使，dbx 里事件拦截了，要等"已过期 |
| 78 | 希望支持文件夹上传功能 | 需人工（中等改动，未立项） | 未实现：无目录选择入口、无递归上传状态机；后端仅有**下载**方向的 `sftp_tree.rs` 可对称改造 | `grep -rn "webkitdirectory" frontend/src` = **0 命中**；`sftpFolderDownload.ts` 只覆盖下载（`sftp/download/tree/start`）；上传为单文件 `uploadLocalFiles`（`App.vue:8063`，对 `dataTransfer.files` 逐文件）。属中等改动（前后端 + 状态机），本轮未纳入 |
| 77 | 非 https 下 crypto.randomUUID is not a function | 已交付 + **本轮实施** | shim 早已在 integration（`lib/uuid.ts` + 6 处调用点全部走 shim），issue 所述 0.7.0 回归也已由 `6c96c1fe` 修复；**本轮补上防"合并覆盖"复发的自动守卫**（该问题已复发过一次，两次都靠人眼 review 发现） | 已交付：`frontend/src/lib/uuid.ts:5`（特性检测 + `getRandomValues` 手工拼 v4）、`App.vue:1647` 等 6 处调用点全部 `import { randomUUID } from "./lib/uuid"`，全仓非 shim 文件 `grep "crypto.randomUUID("` = **0 命中**；`dcf42057`/`6c96c1fe` 均 `--is-ancestor HEAD` = true。本轮新增 `frontend/src/lib/uuidCallSites.spec.ts`（见 §三） |
| 76 | 支持秘钥同步吗 | 需人工（上游依赖） | `vault.rs` 已实现本机加密密钥库（keyfile / keychain 双后端），**跨设备同步依赖宿主同步通道**，插件侧无落点 | `backend/src/vault.rs`；维护者已定性"等 dbx 支持" |
| 75 | 阿里云短信验证码无法输入 | 需人工（已部分交付，需核验） | 登录期交互式 MFA 通道**已实现**（无保存在册凭据的空答案会弹宿主密文框向用户要码）；需提问者在含 MFA 的环境核验短信码路径 | `backend/src/ssh.rs:560` `request_keyboard_interactive_answer`（注释明确"hardware token, SMS code, custom MFA wording"）+ 调用点 `:7771`（空答案逐个向用户提问）；配套 `scripts/smoke_login_mfa_test.py` 场景 11（未保存动态码 + 中文 MFA 提问 → 弹窗输入登录成功）。引入于 `codex/ssh/issue-11-69-hostkey-userinput`（`--is-ancestor HEAD` = true） |
| 73 | DBX 主题背景图片导致终端背景变黑 | 已交付（部分）+ **本轮实施** | 黑边框来源已由 `21c66bf2` 修复（进 integration）；**本轮补上"主题底色落黑"的另一半**：宿主背景图下发的 transparent / var() / color-mix() 底色会让 xterm 解析失败并静默回退内建 `#000` | 已交付：`21c66bf2`（`.terminal-host .xterm .xterm-viewport` 提高特异性压过 xterm 6.1-beta 的 `#000` 规则，`--is-ancestor HEAD` = true）；本轮新增 `frontend/src/lib/terminalBackground.ts` + 调用点 `App.vue:2043`（见 §三）。**残留（登记后续）**：让背景图真正透出终端需 xterm `allowTransparency: true`，涉及渲染器/WebGL 取舍，属独立决策 |
| 72 | Docker 环境新建连接超时（关联 #69） | 需人工（主因已修，残留待复核） | 根因（host key 确认无应答者 → 请求被 10s 超时掐断）**已修复并合入 integration**；提问者复核后报"创建连接正常了，但打开连接仍白屏"——白屏已转宿主侧（t8y2/dbx#10205），插件侧另有 `d4b82b60` 修 dock 面板空白面板 | `codex/ssh/issue-11-69-hostkey-userinput`（`host/requestUserInput` 通道，`--is-ancestor HEAD` = true）；`backend/src/ssh.rs:429`（走宿主弹窗）+ `:567`（能力不足返回 None 降级）；`d4b82b60` "show the connect-error card in dock panels instead of a blank panel"（`--is-ancestor HEAD` = true）。**白屏主因在宿主**，插件侧无法单方闭环，需 DBX 版本跟进 |
| 66 | ftp 下载限速 | 需人工（中等改动，未立项） | 未实现：无任何限速字段/令牌桶 | `grep -rn "maxSpeed\|rateLimit\|throttleBytes" backend/src frontend/src` = **0 命中**；`frontend/src/lib/downloadPrefs.ts` 仅冲突策略（rename/ask/overwrite）三档，无速率项。issue 正文为空（仅标题）。属分块循环改造的中等改动 |
| 57 | 建议对接 AI 助手 | 需人工（上游依赖为主，MCP 侧已可用） | 应用内 AI 助手需宿主能力；**插件侧已通过 MCP 提供外部 Agent 操作服务器的完整通道**（31 个 SSH/SFTP 工具 + DBX MCP 桥 + `--mcp` 独立 stdio） | `docs/MCP.zh-CN.md`、`docs/MCP_USAGE.zh-CN.md`；`backend/src/mcp.rs`、`frontend/src/lib/agentTerminal.ts`（AI 终端同步执行契约）、`backend/src/agent_approvals.rs`（审批记忆）。维护者已在 issue 内给出 `--mcp` 独立注册配置示例。**建议：补齐"当前如何用外部 Agent 操作服务器"的答复并保留 open 跟踪应用内助手** |
| 25 | 对于堡垒机不兼容（反复连接） | 需人工（需补料） | 维护者已索要堡垒机型号与细节，提问者未回复；无新增定位证据 | issue 评论（jinpy666"什么堡垒机，提供更详细的信息"）。与登录期 MFA / 跳板机相关的能力已部分落地（`issue-11-69-hostkey-userinput` 分支的交互式认证通道），但"反复连接"具体表现需设备信息才能定位 |
| 23 | SSH 插件无法正常连接（P0） | 需人工（需补料） | 截图为 `os error 10054`（握手期被服务端 FIN），与"Finalshell 能连"并存→最大嫌疑是算法协商或服务端策略，插件侧无算法协商日志可判 | issue 截图（`10054`）；维护者已在 issue 内追问"最新版是否解决"，未获答复。需 `ssh -vvv <host>` 与插件侧 trace 对比。相关能力近年已批量收敛（0.4.7x 线修掉 #1/#11/#21/#22/#55/#58、#9/#13/#15/#17/#30），本条属"更硬的边缘样本" |

---

## 三、本轮实施项（2 项，均前端纯逻辑 + 单测）

### 3.1 #73 终端底色净化（新增 `frontend/src/lib/terminalBackground.ts`）

**动机（新证据）**：在 `@xterm/xterm@6.1.0-beta.304` 的打包产物中直接核实到落黑机制，比上轮盘点的推断更硬：

```js
// xterm.js ThemeService._setTheme：
t.background = m(e.background, _);          // _ = css.toColor("#000000")
// 该 helper 解析失败即静默回退传入常量：
function m(e,t){ if(void 0!==e) try { return a.css.toColor(e) } catch {} return t }
```

而 `css.toColor` 只可靠处理四类输入：hex（3/4/6/8 位）、**逗号分隔**的 `rgb()/rgba()`、字面 `transparent`（解析成功但 `rgba=0`）；其余走 canvas 探针，探针在 detached 上下文对 `var()`/`color-mix()` 这类**需级联求值**的形态必抛 `Unsupported css format`。宿主设背景图时下发的 `--color-background` 恰好常落这两类 → 静默黑底。`21c66bf2` 修的只是 viewport 的 `#000` 规则（黑边框那一半），主题底色自身这半没有兜住。

**改动**：
- 新增 `frontend/src/lib/terminalBackground.ts`（103 行，纯函数）：`sanitizeTerminalBackground(value, colorScheme)` + 导出的谓词 `isUnusableTerminalBackground(value)`。仅拦"可证明 xterm 拿不到色"的四类（空值 / 字面 `transparent` / 需级联求值的函数形态 / 显式 `alpha≤0`），**其余一律原样透传**（hsl、命名色不改写），保证宿主颜色保真。
- 调用点 `frontend/src/App.vue:2043`（`hostTerminalTheme()`）：净化后的底色同时喂 xterm `ITheme` 与 `--ssh-terminal-background` 变量，两者取值一致；`--background` 等 UI 变量不经过本模块。

**单测**：`frontend/src/lib/terminalBackground.spec.ts`（9 用例）——三类坏值 + 可用值透传矩阵 + 回退值必须取自当前明暗色板 + 规范色板自身可用性（防"回退源自己被判坏"失去兜底）。

**登记未做**：让宿主背景图真正透出终端需 xterm `allowTransparency: true`（连带渲染器/WebGL 取舍），属独立决策，未纳入本轮。

### 3.2 #77 裸 `crypto.randomUUID` 回归守卫（新增 `frontend/src/lib/uuidCallSites.spec.ts`）

**动机**：issue #77 正文明确指出该修复**已经回归过一次**——0.7.0 发布分支合并 main 时把带保护的调用覆盖回裸写法，最终 5 个平台的安装包都含该缺陷。两次都靠人眼在 review 中发现，**没有任何自动检查兜住**。修复早已在 integration（见 §二 #77 行），所以本轮的正确动作是"核实 + 补回归守卫"，而非重写 shim。

**改动**：新增 `frontend/src/lib/uuidCallSites.spec.ts`（98 行，4 用例），手法沿用仓库既有 `i18nKeyReferences.spec.ts` 的 `import.meta.glob(..., "?raw")` 源码扫描：
1. glob 自检（>100 文件、含 App.vue 与 shim），防 glob 写坏后检查变成"永远通过"；
2. **全量扫描非 shim 源码，任何裸 `crypto.randomUUID(` / `globalThis.crypto.randomUUID(` 调用即失败**，报错信息带 `文件:行号`；
3. 钉住 shim 自身的特性检测前提（若 shim 被改成裸调用，白名单会变成漏网通道）；
4. 钉住 App.vue 确实 `import { randomUUID } from "./lib/uuid"`。

**反向验证（关键）**：把 `App.vue:1647` 的 `randomUUID()` 临时改回 `crypto.randomUUID()`（复刻 #77 所述的合并覆盖形态），守卫如期失败并精确报出 `../App.vue:1647 -> crypto.randomUUID(`；恢复后转绿。这证明守卫对该缺陷形态真实有效，而不是空跑。

**验证**：`pnpm vitest run` **1092/1092 通过**（基线 1079 + 13 新增）/ `vue-tsc --noEmit` 0 错误 / `python3 scripts/validate_repo.py` PASS。

---

## 四、需人工项清单（11 条）

按建议处置优先级排列：

| 优先级 | # | 项目 | 建议动作 |
| --- | --- | --- | --- |
| 1 | 25、23、103、100 | 需补料才能定位（堡垒机型号 / `ssh -vvv` 日志 / 焦点环境 / 上传复现步骤） | 在 issue 内定向追问，附最小复现模板；其中 #23 标 P0，建议优先 |
| 2 | 72 | 白屏主因在宿主（t8y2/dbx#10205） | 跟进宿主修复；插件侧已修的部分（hostkey 通道、dock 空白面板）可回复说明 |
| 3 | 90、96、78、66 | 明确未实现的中等改动（zmodem 下载 / JSON 预览动作 / 目录上传 / 下载限速） | 立独立 milestone 立项；#78 可对称复用后端 `sftp_tree.rs` |
| 4 | 95 | 唯一"输出会被吞"的缺陷，价值最高 | 尽快索取确切命令 + DBX 版本 + 原始字节，再二分定位 |
| 5 | 75 | 能力已落地，缺用户侧核验 | 请提问者在含短信 MFA 的环境复测并回报 |
| 6 | 76、57 | 依赖宿主能力 | 说明现状（`vault.rs` 本机加密可用 / MCP 通道已可用）后保留 open 跟踪上游 |
| 7 | 108 | 其中一点属大改（堡垒机内选目标机需跳板链重构） | 拆分为独立 issue：Ctrl+F 与复制会话两点可先回复已交付，目标机选择单独立项 |

---

## 五、附注：本轮未关闭任何 issue

按任务约定，本报告**只产出分诊结论**，不执行 `gh issue close`——关闭由人工决定。建议的关闭候选（需人工核验后执行）：

1. **#116** — 待 M30-A 把 `03ab46c8` 并入 integration 后；
2. **#77、#73** — 本轮已补残留缺口，可连同 `dcf42057`/`6c96c1fe`/`21c66bf2` 的证据一并关闭；
3. **#105、#91、#80** — 代码证据完整，建议请提问者在新版本复测后关闭；
4. **#108** — 建议先拆分（见 §四 第 7 项）再关闭已交付的两点。

## 六、验证方法（可复现）

```bash
# 分支合并态
git merge-base --is-ancestor <commit> HEAD && echo IN || echo NOT-IN

# issue 全量
gh issue list --state open --limit 30
gh issue view <n> --json number,title,body,labels,comments

# 前端验证
export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$HOME/Library/pnpm:$PATH"
cd frontend && pnpm vitest run && pnpm exec vue-tsc --noEmit

# 仓库校验
python3 scripts/validate_repo.py
```

本次分诊未安装或重启任何 DBX 环境，未使用真实凭据，未改动 `manifest.json`，未关闭任何 issue。
