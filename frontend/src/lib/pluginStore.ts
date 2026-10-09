// ssh 插件工作台 UI 状态持久化单点（宿主 host.storage，Host API 1.2）。
//
// 背景：工作台 iframe 是 opaque origin，localStorage 直接抛 SecurityError，
// 本插件全部"活"的前端 UI 偏好键在真机上静默失效；统一经 pluginStore
// （宿主桥 → guarded localStorage → 内存，见 shared/frontend/pluginStorage）
// 读写，键名保持不变。通道与降级语义、旧键搬家见适配器文档。
//
// 明确不进本 store 的键（保持直读 localStorage）：以下键全部是
// sidecar preferences.json 权威 + localStorage 仅作 web 直连场景的同步缓存
// （App.vue cachePrefs/hydratePrefs 写穿，迁走即双权威）：
// - ssh-download-directory / ssh-download-use-default-dir /
//   ssh-download-conflict-policy
// - ssh-transfer-concurrency / ssh-transfer-max-active /
//   ssh-transfer-download-limit-kib / ssh-transfer-duplicate-policy /
//   ssh-transfer-compress-mode / ssh-transfer-compress-threshold-mib
// - ssh-sftp-compat-mode / ssh-sftp-name-encoding
// - ssh-history-suggestions-enabled / ssh-history-suggestion-min-chars /
//   ssh-history-suggestion-max-chars
// 另：
// - ssh-quick-commands：曾是 localStorage 活键（M32 前旧档），M32 迁 sidecar
//   后本键闲置；存储迁移批 1（IMPL_PLAN_STORAGE_SYNC）重新以同名键成为
//   pluginStore 活键——同名接力让适配器的惰性搬家自动把 localStorage 旧档
//   带入宿主通道，sidecar 旧数据则由调用方经 RPC 一次性搬迁（键缺失才搬）。
// - dbx-term-diag（App.vue）：控制台手动开启的诊断开关，非用户偏好，
//   沙箱内本就不可写，guarded 直读保持原状。

import { createPluginKvStore } from "../../../shared/frontend/pluginStorage";

