<script setup lang="ts">
import { computed } from "vue";
import { Copy, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import type { QuickSelectHit, QuickSelectKind } from "../lib/quickSelect";

/**
 * Quick Select overlay panel (WezTerm counterpart, WT-1): renders the regex
 * hits collected by lib/quickSelect.ts as a list; clicking an entry (or Enter
 * on the active one, handled by the terminal key path) copies its text.
 * Mirrors TerminalSearchPanel: a pane-anchored overlay so the terminal keeps
 * focus and the hotkey registry path handles Esc/arrows/Enter uniformly.
 */
interface Props {
  locale: string;
  hits: QuickSelectHit[];
  activeIndex: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  activate: [index: number];
  copy: [hit: QuickSelectHit];
  close: [];
}>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const KIND_CLASS: Record<QuickSelectKind, string> = { url: "url", path: "path", ipv4: "ipv4", hash: "hash" };
const KIND_LABEL_KEY: Record<QuickSelectKind, string> = { url: "quickSelect.kindUrl", path: "quickSelect.kindPath", ipv4: "quickSelect.kindIp", hash: "quickSelect.kindHash" };

const titleText = computed(() => {
  const base = t("quickSelect.title");
  return props.hits.length > 0 ? `${base} · ${t("quickSelect.count", { count: props.hits.length })}` : base;
});

function kindLabel(kind: QuickSelectKind): string {
  return t(KIND_LABEL_KEY[kind]);
}

function onHitMousedown(event: MouseEvent, index: number) {
  // mousedown 不转移焦点（焦点留在终端，Esc/↑↓/Enter 仍走注册表派发路径）。
  event.preventDefault();
  emit("activate", index);
}
</script>

<template>
  <div class="terminal-quick-select" role="dialog" :aria-label="t('quickSelect.title')" @mousedown.stop.prevent @contextmenu.stop>
    <div class="terminal-quick-select-row">
      <span class="terminal-quick-select-title">{{ titleText }}</span>
      <button type="button" class="terminal-quick-select-btn" :title="t('quickSelect.close')" :aria-label="t('quickSelect.close')" @click="emit('close')"><X /></button>
    </div>
    <ul v-if="hits.length" class="terminal-quick-select-list" role="listbox" :aria-label="t('quickSelect.title')">
      <li v-for="(hit, index) in hits" :key="`${hit.kind}-${hit.row}-${hit.col}-${index}`">
        <button
          type="button"
          class="terminal-quick-select-hit"
          role="option"
          :aria-selected="index === activeIndex"
          :class="{ active: index === activeIndex }"
          :data-kind="KIND_CLASS[hit.kind]"
          @mousedown="onHitMousedown($event, index)"
          @mouseenter="emit('activate', index)"
          @click="emit('copy', hit)"
        >
          <span class="terminal-quick-select-kind">{{ kindLabel(hit.kind) }}</span>
          <span class="terminal-quick-select-text mono">{{ hit.text }}</span>
          <span class="terminal-quick-select-copy"><Copy /></span>
        </button>
      </li>
    </ul>
    <div v-else class="terminal-quick-select-empty">{{ t("quickSelect.empty") }}</div>
    <div v-if="hits.length" class="terminal-quick-select-hint">{{ t("quickSelect.hint") }}</div>
  </div>
</template>

<style scoped>
.terminal-quick-select {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 7;
  display: flex;
  width: min(640px, calc(100% - 48px));
  max-height: 70%;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--popover);
  box-shadow: var(--shadow-popover);
  font-size: 11px;
}

.terminal-quick-select-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 5px 8px;
}

.terminal-quick-select-title {
  min-width: 0;
  overflow: hidden;
  color: var(--popover-foreground);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-quick-select-btn {
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

.terminal-quick-select-btn:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.terminal-quick-select-btn svg {
  width: 13px;
  height: 13px;
  stroke-width: 1.7;
}

.terminal-quick-select-list {
  margin: 0;
  overflow-y: auto;
  padding: 4px;
  list-style: none;
}

.terminal-quick-select-hit {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 4px;
  padding: 4px 6px;
  background: transparent;
  color: var(--popover-foreground);
  cursor: pointer;
  text-align: left;
}

.terminal-quick-select-hit.active {
  background: var(--accent);
  color: var(--accent-foreground);
}

.terminal-quick-select-kind {
  flex: 0 0 auto;
  min-width: 34px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
  color: var(--muted-foreground);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-align: center;
  text-transform: uppercase;
}

.terminal-quick-select-hit[data-kind="url"] .terminal-quick-select-kind { color: #60a5fa; border-color: color-mix(in srgb, #60a5fa 45%, transparent); }
.terminal-quick-select-hit[data-kind="path"] .terminal-quick-select-kind { color: #4ade80; border-color: color-mix(in srgb, #4ade80 45%, transparent); }
.terminal-quick-select-hit[data-kind="ipv4"] .terminal-quick-select-kind { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 45%, transparent); }
.terminal-quick-select-hit[data-kind="hash"] .terminal-quick-select-kind { color: #f472b6; border-color: color-mix(in srgb, #f472b6 45%, transparent); }

.terminal-quick-select-text {
  min-width: 0;
  overflow: hidden;
  flex: 1;
  font-family: var(--terminal-font-family);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-quick-select-copy {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--muted-foreground);
  opacity: 0;
}

.terminal-quick-select-hit.active .terminal-quick-select-copy,
.terminal-quick-select-hit:focus-visible .terminal-quick-select-copy {
  opacity: 1;
}

.terminal-quick-select-copy svg {
  width: 12px;
  height: 12px;
  stroke-width: 1.7;
}

.terminal-quick-select-empty {
  color: var(--muted-foreground);
  padding: 14px 10px;
  text-align: center;
}

.terminal-quick-select-hint {
  border-top: 1px solid var(--border);
  color: var(--muted-foreground);
  padding: 4px 8px;
}
</style>
