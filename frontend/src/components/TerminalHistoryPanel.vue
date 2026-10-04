<script setup lang="ts">
// Warp 式终端 history 面板（↑ 唤起）：把 commandHistory 过滤结果渲染成可
// 快速选择的面板；选中即实时回填输入行不执行（键盘 ↑↓ 与点击，高亮与行
// 内容一致，回车留给用户，Esc/底部再 ↓ 由 App 恢复原行）；悬停只浏览——
// 不抢高亮、不改输入，选中只认点击。
// 面板内搜索框（query 上抛 App 重过滤）：**不自动聚焦**——面板打开后焦点留
// 在命令行（#138 交互跟进：↑ 唤起即抢焦点会打断 shell 输入流），点击搜索框
// 才聚焦，↑↓/Enter/Tab/Esc 经 panel-key 转发给 App 的面板按键处理
// （preventDefault 挡输入框默认行为），字符键进 query 实时过滤；Esc 关闭后
// 焦点由 App 的 close 归还终端。
// 版式对标 Warp command history：占满终端宽度、底边贴输入行上一行向上展开
// （光标贴顶等极端场景按既有 overlay 规则翻到下方），条目为 `>_` 提示符
// 图标 + 命令文本 + 右侧相对时间。样式沿用 --popover/--border/--accent
// 令牌体系随宿主主题，不引 reka 弹层——避免与 xterm 键盘捕获争焦点。
import { computed, onMounted, ref, watchEffect } from "vue";
import { Search, Terminal as TerminalIcon, X } from "@lucide/vue";
import { formatCommandDuration } from "../lib/terminalCommandMarkers";
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
  /** 挂载即聚焦搜索框（批 3d）：仅热键唤起（⌘⇧H / Ctrl+Shift+H，Warp Ctrl+R
   *  心智——打开即为搜索界面）传入 true；裸 ↑ 唤起不传，焦点留在命令行。 */
  focusSearchOnMount?: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  select: [command: string];
  "update:query": [value: string];
  "panel-key": [event: KeyboardEvent];
  close: [];
}>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const rootEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);

watchEffect(() => {
  void props.entries.length;
}, { flush: "post" });

// 打开不抢焦点：焦点留在命令行（xterm textarea），↑↓/Enter/Esc 的键路在
// App 的终端按键分支；搜索框仅点击聚焦后参与过滤（root 的 mousedown 守卫
// 只挡行内焦点转移，不挡输入框）。例外：热键唤起（focusSearchOnMount，
// 批 3d）直接聚焦搜索框——热键用户要的就是 Warp Ctrl+R 式搜索流，省一次
// 鼠标点击。
onMounted(() => {
  if (props.focusSearchOnMount) searchEl.value?.focus({ preventScroll: true });
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
// 放置侧迟滞（体验回归：光标在视口中部的「刀锋线」附近时，锚点像素级抖动
// ——回显 settle 前后、长命令回填换行使光标行 ±1——会让面板反复翻面）。
// 打开期间记住当前侧并传给 chooseHistoryPanelPlacement，仅当当前侧真放不下
// 时才翻；变量非响应式（只随 computed 的既有依赖重算被读写），面板随
// v-if 卸载即复位，下次打开按纯几何重新决策。
let lastPlacement: "above" | "below" | null = null;
const style = computed(() => {
  const anchor = props.anchor;
  if (!anchor) {
    lastPlacement = null;
    return undefined;
  }
  const el = rootEl.value;
  const hostHeight = props.viewport?.height || 0;
  const containerHeight = el?.parentElement?.clientHeight || hostHeight;
  const spaceViewport = hostHeight || containerHeight;
  const cellHeight = anchor.cellHeight ?? 0;
  const naturalHeight = el?.scrollHeight ?? 0;
  const placement = chooseHistoryPanelPlacement(anchor.y, cellHeight, spaceViewport, undefined, lastPlacement ?? undefined);
  lastPlacement = placement;
  const available = overlayMaxHeight(placement, anchor.y, cellHeight, spaceViewport);
  const maxHeight = available > 0 && naturalHeight > 0 && available < naturalHeight ? { maxHeight: `${available}px` } : undefined;
  if (placement === "above") {
    // 视口钳制（体验回归修复）：锚点可能取自布局未稳的瞬间（回显尚未 settle
    // 时 y 偏大），bottom 会把整块面板推出视口顶且在下一次锚点刷新前不可点。
    // 以「容器高 − 面板自然高」为 bottom 上限，保证面板至少完整落在容器内、
    // 可点击；锚点 settle 后按新值自然收敛回贴行位置。
    let bottom = flippedOverlayBottom(anchor.y, containerHeight);
    if (naturalHeight > 0) bottom = Math.min(bottom, Math.max(0, containerHeight - naturalHeight));
    return { bottom: `${bottom}px`, ...maxHeight };
  }
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

/** mousedown 只挡焦点转移（焦点留在原处，↑↓/Enter/Esc 键路不变）；选中
 *  一律等 click——悬停/按下不抢键盘高亮、不改输入行（用户反馈：移入面板
 *  不得即刻改写输入，浮层弹出位置恰在鼠标下也不得抢键盘选择）。 */
function onRowMousedown(event: MouseEvent) {
  event.preventDefault();
}
</script>

<template>
  <div ref="rootEl" class="terminal-history-panel" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="dialog" :aria-label="t('terminalHistory.title')" @mousedown.stop @contextmenu.stop>
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
          @mousedown="onRowMousedown($event)"
          @click="emit('select', entry.command)"
        >
          <TerminalIcon class="terminal-history-prompt" aria-hidden="true" />
          <span class="terminal-history-command">{{ entry.command }}</span>
          <!-- 富元数据（批 4d，Warp command search 同位）：时长 + 非零退出码
               红色徽标；无 shell integration 的会话两列恒空不渲染。 -->
          <span v-if="entry.durationMs != null" class="terminal-history-duration mono">{{ formatCommandDuration(entry.durationMs) }}</span>
          <span v-if="entry.exitCode != null && entry.exitCode !== 0" class="terminal-history-exit">✗ {{ entry.exitCode }}</span>
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
  /* 铬层恒完整：钳高时只有列表收缩滚动，标题/搜索/键位提示不参与压缩。 */
  display: flex;
  flex-shrink: 0;
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
  /* 铬层恒完整：钳高时只有列表收缩滚动，标题/搜索/键位提示不参与压缩。 */
  display: flex;
  flex-shrink: 0;
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
  /* max-height 钳高时由列表吸收收缩（flex 项默认 min-height:auto 拒绝收缩，
     会把行溢出面板底边盖住光标行——体验反馈实录）；顶部/搜索/键位提示恒
     完整，超出部分列表内部滚动。 */
  min-height: 0;
  flex: 1 1 auto;
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

.terminal-history-duration {
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 10.5px;
  white-space: nowrap;
}

.terminal-history-exit {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: rgb(239 68 68 / 16%);
  color: rgb(239 68 68 / 90%);
  font-size: 10.5px;
  white-space: nowrap;
}

.terminal-history-hit.active .terminal-history-duration {
  color: var(--accent-foreground, inherit);
  opacity: 0.75;
}

.terminal-history-empty {
  color: var(--muted-foreground);
  padding: 14px 10px;
  text-align: center;
}

.terminal-history-hint {
  /* 铬层恒完整：钳高时只有列表收缩滚动，标题/搜索/键位提示不参与压缩。 */
  display: flex;
  flex-shrink: 0;
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
