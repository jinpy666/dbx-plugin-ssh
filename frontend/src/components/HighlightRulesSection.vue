<script setup lang="ts">
// 关键词高亮规则编辑节（M32-A2）：从工具条弹层迁入设置·终端。
// 纯编辑器视图：草稿/校验在组件内，数据面（ssh/highlightRules/* RPC）
// 留在 App——save 后 App 会整体替换 rules 数组，组件据此复位草稿。
import { computed, reactive, ref, watch } from "vue";
import { Pencil, Trash2 } from "@lucide/vue";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { HIGHLIGHT_COLOR_DEFAULT, sanitizeHighlightRuleInput, type HighlightRuleView } from "../lib/keywordHighlight";

const props = defineProps<{
  rules: HighlightRuleView[];
  saving: boolean;
  limit: number;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  (e: "save", rule: { id?: string; pattern: string; color: string; isRegex: boolean; caseSensitive: boolean }): void;
  (e: "delete", id: string): void;
  (e: "toggle", item: HighlightRuleView): void;
}>();

const t = props.t;

// 色板（从 App.vue 工具条弹层迁入）：8 个常用高亮色 + 自由 hex 输入。
const HIGHLIGHT_PALETTE = ["#ef4444", "#f59e0b", "#facc15", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];

const draftError = ref("");
const draft = reactive({ id: undefined as string | undefined, pattern: "", color: HIGHLIGHT_COLOR_DEFAULT, isRegex: false, caseSensitive: false });
// ToggleGroup（multiple）以字符串数组建模；这里桥接到 draft 的两个布尔标志位。
const flagValues = computed<string[]>({
  get: () => [draft.isRegex ? "regex" : "", draft.caseSensitive ? "case" : ""].filter(Boolean),
  set: (values) => {
    draft.isRegex = values.includes("regex");
    draft.caseSensitive = values.includes("case");
  },
});

// 数据面在 App：RPC 成功后 rules 数组被整体替换（引用变化），借此感知
// "本次保存/删除已落库" 再复位草稿；失败时引用不变，草稿保留可继续改。
let awaitingSaveResult = false;
let awaitingDeleteId: string | null = null;
watch(() => props.rules, () => {
  if (awaitingSaveResult) {
    awaitingSaveResult = false;
    resetDraft();
  }
  if (awaitingDeleteId !== null) {
    if (draft.id === awaitingDeleteId) resetDraft();
    awaitingDeleteId = null;
  }
});

function resetDraft() {
  draft.id = undefined;
  draft.pattern = "";
  draft.color = HIGHLIGHT_COLOR_DEFAULT;
  draft.isRegex = false;
  draft.caseSensitive = false;
  draftError.value = "";
}

function editRule(item: HighlightRuleView) {
  draft.id = item.id;
  draft.pattern = item.pattern;
  draft.color = item.color;
  draft.isRegex = item.isRegex;
  draft.caseSensitive = item.caseSensitive;
  draftError.value = "";
}

function saveRule() {
  if (props.saving) return;
  const sanitized = sanitizeHighlightRuleInput({ pattern: draft.pattern, color: draft.color, isRegex: draft.isRegex, caseSensitive: draft.caseSensitive });
  if (sanitized.error || !sanitized.value) {
    draftError.value = t(sanitized.error ?? "highlightRules.invalidPattern");
    return;
  }
  if (!draft.id && props.rules.length >= props.limit) return;
  awaitingSaveResult = true;
  emit("save", sanitized.value);
}

function deleteRule(id: string) {
  awaitingDeleteId = id;
  emit("delete", id);
}
</script>

<template>
  <div class="highlight-section">
    <div v-if="!rules.length" class="empty compact">{{ t("highlightRules.empty") }}</div>
    <div v-else class="highlight-rule-list highlight-rule-list--section">
      <div v-for="item in rules" :key="item.id" class="highlight-rule-row">
        <span class="highlight-color-dot" :style="{ backgroundColor: item.color }" />
        <div class="highlight-rule-main">
          <span class="highlight-rule-pattern mono" :class="{ disabled: !item.enabled }" :title="item.pattern">{{ item.pattern }}</span>
          <span class="highlight-rule-badges">
            <span v-if="item.isRegex">regex</span>
            <span v-if="item.caseSensitive">Aa</span>
          </span>
        </div>
        <span class="highlight-rule-actions">
          <label class="highlight-switch-control" :title="t('highlightRules.enabled')">
            <input type="checkbox" :checked="item.enabled" @change="emit('toggle', item)" />
          </label>
          <button class="icon-button" :title="t('quickCommandsEdit')" @click="editRule(item)"><Pencil /></button>
          <button class="icon-button" :title="t('delete')" @click="deleteRule(item.id)"><Trash2 /></button>
        </span>
      </div>
    </div>
    <footer class="highlight-editor">
      <div class="highlight-editor-inputs">
        <input v-model="draft.pattern" :placeholder="t('highlightRules.patternPlaceholder')" :maxlength="200" spellcheck="false" @keydown.enter="saveRule" />
        <ToggleGroup v-model="flagValues" type="multiple" class="highlight-editor-flags">
          <ToggleGroupItem value="regex" class="highlight-editor-flag-item" :title="t('highlightRules.regex')">.*</ToggleGroupItem>
          <ToggleGroupItem value="case" class="highlight-editor-flag-item" :title="t('highlightRules.caseSensitive')">Aa</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div class="highlight-palette">
        <button v-for="swatch in HIGHLIGHT_PALETTE" :key="swatch" type="button" class="highlight-palette-swatch" :class="{ selected: draft.color.toLowerCase() === swatch }" :style="{ backgroundColor: swatch }" :aria-label="swatch" @click="draft.color = swatch" />
        <input v-model="draft.color" class="highlight-hex-input mono" :title="t('highlightRules.color')" :maxlength="7" spellcheck="false" />
      </div>
      <div class="highlight-editor-actions">
        <span class="highlight-rule-limit">{{ t("highlightRules.limit", { count: rules.length, limit }) }}</span>
        <button v-if="draft.id" @click="resetDraft">{{ t("cancel") }}</button>
        <button class="primary-button" :disabled="saving || !draft.pattern.trim() || (!draft.id && rules.length >= limit)" @click="saveRule">{{ draft.id ? t("save") : t("highlightRules.add") }}</button>
      </div>
      <p v-if="draftError" class="task-error">{{ draftError }}</p>
    </footer>
  </div>
</template>

<style scoped>
/* 设置页语境：列表不再吃弹层的视口高度上限，交给 settings-pane 滚动。 */
.highlight-rule-list--section { max-height: none; }
</style>
