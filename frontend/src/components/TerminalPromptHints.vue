<script setup lang="ts">
// 空提示符快捷键引导条：空行静置时浮在光标行上方的一条半透明 kbd 提示，
// 引导 Warp 对齐批次的键位（↑ 历史 / Ctrl+R 搜索历史 / Ctrl+Space 补全 /
// → 接受行内建议）。纯静态展示——点击不代操作（引导条要教的是按键本身），
// 唯一交互是 ✗ 永久消散（上抛 App 持久化；设置页可重开）。
// 定位复用 overlay 先例：底边贴光标行顶并留 gap（不遮输入行）；光标在
// 第一行/近顶时上方放不下，翻到光标行下方（choosePromptHintsPlacement，
// 下方是空屏不遮内容）；锚点读不到时降级贴终端底部。样式沿用
// --popover/--border/--muted 令牌随宿主主题。
import { computed, ref } from "vue";
import { X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { flippedOverlayBottom, overlayBelowTop, type SuggestionAnchor } from "../lib/overlayPlacement";
import { choosePromptHintsPlacement, PROMPT_HINTS_FALLBACK_BAR_HEIGHT } from "../lib/terminalPromptHints";

interface Props {
  locale: string;
  /** 历史搜索键的展示标签（App 按实时绑定计算，Apple 平台渲染 ⌃/⌘ 符号）；
   *  空 = 该动作已解绑，整项隐藏。 */
  historyKeyLabel: string;
  /** 补全手动键的展示标签（同上，跟随实时绑定——Ctrl+Space 被系统输入法
   *  抢占的机器上默认键已改为 Ctrl+/，标签必须跟着绑定走而非写死）。 */
  completionsKeyLabel: string;
  /** 宿主 AI 能力与 # 搜索开关均可用：引导条追加 # AI 命令搜索项。 */
  aiSearchAvailable: boolean;
  /** 光标格像素坐标（y 为光标行顶）；null = 定位不可用，贴终端底部。 */
  anchor: SuggestionAnchor | null;
  /** 定位包含块实测高度（terminal-pane）；缺省时走 fallback。 */
  viewport?: { height: number };
}

const props = defineProps<Props>();
const emit = defineEmits<{ dismiss: [] }>();

const t = (key: string) => workbenchMessage(props.locale, key);

const rootEl = ref<HTMLElement | null>(null);

// 底边贴光标行顶（bottom 偏移按定位包含块 terminal-pane 实测高度折算——
// batch 条/标记条让位时 host 比 pane 矮，与 history 面板同一坐标系）；
// 包含块不可测时不给内联样式，走 CSS fallback（贴终端底部）。
const style = computed(() => {
  const anchor = props.anchor;
  if (!anchor) return undefined;
  const containerHeight = rootEl.value?.parentElement?.clientHeight || props.viewport?.height || 0;
  if (!(containerHeight > 0)) return undefined;
  // 条高实测优先（挂载后随锚点刷新重算），首帧用常量回退。
  const barHeight = rootEl.value?.offsetHeight || PROMPT_HINTS_FALLBACK_BAR_HEIGHT;
  if (choosePromptHintsPlacement(anchor.y, containerHeight, barHeight) === "below") {
    // bottom 显式 auto（防御：基类未来若加 CSS 兜底 bottom，与 top 并存会
    // 拉伸元素——# 搜索条的真机回归教训）。
    return { left: `${anchor.x}px`, top: `${overlayBelowTop(anchor.y, anchor.cellHeight ?? 0)}px`, bottom: "auto" };
  }
  return { left: `${anchor.x}px`, bottom: `${flippedOverlayBottom(anchor.y, containerHeight)}px` };
});
</script>

<template>
  <div ref="rootEl" class="terminal-prompt-hints" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="note" :aria-label="t('terminalHints.ariaLabel')">
    <span class="terminal-prompt-hints-item"><kbd>↑</kbd><span>{{ t("terminalHints.history") }}</span></span>
    <span v-if="aiSearchAvailable" class="terminal-prompt-hints-item"><kbd>#</kbd><span>{{ t("terminalHints.aiSearch") }}</span></span>
    <span v-if="historyKeyLabel" class="terminal-prompt-hints-item"><kbd>{{ historyKeyLabel }}</kbd><span>{{ t("terminalHints.searchHistory") }}</span></span>
    <span v-if="completionsKeyLabel" class="terminal-prompt-hints-item"><kbd>{{ completionsKeyLabel }}</kbd><span>{{ t("terminalHints.completions") }}</span></span>
    <span class="terminal-prompt-hints-item"><kbd>→</kbd><span>{{ t("terminalHints.ghostAccept") }}</span></span>
    <button type="button" class="terminal-prompt-hints-dismiss" :title="t('terminalHints.dismiss')" :aria-label="t('terminalHints.dismiss')" @click="emit('dismiss')"><X /></button>
  </div>
</template>

<style scoped>
.terminal-prompt-hints {
  position: absolute;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 4px 14px;
  max-width: calc(100% - 16px);
  border: 1px solid var(--border, rgb(128 128 132 / 28%));
  border-radius: var(--radius);
  background: var(--popover);
  color: var(--muted-foreground);
  padding: 3px 6px 3px 10px;
  font-size: 11px;
  /* 引导条不接管键盘/鼠标：整条对指针透明，仅 ✗ 按钮放开（下方单独开）。 */
  pointer-events: none;
}

.terminal-prompt-hints.anchor-fallback {
  right: auto;
  bottom: 12px;
  left: 8px;
}

.terminal-prompt-hints-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  white-space: nowrap;
}

.terminal-prompt-hints kbd {
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

.terminal-prompt-hints-dismiss {
  display: inline-grid;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  place-items: center;
  border: 0;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  /* 唯一交互面：从透明容器里放开。 */
  pointer-events: auto;
}

.terminal-prompt-hints-dismiss:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.terminal-prompt-hints-dismiss svg {
  width: 11px;
  height: 11px;
  stroke-width: 1.7;
}
</style>
