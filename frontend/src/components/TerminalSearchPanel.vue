<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ChevronDown, ChevronUp, Search, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { persistSearchOptions, type TerminalSearchOptions } from "../lib/terminalInteraction";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

type TerminalSearchMatchState = "idle" | "match" | "no-match";

interface Props {
  locale: string;
  /** Seed query from the current terminal selection (may be empty). */
  initialQuery?: string;
  /** Persisted toggle state restored by the parent on open. */
  initialOptions?: TerminalSearchOptions;
  matchState: TerminalSearchMatchState;
  resultIndex: number;
  resultCount: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  findNext: [query: string, options: { caseSensitive: boolean; regex: boolean; wholeWord: boolean }];
  findPrevious: [query: string, options: { caseSensitive: boolean; regex: boolean; wholeWord: boolean }];
  clear: [];
  close: [];
}>();

const query = ref(props.initialQuery ?? "");
const caseSensitive = ref(props.initialOptions?.caseSensitive ?? false);
const useRegex = ref(props.initialOptions?.regex ?? false);
const wholeWord = ref(props.initialOptions?.wholeWord ?? false);
const input = ref<HTMLInputElement>();

// ToggleGroup（multiple）以字符串数组建模；桥接到三个独立布尔开关。
const toggleValues = computed<string[]>({
  get: () => [caseSensitive.value ? "case" : "", useRegex.value ? "regex" : "", wholeWord.value ? "word" : ""].filter(Boolean),
  set: (values) => {
    caseSensitive.value = values.includes("case");
    useRegex.value = values.includes("regex");
    wholeWord.value = values.includes("word");
  },
});

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const statusText = computed(() => {
  if (props.matchState === "no-match" && query.value) return t("terminalSearch.noMatch");
  if (props.matchState === "match" && props.resultCount > 0) return t("terminalSearch.matchIndex", { index: props.resultIndex, count: props.resultCount });
  return "";
});

function searchOptions() {
  return { caseSensitive: caseSensitive.value, regex: useRegex.value, wholeWord: wholeWord.value };
}

function emitSearch(direction: "next" | "prev") {
  if (!query.value) {
    emit("clear");
    return;
  }
  if (direction === "prev") emit("findPrevious", query.value, searchOptions());
  else emit("findNext", query.value, searchOptions());
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    emitSearch(event.shiftKey ? "prev" : "next");
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
}

watch([caseSensitive, useRegex, wholeWord], () => {
  persistSearchOptions(searchOptions());
  if (query.value) emitSearch("next");
});

onMounted(() => {
  input.value?.focus();
  input.value?.select();
  // 带入选区种子时立即执行一次查找，面板打开即出结果。
  if (query.value) emitSearch("next");
});
</script>

<template>
  <div class="terminal-search-panel" role="search" :aria-label="t('terminalSearch.open')" @keydown="onKeydown" @mousedown.stop @contextmenu.stop>
    <div class="terminal-search-row">
      <span class="terminal-search-icon" aria-hidden="true"><Search /></span>
      <input
        ref="input"
        v-model="query"
        class="terminal-search-input"
        type="text"
        spellcheck="false"
        :aria-label="t('terminalSearch.open')"
        :placeholder="t('terminalSearch.placeholder')"
        @input="emitSearch('next')"
      />
      <button type="button" class="terminal-search-btn" :title="t('terminalSearch.prev')" :aria-label="t('terminalSearch.prev')" @click="emitSearch('prev')"><ChevronUp /></button>
      <button type="button" class="terminal-search-btn" :title="t('terminalSearch.next')" :aria-label="t('terminalSearch.next')" @click="emitSearch('next')"><ChevronDown /></button>
      <button type="button" class="terminal-search-btn" :title="t('terminalSearch.close')" :aria-label="t('terminalSearch.close')" @click="emit('close')"><X /></button>
    </div>
    <div class="terminal-search-options">
      <ToggleGroup v-model="toggleValues" type="multiple" class="terminal-search-toggles" :aria-label="t('terminalSearch.open')">
        <ToggleGroupItem value="case" :title="t('terminalSearch.caseSensitive')">Aa</ToggleGroupItem>
        <ToggleGroupItem value="regex" :title="t('terminalSearch.regex')">.*</ToggleGroupItem>
        <ToggleGroupItem value="word" :title="t('terminalSearch.wholeWord')">|w|</ToggleGroupItem>
      </ToggleGroup>
      <span class="terminal-search-status" :data-state="matchState" role="status">{{ statusText }}</span>
    </div>
  </div>
</template>

<style scoped>
.terminal-search-panel {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 7;
  display: flex;
  width: 320px;
  max-width: calc(100% - 24px);
  flex-direction: column;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px;
  background: var(--popover);
  box-shadow: var(--shadow-popover);
  font-size: 11px;
}

.terminal-search-row {
  display: flex;
  align-items: center;
  gap: 3px;
}

.terminal-search-icon {
  display: inline-grid;
  place-items: center;
  color: var(--muted-foreground);
}

.terminal-search-icon svg {
  width: 13px;
  height: 13px;
}

.terminal-search-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  outline: none;
  background: color-mix(in srgb, var(--background) 95%, var(--foreground));
  color: var(--foreground);
  font-family: var(--terminal-font-family);
}

.terminal-search-input:focus {
  border-color: color-mix(in srgb, var(--primary) 70%, var(--border));
}

.terminal-search-btn {
  display: inline-grid;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  place-items: center;
  border: 0;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}

.terminal-search-btn:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.terminal-search-btn svg {
  width: 13px;
  height: 13px;
  stroke-width: 1.7;
}

.terminal-search-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.terminal-search-toggles {
  display: flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.terminal-search-toggles button {
  min-width: 26px;
  height: 20px;
  border: 0;
  padding: 0 6px;
  background: transparent;
  color: var(--muted-foreground);
  font-family: var(--terminal-font-family);
  font-size: 10px;
  cursor: pointer;
}

.terminal-search-toggles button + button {
  border-left: 1px solid var(--border);
}

.terminal-search-toggles button:hover {
  background: var(--accent);
}

.terminal-search-toggles button[data-state="on"] {
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  color: var(--primary);
}

.terminal-search-status {
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-search-status[data-state="no-match"] {
  color: var(--destructive);
}
</style>
