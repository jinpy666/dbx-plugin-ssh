import { computed, ref } from "vue";
import {
  compileRules,
  loadHighlightRulesFromStore,
  persistHighlightRules,
  upsertHighlightRule,
  type HighlightRuleView,
} from "../lib/keywordHighlight";
import { pluginStore } from "../lib/pluginStore";

/** 关键词高亮数据面（IMPL_PLAN_NETCATTY_PARITY §3-B1 → 存储迁移批 1）：权威
 * 规则表 CRUD 走 pluginStore（宿主 ui-storage.json，随 DBX secrets 同步加密
 * 上云）；sidecar ssh/highlightRules/* 仅作首次运行的一次性搬迁种子（键缺失
 * 才搬）。编辑器视图在 HighlightRulesSection（设置·终端，M32-A2）。渲染引擎
 * 仍在 App.vue。 */
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

// 水合顺序：pluginStore 权威值（键缺失时才搬）→ sidecar 一次性搬迁（空表也
// 落键，标记"已迁移"）→ sidecar 不可用（旧版/降级）静默空表兜底。
async function hydrateHighlightRules() {
  const stored = loadHighlightRulesFromStore();
  if (stored !== null) {
    highlightRules.value = stored;
    return;
  }
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/list", {});
    highlightRules.value = persistHighlightRules(
      (response.rules as HighlightRuleView[] | undefined) ?? [],
    );
  } catch {
    // 后端不可用（如旧版 sidecar）：键未落，下次启动重试搬迁；空表兜底。
    highlightRules.value = [];
  }
}

// 数据面：入参已经组件内 sanitize，这里只负责 upsert/启停/删除与落盘。
async function saveHighlightRule(rule: { id?: string; pattern: string; color: string; isRegex: boolean; caseSensitive: boolean }) {
  if (highlightSaving.value) return;
  highlightSaving.value = true;
  try {
    highlightRules.value = persistHighlightRules(upsertHighlightRule(highlightRules.value, rule));
  } finally {
    highlightSaving.value = false;
  }
}

async function toggleHighlightRule(item: HighlightRuleView) {
  highlightRules.value = persistHighlightRules(
    upsertHighlightRule(highlightRules.value, { ...item, enabled: !item.enabled }),
  );
}

async function deleteHighlightRule(id: string) {
  highlightRules.value = persistHighlightRules(highlightRules.value.filter((rule) => rule.id !== id));
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
