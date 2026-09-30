<script setup lang="ts">
// Warp 式终端 history 面板（↑ 唤起）：把 commandHistory 过滤结果渲染成可
// 键盘/鼠标快速选择的面板；选中即实时回填输入行不执行（高亮与行内容一致，
// 回车留给用户，Esc/底部再 ↓ 由 App 恢复原行）。
// 面板内搜索框（query 上抛 App 重过滤）：打开即聚焦，↑↓/Enter/Tab/Esc 经
// panel-key 转发给 App 的面板按键处理（preventDefault 挡输入框默认行为），
// 其余字符键进 query 实时过滤；Esc 关闭后焦点由 App 的 close 归还终端。
// 版式对标 Warp command history：占满终端宽度、底边贴输入行上一行向上展开
// （光标贴顶等极端场景按既有 overlay 规则翻到下方），条目为 `>_` 提示符
// 图标 + 命令文本 + 右侧相对时间。样式沿用 --popover/--border/--accent
// 令牌体系随宿主主题，不引 reka 弹层——避免与 xterm 键盘捕获争焦点。
import { computed, onMounted, ref, watchEffect } from "vue";
import { Search, Terminal as TerminalIcon, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import type { HistoryPanelEntry } from "../lib/historyPanel";
import { chooseHistoryPanelPlacement, relativeHistoryAge } from "../lib/historyPanel";
import { flippedOverlayBottom, overlayBelowTop, overlayMaxHeight, type SuggestionAnchor } from "../lib/overlayPlacement";

interface Props {
  locale: string;
  entries: HistoryPanelEntry[];
  activeIndex: number;
  /** 光标格像素坐标（y 为光标行顶）；null = 定位不可用，贴终端底部。 */
  anchor: SuggestionAnchor | null;
  /** 搜索词（受控：App 持有，输入框只回显与上抛）。 */
  query: string;
  /** 终端可视底界（terminal-host 净高）；缺省时回落实测包含块高度。 */
  viewport?: { height: number };
}

const props = defineProps<Props>();

const emit = defineEmits<{
  activate: [index: number];
  select: [command: string];
  "update:query": [value: string];
  "panel-key": [event: KeyboardEvent];
  close: [];
}>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const rootEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
// 悬停武装（用户反馈同 CompletionMenu）：浮层弹出位置恰在鼠标下时，静止的
// 指针也会抢走键盘选择；指针在浮层上真实移动过才允许 hover 激活。
const hoverArmed = ref(false);

watchEffect(() => {
  void props.entries.length;
  hoverArmed.value = false;
}, { flush: "post" });

// 打开即聚焦搜索框（Warp 语义：面板 = 搜索/选择界面，打字即过滤）；焦点
// 离开 xterm 后终端打字进 query，回填/关闭路径由 App 归还终端焦点。
onMounted(() => {
  searchEl.value?.focus({ preventScroll: true });
});

/** 面板导航/回填/关闭键上抛 App 消费；字符键放行进搜索框。 */
function onPanelKeydown(event: KeyboardEvent) {
  emit("panel-key", event);
}

// Warp 语义：面板底边贴输入行上一行（光标行顶留 gap）向上展开；光标贴视口
// 顶部等上方放不下的场景按 chooseHistoryPanelPlacement 翻到下方。空间判定用
// 终端可视底界（viewport = terminal-host 净高）；bottom 偏移必须用定位包含块
// （terminal-pane）实测高度（batch 条/标记条让位时 host 比 pane 矮）。
// maxHeight 按放置侧可用高度收窄（内部滚动）；naturalHeight 不可测（0）时
// 不设限，交给 CSS max-height 兜底。
const style = computed(() => {
  const anchor = props.anchor;
  if (!anchor) return undefined;
  const el = rootEl.value;
  const hostHeight = props.viewport?.height || 0;
  const containerHeight = el?.parentElement?.clientHeight || hostHeight;
  const spaceViewport = hostHeight || containerHeight;
  const cellHeight = anchor.cellHeight ?? 0;
  const naturalHeight = el?.scrollHeight ?? 0;
  const placement = chooseHistoryPanelPlacement(anchor.y, cellHeight, spaceViewport);
  const available = overlayMaxHeight(placement, anchor.y, cellHeight, spaceViewport);
  const maxHeight = available > 0 && naturalHeight > 0 && available < naturalHeight ? { maxHeight: `${available}px` } : undefined;
  if (placement === "above") return { bottom: `${flippedOverlayBottom(anchor.y, containerHeight)}px`, ...maxHeight };
  return { top: `${overlayBelowTop(anchor.y, cellHeight)}px`, ...maxHeight };
});

const titleText = computed(() => {
  const base = t("terminalHistory.title");
  return props.entries.length > 0 ? `${base} · ${t("terminalHistory.count", { count: props.entries.length })}` : base;
});

/** 条目右侧相对时间文案（never = 无时间戳，不渲染占位）。 */
function ageText(entry: HistoryPanelEntry): string {
  const age = relativeHistoryAge(entry.ts, Date.now());
  if (age.kind === "never") return "";
  if (age.kind === "just-now") return t("terminalHistory.justNow");
  if (age.kind === "minutes") return t("terminalHistory.minutesAgo", { count: age.count });
  if (age.kind === "hours") return t("terminalHistory.hoursAgo", { count: age.count });
  return t("terminalHistory.daysAgo", { count: age.count });
}

// 键盘高亮项滚动跟随：条目多到内部滚动后，↑↓ 移动时保持 active 可见。
watchEffect(() => {
  const list = listEl.value;
  if (!list) return;
  const item = list.children[props.activeIndex] as HTMLElement | undefined;
  item?.scrollIntoView?.({ block: "nearest" });
}, { flush: "post" });

/** hover 激活只在指针于浮层上移动过之后生效（防弹出位置的静止指针抢选）。 */
function onRowEnter(index: number) {
  if (hoverArmed.value) emit("activate", index);
}

function onRowMousedown(event: MouseEvent, index: number) {
  // mousedown 不转移焦点（焦点留在终端，Esc/↑↓/Enter 仍走注册表派发路径）。
  event.preventDefault();
  emit("activate", index);
}
</script>

<template>
  <div ref="rootEl" class="terminal-history-panel" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="dialog" :aria-label="t('terminalHistory.title')" @mousedown.stop.prevent @contextmenu.stop @pointermove="hoverArmed = true">
    <div class="terminal-history-row">
      <span class="terminal-history-title">{{ titleText }}</span>
      <button type="button" class="terminal-history-btn" :title="t('terminalHistory.close')" :aria-label="t('terminalHistory.close')" @click="emit('close')"><X /></button>
    </div>
    <div class="terminal-history-search">
      <Search class="terminal-history-search-icon" aria-hidden="true" />
      <input
        ref="searchEl"
        class="terminal-history-search-input"
        type="text"
        :value="query"
        :placeholder="t('terminalHistory.search')"
        :aria-label="t('terminalHistory.search')"
        spellcheck="false"
        autocomplete="off"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        @keydown="onPanelKeydown"
      />
      <button v-if="query" type="button" class="terminal-history-btn" :title="t('terminalHistory.clearSearch')" :aria-label="t('terminalHistory.clearSearch')" @click="emit('update:query', '')"><X /></button>
    </div>
    <ul v-if="entries.length" ref="listEl" class="terminal-history-list" role="listbox" :aria-label="t('terminalHistory.title')">
      <li v-for="(entry, index) in entries" :key="`${index}-${entry.command}`">
        <button
          type="button"
          class="terminal-history-hit mono"
          role="option"
          :aria-selected="index === activeIndex"
          :class="{ active: index === activeIndex }"
          :title="entry.command"
          @mousedown="onRowMousedown($event, index)"
          @mouseenter="onRowEnter(index)"
          @click="emit('select', entry.command)"
        >
          <TerminalIcon class="terminal-history-prompt" aria-hidden="true" />
          <span class="terminal-history-command">{{ entry.command }}</span>
          <span v-if="ageText(entry)" class="terminal-history-age">{{ ageText(entry) }}</span>
        </button>
      </li>
    </ul>
    <div v-else class="terminal-history-empty">{{ t("terminalHistory.empty") }}</div>
    <div v-if="entries.length" class="terminal-history-hint">
      <span class="terminal-history-keys"><kbd>↑</kbd><kbd>↓</kbd> {{ t("terminalHistory.navigate") }}</span>
      <span class="terminal-history-keys"><kbd>Enter</kbd> {{ t("terminalHistory.fill") }}</span>
      <span class="terminal-history-keys"><kbd>Esc</kbd> {{ t("terminalHistory.close") }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Warp 版式：占满终端宽度（两侧 8px 内缩），上下位置由内联样式给出
   （bottom 贴输入行上方 / top 翻转），组件自身不再定宽。 */
/* 令牌兜底：宿主主题通道未注入 --color-* 时（旧宿主/mock 夹具）
   --accent/--border/--muted 会因 var 循环变成 guaranteed-invalid，
   fallback 保住高亮与边框的可见性；令牌齐的环境（真实宿主）零变化。 */
.terminal-history-panel {
  position: absolute;
  right: 8px;
  left: 8px;
  z-index: 7;
  display: flex;
  max-height: 70%;
  flex-direction: column;
  border: 1px solid var(--border, rgb(128 128 132 / 28%));
  border-radius: var(--radius);
  background: var(--popover);
  box-shadow: var(--shadow-popover);
  font-size: 11px;
}

.terminal-history-panel.anchor-fallback {
  bottom: 12px;
}

.terminal-history-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 6px 10px;
}

.terminal-history-title {
  min-width: 0;
  overflow: hidden;
  color: var(--popover-foreground);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-history-btn {
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

.terminal-history-btn:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.terminal-history-btn svg {
  width: 13px;
  height: 13px;
  stroke-width: 1.7;
}

.terminal-history-search {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  padding: 4px 10px;
}

.terminal-history-search-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  color: var(--muted-foreground);
  stroke-width: 1.7;
}

.terminal-history-search-input {
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  padding: 2px 0;
  background: transparent;
  color: var(--popover-foreground);
  font-family: var(--ui-font-family);
  font-size: 11.5px;
  outline: none;
}

.terminal-history-search-input::placeholder {
  color: var(--muted-foreground);
}

.terminal-history-list {
  margin: 0;
  overflow-y: auto;
  padding: 4px;
  list-style: none;
}

.terminal-history-hit {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 4px;
  padding: 5px 8px;
  background: transparent;
  color: var(--popover-foreground);
  cursor: pointer;
  text-align: left;
}

.terminal-history-hit.active {
  background: var(--accent, rgb(255 255 255 / 10%));
  color: var(--accent-foreground, inherit);
}

.terminal-history-prompt {
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  color: var(--muted-foreground);
  stroke-width: 1.7;
}

.terminal-history-command {
  min-width: 0;
  overflow: hidden;
  flex: 1 1 auto;
  font-family: var(--terminal-font-family);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-history-age {
  overflow: hidden;
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-history-hit.active .terminal-history-age {
  color: var(--accent-foreground, inherit);
  opacity: 0.75;
}

.terminal-history-empty {
  color: var(--muted-foreground);
  padding: 14px 10px;
  text-align: center;
}

.terminal-history-hint {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  border-top: 1px solid var(--border);
  color: var(--muted-foreground);
  padding: 5px 10px;
}

.terminal-history-keys {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.terminal-history-hint kbd {
  display: inline-grid;
  min-width: 16px;
  place-items: center;
  border: 1px solid var(--border, rgb(128 128 132 / 28%));
  border-radius: 4px;
  padding: 0 4px;
  background: var(--muted, rgb(255 255 255 / 6%));
  color: inherit;
  font-family: var(--ui-font-family);
  font-size: 9.5px;
  line-height: 15px;
}
</style>
