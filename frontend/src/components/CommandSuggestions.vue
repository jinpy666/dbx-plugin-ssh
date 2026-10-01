<script setup lang="ts">
// 命令模糊建议浮层（P1-1）：纯展示组件——条目渲染（匹配高亮 + 来源图标）、
// 键盘导航与填充语义都在 App（键盘经 xterm attachCustomKeyEventHandler 消费，
// 浮层只反映 activeIndex 并把点击/悬停上抛）。定位由 App 传入：锚点是光标
// 格像素坐标（y 为行顶），读不到时（anchor=null）降级为贴终端底部；下方
// 放不下翻转到光标上方，两侧都不够选空间更大的一侧并收窄内滚，永不遮输入
// 行（issue #120，lib/overlayPlacement，宿主高度以包含块实测为准）。
import { computed, ref, watchEffect } from "vue";
import { History, X, Zap } from "@lucide/vue";
import type { CommandSuggestion } from "../lib/commandSuggestions";
import {
  chooseOverlayPlacement,
  flippedOverlayBottom,
  overlayBelowTop,
  overlayLeft,
  overlayMaxHeight,
  type SuggestionAnchor,
} from "../lib/overlayPlacement";

interface Segment {
  text: string;
  matched: boolean;
}

const props = defineProps<{
  items: CommandSuggestion[];
  activeIndex: number;
  /** 光标格像素坐标（y 为光标行顶）；null = 定位不可用，贴终端底部。 */
  anchor: SuggestionAnchor | null;
  /** 终端可视底界（terminal-host 净高）；缺省时回落实测包含块高度。 */
  viewport?: { height: number };
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  activate: [index: number];
  fill: [item: CommandSuggestion];
  ignore: [item: CommandSuggestion];
}>();

const rootEl = ref<HTMLElement | null>(null);
const placement = ref<"below" | "above">("below");
const overlayBottom = ref(0);
const constrainedHeight = ref(0);
// 悬停武装（与 CompletionMenu 同款）：静止指针不得抢占键盘选择，指针在
// 浮层上真实移动过才允许 hover 激活；条目/锚点变化即解除。
const hoverArmed = ref(false);

// DOM 更新后按浮层实际高度选放置侧：条目数/锚点变化都重测。空间判定用
// 终端可视底界（props.viewport = terminal-host 净高）；翻转的 CSS bottom 偏移
// 用定位包含块（terminal-pane）实测高度——批量条/标记条让位时 host 比 pane
// 矮（inset-bottom），用 host 高度会把浮层压低一条内缩量、盖住输入行。
watchEffect(() => {
  const el = rootEl.value;
  const anchor = props.anchor;
  void props.items.length;
  hoverArmed.value = false;
  if (!el || !anchor) {
    placement.value = "below";
    constrainedHeight.value = 0;
    return;
  }
  const viewportWidth = el.parentElement?.clientWidth ?? 0;
  const hostHeight = props.viewport?.height || 0;
  const containerHeight = el.parentElement?.clientHeight || hostHeight;
  const spaceViewport = hostHeight || containerHeight;
  const cellHeight = anchor.cellHeight ?? 0;
  // scrollHeight 而非 offsetHeight：浮层被 max-height 压扁后再次测量，
  // offsetHeight 是受限高、scrollHeight 仍是内容真实高，条目增减时放置
  // 决策不会被上一轮的限制污染。
  const naturalHeight = el.scrollHeight;
  placement.value = chooseOverlayPlacement(anchor.y, cellHeight, naturalHeight, spaceViewport);
  overlayBottom.value = flippedOverlayBottom(anchor.y, containerHeight);
  const available = overlayMaxHeight(placement.value, anchor.y, cellHeight, spaceViewport);
  constrainedHeight.value = available > 0 && available < naturalHeight ? available : 0;
}, { flush: "post" });

const style = computed(() => {
  if (!props.anchor) return undefined;
  // 右边缘越界（review 第二批）：浮层右缘超出可视区时整体左移，两侧各留
  // 8px 边距；宁向左展开也不被右缘裁切。同步读取包含块宽与自身宽
  // （不可测时不 clamp，保持光标贴合的默认行为）。
  const el = rootEl.value;
  let left = overlayLeft(props.anchor.x, props.anchor.cellWidth ?? 0);
  const viewportWidth = el?.parentElement?.clientWidth ?? 0;
  if (el && viewportWidth > 0) {
    left = Math.min(left, Math.max(8, viewportWidth - el.offsetWidth - 8));
  }
  const maxHeight = constrainedHeight.value > 0 ? { maxHeight: `${constrainedHeight.value}px` } : undefined;
  if (placement.value === "above") return { left: `${left}px`, bottom: `${overlayBottom.value}px`, ...maxHeight };
  return { left: `${left}px`, top: `${overlayBelowTop(props.anchor.y, props.anchor.cellHeight ?? 0)}px`, ...maxHeight };
});