/** 本插件全部活的 UI 状态键（宿主 storage 无列键方法，水合需显式声明）。 */
export const PLUGIN_STORE_KEYS: readonly string[] = [
  "sftp-path-history",
  "ssh-command-history",
  // 命令 → 最近执行时刻（Warp 式 history 面板右侧相对时间），与命令环同一
  // 采集口推进；wire 形态 [{c,t}]，命令环清空/淘汰时同步修剪。
  "ssh-command-history-times",
  // history 面板富元数据（执行时长 + 退出码，wire 形态 [{c,d,x}]）：与命令环
  // 同一采集口推进、随命令环修剪（App.vue persistCommandHistoryMeta）。
  // 必须在册：宿主 storage 水合只拉白名单键，漏注册 = 每次启动面板列全丢。
  "ssh-command-history-meta",
  "ssh-sftp-pane-open",
  "ssh-follow-directory",
  "ssh-sftp-side-tab",
  "ssh-sftp-side-collapsed",
  "ssh-terminal-select-copy",
  "ssh-keyword-highlight",
  "ssh-batch-bar-open",
  "ssh-terminal-search-options",
  "ssh-terminal-webgl",
  "ssh-terminal-font-size",
  "ssh-terminal-font-family",
  "ssh-terminal-behavior",
  "ssh-terminal-hotkeys",
  "ssh-terminal-appearance",
  // dock 面板（底部栏）精简工具条的隐藏偏好（"1" = 隐藏）。
  "ssh-panel-toolbar-hidden",
  // 结构化补全引擎选择（FIG wave-1，契约 §2.3）：SettingsDialog 引擎下拉
  // 自治读写，App 每次调度前直读（fig-safe 默认 / fig / off；fig 与 fig-safe
  // 批次 1 行为相同，差异自 generator 接线起）。
  "ssh-completion-engine",
  // 会话连接弹窗的上次参数记忆（Telnet/Serial/VNC）：弹窗打开时回填、
  // 提交时写穿；凭据类字段不落盘。
  "telnet-connect-last",
  "serial-connect-last",
  "vnc-connect-last",
  // 行内 ghost 自动建议（对标 Warp 线 1）：SettingsDialog 开关行自治读写，
  // 默认开。
  "ssh-terminal-ghost-suggest",
  // 「Tab 接受建议」可选开关（ghostAcceptKey.ts 自治读写，默认关）。
  "ssh-ghost-tab-accept",
  // 历史面板功能开关（issue #169）：关 = 面板整体不可唤起（↑ 与 Ctrl+R 归还
  // 远端 shell 原生历史/反向搜索）。SettingsDialog 开关行自治读写，默认开。
  "ssh-history-panel-enabled",
  // 建议黑名单（对标 Warp IgnoredSuggestionsModel，suggestionBlocklist.ts
  // 自治读写）：点 ✗ 屏蔽的单条建议不再提示。
  "ssh-suggestion-blocklist",
  // AI 助手三开关 + AI 修复「不再询问」授权位（Warp AI 对齐批）：单键 JSON
  // 映射（search/fix/assist/fixConsent），lib/aiSettings.ts 拆装。
  "ssh-ai-assist",
  // Docker/Podman 引擎连接设置：单键 JSON 映射（connectionKey → settings）。
  // 按连接的动态键无法在创建期声明（宿主 storage 无列键），收进一个结构化
  // 值由 dockerEngine.ts 自行拆装；曾用 localStorage 动态键，在工作台
  // opaque origin 沙箱里属性访问即抛 SecurityError，从未发布过无需迁移。
  "ssh-docker-engine",
  // Per-connection SSH forwarding presets used by the independent tunnel manager.
  "ssh-tunnel-profiles",
  // 存储迁移批 1（IMPL_PLAN_STORAGE_SYNC）：全局偏好三域的权威键——快速命令
  // / 关键词高亮规则 / SFTP 路径书签。原 sidecar JSON 文件降级为一次性迁移
  // 种子（各域 load*FromStore 返回 null 才搬迁，空清单不复活）。
  "ssh-quick-commands",
  "ssh-highlight-rules",
  "ssh-sftp-bookmarks",
  // MCP 设置镜像（批 1 收尾）：sidecar 仍即时消费 mcp-settings.json，本键只
  // 存可同步子集作云同步载荷（保存双写 + 启动播种/收敛，settingsModel.ts）。
  "ssh-mcp-settings",
  // 存储迁移批 2（IMPL_PLAN_STORAGE_SYNC）：连接级设置四域的镜像键（值内
  // 按 connectionId 分桶，connectionSettingMirror.ts 助手）。sidecar 仍即时
  // 权威（审批门/会话启动/SFTP 列目录现读），镜像只作云同步载荷；条目级
  // 播种/收敛在设置弹窗与工具栏面板。
  "ssh-startup-commands",
  "ssh-name-encoding-overrides",
  "ssh-agent-modes",
  "ssh-agent-approved-commands",
  // 存储迁移批 3（IMPL_PLAN_STORAGE_SYNC）：传输/下载/历史建议 14 个偏好键合并单镜像（preferencesMirror.ts，
  // 键名与 local/preferences wire 一致）；sidecar 即时权威，保存双写 + 启动播种/收敛。
  "ssh-preferences-mirror",
  // 外部编辑器配置（扩展名→编辑器关联/默认编辑器/自定义命令/回传策略）：
  // 单键 JSON（editorRules.ts 拆装净化），纯前端消费——打开时把解析结果
  // 传给 sidecar `local/open-with`，sidecar 不读此配置。
  "ssh-editor-config",
];

export const pluginStore = createPluginKvStore([...PLUGIN_STORE_KEYS]);

// 结构化补全引擎（FIG wave-1 契约 §2.3）：三态 + 缺省/容错归一到 fig-safe。
// App（调度门）与 SettingsDialog（下拉读写）共用同一类型与净化函数，避免
// 两处字面量分叉；键随 PLUGIN_STORE_KEYS 声明（宿主 storage 水合后可读）。
export type CompletionEngineSetting = "fig-safe" | "fig" | "off";
export const COMPLETION_ENGINE_KEY = "ssh-completion-engine";

export function sanitizeCompletionEngine(value: unknown): CompletionEngineSetting {
  return value === "fig" || value === "off" ? value : "fig-safe";
}

/** 每次调度前直读（无缓存即时生效；存储不可用时回默认）。 */
export function loadCompletionEngine(): CompletionEngineSetting {
  try {
    return sanitizeCompletionEngine(pluginStore.getItem(COMPLETION_ENGINE_KEY));
  } catch {
    return "fig-safe";
  }
}
