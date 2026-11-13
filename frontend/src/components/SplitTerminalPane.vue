<script setup lang="ts">
/**
 * 分屏副终端窗格：承载副会话的独立 xterm 实例。
 *
 * 终端实例由 useSplitPanes.mountPane() 在挂载时创建（外观与主终端同源），
 * 本组件只负责 DOM 容器、尺寸观察（ResizeObserver → ssh/terminal/resize）
 * 与窗格壳（标题/状态徽标/关闭）。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { X } from "@lucide/vue";
import type { SplitPaneRecord, UseSplitPanes } from "../composables/useSplitPanes";

const props = defineProps<{
  pane: SplitPaneRecord;
  split: UseSplitPanes;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const host = ref<HTMLElement>();
let resizeObserver: ResizeObserver | undefined;
let lastCols = 0;
let lastRows = 0;

function syncSize() {
  const runtime = props.split.runtimeFor(props.pane.id);
  const terminal = runtime?.terminal;
  const fit = runtime?.fit;
  if (!terminal || !fit || !host.value?.clientWidth || !host.value.clientHeight) return;
  try {
    fit.fit();
    if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
      lastCols = terminal.cols;
      lastRows = terminal.rows;
      props.split.resizePane(props.pane.id, terminal.cols, terminal.rows);
    }
  } catch {
    /* iframe 随宿主切 tab 短暂脱离 DOM：静默跳过，回切后由下一次观察自愈 */
  }
}

onMounted(() => {
  if (!host.value) return;
  props.split.mountPane(props.pane.id, host.value);
  syncSize();
  resizeObserver = new ResizeObserver(() => syncSize());
  resizeObserver.observe(host.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  props.split.unmountPane(props.pane.id);
});
</script>

<template>
  <div class="split-pane" :data-state="pane.state">
    <header class="split-pane-head">
      <span class="split-pane-title" :title="pane.subtitle ? `${pane.title} · ${pane.subtitle}` : pane.title">
        <span class="split-pane-dot" aria-hidden="true" />{{ pane.title }}<span v-if="pane.subtitle" class="split-pane-sub mono">{{ pane.subtitle }}</span>
      </span>
      <span v-if="pane.state === 'closed'" class="split-pane-badge" :title="pane.error">{{ pane.error }}</span>
      <button
        type="button"
        class="split-pane-close"
        :title="t('splitPaneClose')"
        :aria-label="t('splitPaneClose')"
        @click="split.closePane(pane.id)"
      ><X /></button>
    </header>
    <div ref="host" class="split-pane-host" />
  </div>
</template>