/** 按 indices 把命令串切成高亮片段（未命中的字符合并成段）。 */
function segments(command: string, indices: number[]): Segment[] {
  const matched = new Set(indices);
  const out: Segment[] = [];
  let current: Segment | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const isMatched = matched.has(i);
    if (!current || current.matched !== isMatched) {
      current = { text: command.charAt(i), matched: isMatched };
      out.push(current);
    } else {
      current.text += command.charAt(i);
    }
  }
  return out;
}

const sourceLabel = (item: CommandSuggestion) => (item.source === "quick" ? props.t("suggestions.sourceQuick") : props.t("suggestions.sourceHistory"));

/** hover 激活只在指针于浮层上移动过之后生效（防弹出位置的静止指针抢选）。 */
function onRowEnter(index: number) {
  if (hoverArmed.value) emit("activate", index);
}
</script>

<template>
  <div ref="rootEl" class="command-suggestions" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="listbox" :aria-label="t('suggestions.title')" @pointermove="hoverArmed = true">
    <button
      v-for="(item, index) in items"
      :key="`${item.source}-${item.command}`"
      type="button"
      class="suggestion-row"
      :class="{ active: index === activeIndex }"
      role="option"
      :aria-selected="index === activeIndex"
      @mouseenter="onRowEnter(index)"
      @mousedown.prevent
      @click="emit('fill', item)"
    >
      <History v-if="item.source === 'history'" class="suggestion-icon" aria-hidden="true" />
      <Zap v-else class="suggestion-icon" aria-hidden="true" />
      <span class="suggestion-command mono">
        <template v-for="(segment, segmentIndex) in segments(item.command, item.indices)" :key="segmentIndex"><mark v-if="segment.matched">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template>
      </span>
      <span class="suggestion-source">{{ sourceLabel(item) }}</span>
      <!-- 行内 ✗（批 4c，Warp IgnoredSuggestions）：span 避开 button 嵌套；
           mousedown 阻断防触发行的 click 回填，click 永久排除该建议。 -->
      <span
        class="suggestion-ignore"
        role="button"
        :aria-label="t('suggestions.ignoreHint')"
        @mousedown.stop.prevent
        @click.stop="emit('ignore', item)"
      ><X /></span>
    </button>
    <!-- kbd 提示行（批 3c，#138 后 Tab 语义不平凡）：内联常驻、非 tooltip，
         弹出位置的静止鼠标不会再冒原生悬浮提示。 -->
    <div v-if="items.length" class="suggestion-hint" aria-hidden="true">{{ t("suggestions.kbdHint") }}</div>
  </div>
</template>

<style scoped>
/* 面板色随宿主主题：与 .notice/.metrics-float 同用 --popover/--border/
   --shadow-popover 令牌（style.css 统一阴影配方），不硬编码深色 fallback——
   浅色主题下黑底深字不可读（issue #120）。文字色显式配对面板底，
   不依赖终端 pane 的继承色。 */
.command-suggestions {
  position: absolute;
  z-index: 30;
  max-width: 380px;
  min-width: 260px;
  max-height: 40vh;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-popover);
  color: var(--foreground);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.command-suggestions.anchor-fallback {
  left: 12px;
  bottom: 12px;
}

.suggestion-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  line-height: 1.4;
}

.suggestion-row.active {
  background: var(--accent);
}

.suggestion-icon {
  flex: none;
  width: 14px;
  height: 14px;
  opacity: 0.75;
}

.suggestion-command {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggestion-command mark {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

.suggestion-source {
  flex: none;
  font-size: 11px;
  opacity: 0.65;
}

/* 行内 ✗（批 4c）：静止时隐藏（不干扰纯键盘流），悬停行时浮现；hover 武装
   门已挡静止指针抢选，✗ 只在真实移入后才可点。 */
.suggestion-ignore {
  flex: none;
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  opacity: 0;
  cursor: pointer;
}

.suggestion-ignore svg {
  width: 12px;
  height: 12px;
}

.suggestion-row:hover .suggestion-ignore,
.suggestion-row.active .suggestion-ignore {
  opacity: 0.6;
}

.suggestion-ignore:hover {
  opacity: 1;
  background: var(--border);
}

.suggestion-hint {
  flex: none;
  padding: 4px 8px 2px;
  font-size: 11px;
  opacity: 0.6;
  text-align: right;
  user-select: none;
}
</style>
