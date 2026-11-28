<script setup lang="ts">
// Docker 容器工作台（B4 文件页 + B5 终端页）：同一 Dialog 壳内两个 tab。
// 入口不新增：DockerPanel 的「在终端打开」与文件菜单都打开这里。
import { ref, watch } from "vue";
import { X } from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import DockerFilesPane from "./DockerFilesPane.vue";
import DockerTerminalPane from "./DockerTerminalPane.vue";

interface WorkbenchTarget {
  id: string;
  name?: string;
}

const props = withDefaults(defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  open: boolean;
  target: WorkbenchTarget | null;
  params: () => Record<string, unknown>;
  initialTab?: "files" | "terminal";
}>(), { initialTab: "files" });

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const tab = ref<"files" | "terminal">(props.initialTab);

watch(
  () => [props.open, props.initialTab, props.target?.id],
  () => {
    if (!props.open) return;
    tab.value = props.initialTab;
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="props.open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="docker-workbench">
      <div class="docker-workbench-header">
        <DialogTitle class="docker-workbench-title">
          {{ props.t("docker.filesTitle") }}<template v-if="props.target?.name"> · {{ props.target.name }}</template>
        </DialogTitle>
        <button type="button" class="docker-workbench-close" :title="props.t('docker.close')" :aria-label="props.t('docker.close')" @click="emit('update:open', false)">
          <X />
        </button>
      </div>
      <div class="docker-workbench-tabs" role="tablist">
        <button
          type="button"
          class="docker-workbench-tab"
          role="tab"
          :aria-selected="tab === 'files'"
          @click="tab = 'files'"
        >
          {{ props.t("docker.filesTabFiles") }}
        </button>
        <button
          type="button"
          class="docker-workbench-tab"
          role="tab"
          :aria-selected="tab === 'terminal'"
          @click="tab = 'terminal'"
        >
          {{ props.t("docker.terminalTabTerminal") }}
        </button>
      </div>
      <div v-if="props.target" class="docker-workbench-body">
        <DockerFilesPane v-if="tab === 'files'" :t="props.t" :target="props.target" :params="props.params" />
        <DockerTerminalPane
          v-else
          :t="props.t"
          :target="props.target"
          :params="props.params"
          :active="props.open && tab === 'terminal'"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.docker-workbench {
  display: flex;
  flex-direction: column;
  width: min(64rem, 94vw);
  height: min(42rem, 84vh);
  padding: 0.75rem;
  gap: 0.5rem;
}
.docker-workbench-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.docker-workbench-title {
  font-size: 0.95rem;
}
.docker-workbench-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.7rem;
  height: 1.7rem;
  padding: 0;
  border: 0;
  border-radius: 0.3rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.docker-workbench-close svg {
  width: 1rem;
  height: 1rem;
}
.docker-workbench-tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.25));
}
.docker-workbench-tab {
  padding: 0.3rem 0.6rem;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: inherit;
  font-size: 0.82rem;
  cursor: pointer;
}
.docker-workbench-tab[aria-selected="true"] {
  border-bottom-color: var(--primary, #4a9eff);
  font-weight: 600;
}
.docker-workbench-body {
  flex: 1;
  min-height: 0;
}
</style>
