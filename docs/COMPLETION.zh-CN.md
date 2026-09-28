# 命令建议与补全架构（Completion Engine）

本文说明终端命令建议/补全的实现分层、交互语义与扩展方式（issue #120 系列）。

## 分层

```
lib/completions/spec.ts          schema + splitCommandLine（token 边界）+ matchSpecLine（层级匹配/评分）
lib/completions/specs/*.ts       静态 spec 数据（git/docker/kubectl/.../cd，index.ts 聚合）
lib/completions/provider.ts      动态补全 provider 注册表（分支/文件/pod 等不可枚举值）
lib/completions/remoteFsProvider.ts  首个真实 provider：SFTP 面板已加载条目（零新增远端调用）
lib/completions/figImport.ts     Fig/Amazon Q spec JSON → SpecCommand 归一化（build-time）
lib/overlayPlacement.ts          浮层几何：下方/上方翻转、右缘 clamp、max-height 内滚（纯函数）
lib/commandSuggestions.ts        历史/快速命令模糊检索（spec 未命中时回落）
lib/terminalGhostSuggest.ts      行内 ghost 自动建议状态机
components/CommandSuggestions.vue / CompletionMenu.vue   展示层（键盘语义在 App.vue）
```

## 交互语义（重要）

- 浮层**自动出现 ≠ 接管键盘**：
  - **Enter 恒定放行 shell 执行当前输入行**（浮层只是预览；要执行建议先 Tab 填充）。
  - **Tab**：接受高亮的静态候选（子命令/flag/枚举值）；高亮为动态 hint 行
    （分支/文件/pod 等本地不可枚举）时 Tab **透传给远程 shell** 自身补全。
  - ↑↓ 菜单内导航；Esc 关闭；鼠标点击即填充。
- 接受候选项按 `SpecMatch.replaceStart/replaceEnd`（parser 给出的行尾 token
  精确边界，含引号/转义表面）做范围替换；尾空格语义：无参 → 直接续敲，
  带参 flag → 补空格进入 value 层。

## 定位

- 锚点：`.xterm-screen`（内容区原点，自动计入可配置内边距）+ 光标网格坐标；
  回显解析完成（`settleOutputChunk` → rAF 合帧）后重读，消除 SSH RTT 滞后。
  ghost 与建议浮层共用同一 `readTerminalCellFrame()`。
- 放置：下方放得下 → 下方（光标行底 + 6px）；否则翻转到光标上方（底边贴
  光标行顶 − 6px）；两侧都不够选空间更大一侧并收窄 max-height 内滚。可视
  底界取 terminal-host 净高（batch-bar/标记条让位后自动变小）。右缘超界时
  整体左移（两侧各 8px）。
- resize/fit 时主动重定位（terminal-host 的 ResizeObserver 挂钩）。

## 动态补全 provider

```ts
import { registerDynamicCompletionProvider } from "./lib/completions/provider";
import { createRemoteFsProvider } from "./lib/completions/remoteFsProvider";

registerDynamicCompletionProvider(
  createRemoteFsProvider(() => ({
    currentPath: currentPath.value,        // SFTP 面板当前目录
    entries: entries.value,                // 该目录已加载条目（内存，零远端调用）
  })),
);
```

- 注册后，`cd` 等标记 `positional.dynamic` 的命令在 hint 层出现时异步询问
  provider，返回候选即替换占位提示；未注册/返回 null/超时（1.2s）时保持
  hint + Tab 透传，零行为回归。
- 首个实现 `remoteFsProvider` 只用 SFTP 面板**已加载**条目（目录与面板当前
  目录一致才处理），不产生任何新增远端 I/O。任意目录的 `sftp/list` 缓存、
  `git branch`、kubectl resource 等 provider 后续按同接口接入。

## Fig / Amazon Q spec 导入（已退役）

`scripts/import-fig-specs.mjs` 与 `lib/completions/**` 手写 spec 原型已随
FIG wave-1 最终架构退役：补全语义改由 vendored amazon-q parser + withfig
全量语料承担（`frontend/vendor/`、`frontend/src/lib/completion/fig/`），
同步/校验走 `pnpm --dir frontend fig:sync` / `fig:verify`，详见
`docs/FIG_ROADMAP.zh-CN.md` 与 `docs/fig-specs-size-report.md`。
