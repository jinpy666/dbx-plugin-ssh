// ssh 插件工作台 UI 状态持久化单点（宿主 host.storage，Host API 1.2）。
//
// 背景：工作台 iframe 是 opaque origin，localStorage 直接抛 SecurityError，
// 本插件全部"活"的前端 UI 偏好键在真机上静默失效；统一经 pluginStore
// （宿主桥 → guarded localStorage → 内存，见 shared/frontend/pluginStorage）
// 读写，键名保持不变。通道与降级语义、旧键搬家见适配器文档。
//
// 明确不进本 store 的键（保持直读 localStorage）：
// - ssh-download-directory / ssh-download-use-default-dir /
//   ssh-download-conflict-policy：权威在 sidecar preferences.json
//   （local/preferences/*），localStorage 仅作 web 直连场景的同步缓存
//   （App.vue cachePrefs/hydratePrefs）。
// - ssh-transfer-concurrency / ssh-transfer-duplicate-policy /
//   ssh-history-suggestions-enabled / ssh-history-suggestion-min-chars /
//   ssh-history-suggestion-max-chars：同上，sidecar preferences 权威 +
//   localStorage 同步缓存（App.vue cachePrefs/hydratePrefs），迁走即双权威。
// - ssh-quick-commands：已迁 sidecar 全局存储，localStorage 旧键仅作一次性
//   迁移种子（App.vue hydrateQuickCommands），不再作为活键。
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
  // Docker/Podman 引擎连接设置：单键 JSON 映射（connectionKey → settings）。
  // 按连接的动态键无法在创建期声明（宿主 storage 无列键），收进一个结构化
  // 值由 dockerEngine.ts 自行拆装；曾用 localStorage 动态键，在工作台
  // opaque origin 沙箱里属性访问即抛 SecurityError，从未发布过无需迁移。
  "ssh-docker-engine",
  // Per-connection SSH forwarding presets used by the independent tunnel manager.
  "ssh-tunnel-profiles",
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
