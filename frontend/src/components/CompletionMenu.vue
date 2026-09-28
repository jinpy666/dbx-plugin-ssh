<script setup lang="ts">
// 结构化补全下拉菜单（FIG wave-1 最终架构，方案 §24 解耦映射）：候选直接
// 使用引擎的 CompletionItem（label/description/kind 直用，接受回传 item.edit
// ——替换范围由 source 的 CompletionEdit 给出，UI 只执行不拼接）。纯展示
// 组件：键盘（↑↓/Tab/Enter/Esc）由 App 的 handleTerminalKey 经
// keyboard.ts 规则表消费，浮层只反映 activeIndex 并把点击/悬停上抛；
// 定位复用 CommandSuggestions 的光标像素锚点语义（y 为行顶；下方放不下
// 翻到光标上方，两侧都不够选更大侧收窄内滚，issue #120）。样式沿用既有
// 建议浮层的面板视觉（同一 --popover/--border/--accent 令牌体系，随宿主
// 主题），不引 reka 弹层——避免与 xterm 键盘捕获争焦点。
import { computed, ref, watchEffect } from "vue";
import { ChevronRight, CornerDownRight, Flag, Info, LoaderCircle, SlidersHorizontal } from "@lucide/vue";
import type { CompletionItem, CompletionItemKind } from "../lib/completion/core/types";
import {
  chooseOverlayPlacement,
  flippedOverlayBottom,
  overlayBelowTop,
  overlayLeft,
  overlayMaxHeight,
  type SuggestionAnchor,
} from "../lib/overlayPlacement";

const props = defineProps<{
  /** 引擎候选（已过 rankItems 排序截断）。 */
  items: CompletionItem[];
  activeIndex: number;
  /** 光标格像素坐标（y 为光标行顶）；null = 定位不可用，贴终端底部。 */
  anchor: SuggestionAnchor | null;
  /** 终端可视底界（terminal-host 净高）；缺省时回落实测包含块高度。 */
  viewport?: { height: number };
  /** generator 在途且无静态候选的占位态（批次 2-1，两段渲染 §31）。 */
  loading?: boolean;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  activate: [index: number];
  accept: [item: CompletionItem];
}>();

const rootEl = ref<HTMLElement | null>(null);
const placement = ref<"below" | "above">("below");
const overlayBottom = ref(0);
const constrainedHeight = ref(0);

// DOM 更新后按浮层实际高度选放置侧：条目数/锚点变化都重测。宿主高度取
// 包含块（terminal-pane）实测，不依赖外部下发，batch-bar 让位等也自动正确。
watchEffect(() => {
  const el = rootEl.value;
  const anchor = props.anchor;
  void props.items.length;
  if (!el || !anchor) {
    placement.value = "below";
    constrainedHeight.value = 0;
    return;
  }
  const viewportHeight = props.viewport?.height || el.parentElement?.clientHeight || 0;
  const cellHeight = anchor.cellHeight ?? 0;
  // scrollHeight 而非 offsetHeight：浮层被 max-height 压扁后再次测量，
  // offsetHeight 是受限高、scrollHeight 仍是内容真实高，条目增减时放置
  // 决策不会被上一轮的限制污染。
  const naturalHeight = el.scrollHeight;
  placement.value = chooseOverlayPlacement(anchor.y, cellHeight, naturalHeight, viewportHeight);
  overlayBottom.value = flippedOverlayBottom(anchor.y, viewportHeight);
  const available = overlayMaxHeight(placement.value, anchor.y, cellHeight, viewportHeight);
  constrainedHeight.value = available > 0 && available < naturalHeight ? available : 0;
}, { flush: "post" });

const style = computed(() => {
  if (!props.anchor) return undefined;
  // 右边缘越界（review 第二批）：浮层右缘超出可视区时整体左移，两侧各留
  // 8px 边距；宁向左展开也不被右缘裁切。同步读取包含块宽与自身宽
  // （不可测时不 clamp，保持光标贴合的默认行为）。
  let left = overlayLeft(props.anchor.x, props.anchor.cellWidth ?? 0);
  const el = rootEl.value;
  const viewportWidth = el?.parentElement?.clientWidth ?? 0;
  if (el && viewportWidth > 0) {
    left = Math.min(left, Math.max(8, viewportWidth - el.offsetWidth - 8));
  }
  const maxHeight = constrainedHeight.value > 0 ? { maxHeight: `${constrainedHeight.value}px` } : undefined;
  if (placement.value === "above") return { left: `${left}px`, bottom: `${overlayBottom.value}px`, ...maxHeight };
  return { left: `${left}px`, top: `${overlayBelowTop(props.anchor.y, props.anchor.cellHeight ?? 0)}px`, ...maxHeight };
});

function rowIcon(kind: CompletionItemKind) {
  if (kind === "command" || kind === "subcommand") return ChevronRight;
  if (kind === "option") return SlidersHorizontal;
  if (kind === "hint") return Info;
  return CornerDownRight;
}
</script>

<template>
  <div ref="rootEl" class="completion-menu" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="listbox" :aria-label="t('completionMenu.title')">
    <!-- generator 在途占位（§31 两段渲染）：纯状态行，不可点选、不参与
         activeIndex；键盘所有权由 App 的 keyboard.ts loading 态处理。 -->
    <div v-if="loading && !items.length" class="completion-row completion-loading" role="status">
      <LoaderCircle class="completion-icon completion-loading-icon" aria-hidden="true" />
      <span class="completion-description">{{ t("completionMenu.loading") }}</span>
    </div>
    <button
      v-for="(item, index) in items"
      :key="item.id"
      type="button"
      class="completion-row"
      :class="{ active: index === activeIndex, hint: item.kind === 'hint' }"
      role="option"
      :aria-selected="index === activeIndex"
      :title="`${item.description ?? item.label} · ${t('completionMenu.acceptHint')}`"
      @mouseenter="emit('activate', index)"
      @mousedown.prevent
      @click="emit('accept', item)"
    >
      <component :is="rowIcon(item.kind)" class="completion-icon" aria-hidden="true" />
      <span class="completion-label mono">{{ item.label }}</span>
      <span class="completion-description">{{ item.description }}</span>
      <Flag v-if="item.kind === 'option'" class="completion-kind-mark" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
/* 面板色随宿主主题（issue #120）：与 .notice/.metrics-float 同用
   --popover/--border/--shadow-popover 令牌；文字色显式配对面板底。 */
.completion-menu {
  position: absolute;
  z-index: 30;
  max-width: 460px;
  min-width: 280px;
  max-height: 44vh;
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

.completion-menu.anchor-fallback {
  left: 12px;
  bottom: 12px;
}

.completion-row {
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

.completion-row.active {
  background: var(--accent);
}

.completion-row.hint .completion-label {
  opacity: 0.55;
  font-style: italic;
}

.completion-icon {
  flex: none;
  width: 13px;
  height: 13px;
  opacity: 0.7;
}

.completion-label {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.completion-description {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  opacity: 0.65;
}

.completion-kind-mark {
  flex: none;
  width: 12px;
  height: 12px;
  opacity: 0.45;
}

/* generator 在途占位行（§31）：非交互状态行，弱化展示。 */
.completion-row.completion-loading {
  cursor: default;
}

.completion-loading .completion-description {
  opacity: 0.5;
}

.completion-loading-icon {
  animation: completion-loading-spin 1.1s linear infinite;
}

@keyframes completion-loading-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .completion-loading-icon {
    animation: none;
  }
}
</style>
