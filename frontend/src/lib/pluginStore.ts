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
  "ssh-sftp-pane-open",
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
  "ssh-terminal-ghost-suggest",
];

export const pluginStore = createPluginKvStore([...PLUGIN_STORE_KEYS]);
