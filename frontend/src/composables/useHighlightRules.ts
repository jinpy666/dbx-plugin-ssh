import { computed, ref } from "vue";
import { compileRules, normalizeHighlightRules, type HighlightRuleView } from "../lib/keywordHighlight";
import { pluginStore } from "../lib/pluginStore";

/** 关键词高亮数据面（IMPL_PLAN_NETCATTY_PARITY §3-B1）：权威规则表 CRUD，
 * 数据走 ssh/highlightRules/*（后端不可用静默空表）；编辑器视图在
 * HighlightRulesSection（设置·终端，M32-A2）。渲染引擎仍在 App.vue。 */
export function useHighlightRules(options: {
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
}) {
  const { showError } = options;

// 关键词高亮总开关（IMPL_PLAN_NETCATTY_PARITY §3-B1）：pluginStore 全局持久化，
// 默认开、仅显式 "false" 关；关闭时零挂钩子。
const HIGHLIGHT_ENABLED_KEY = "ssh-keyword-highlight";

const highlightRules = ref<HighlightRuleView[]>([]);
// 编辑器草稿/弹层状态已迁 HighlightRulesSection（设置·终端，M32-A2）；
// App 只留权威规则表与在途态（经 SettingsDialog props 下发）。
const highlightSaving = ref(false);
const compiledHighlightRules = computed(() => compileRules(highlightRules.value));

function loadHighlightEnabled(): boolean {
  try {
    return pluginStore.getItem(HIGHLIGHT_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

// 总开关（pluginStore 持久化，渲染引擎读取；M32-A2 后设置内无全局开关——
// 规则逐条带 enabled，按条启停即可）。
const highlightEnabled = ref(loadHighlightEnabled());

async function hydrateHighlightRules() {
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/list", {});
    highlightRules.value = normalizeHighlightRules(response.rules);
  } catch {
    // 后端不可用（如旧版 sidecar）：静默降级空表，高亮功能整体退场。
    highlightRules.value = [];
  }
}

// 数据面（M32-A2）：RPC 留在 App，编辑器视图在 HighlightRulesSection
// （设置·终端）。入参已经组件内 sanitize，这里只负责落库与刷新权威态。
async function saveHighlightRule(rule: { id?: string; pattern: string; color: string; isRegex: boolean; caseSensitive: boolean }) {
  if (highlightSaving.value) return;
  highlightSaving.value = true;
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/save", {
      id: rule.id ?? "",
      pattern: rule.pattern,
      isRegex: rule.isRegex,
      color: rule.color,
      caseSensitive: rule.caseSensitive,
    });
    highlightRules.value = normalizeHighlightRules(response.rules);
  } catch (cause) {
    showError(cause, "terminal");
  } finally {
    highlightSaving.value = false;
  }
}

async function toggleHighlightRule(item: HighlightRuleView) {
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/save", {
      id: item.id,
      pattern: item.pattern,
      isRegex: item.isRegex,
      color: item.color,
      caseSensitive: item.caseSensitive,
      enabled: !item.enabled,
    });
    highlightRules.value = normalizeHighlightRules(response.rules);
  } catch (cause) {
    showError(cause, "terminal");
  }
}

async function deleteHighlightRule(id: string) {
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/delete", { id });
    highlightRules.value = normalizeHighlightRules(response.rules);
  } catch (cause) {
    showError(cause, "terminal");
  }
}

  return {
    highlightRules,
    highlightSaving,
    highlightEnabled,
    compiledHighlightRules,
    hydrateHighlightRules,
    saveHighlightRule,
    toggleHighlightRule,
    deleteHighlightRule,
  };
}
