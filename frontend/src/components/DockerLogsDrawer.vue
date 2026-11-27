<script setup lang="ts">
// Docker Logs 抽屉（B1 从 DockerPanel.vue 原样外抽）：快照式 docker/logs +
// tail 选择 + 刷新。状态与加载逻辑仍在面板里，这里只负责渲染，用户意图经
// 事件回传（update:open / update:tail / refresh）——纯搬移，无行为变化。
import { Loader2, RefreshCw, X } from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface LogsTarget {
  id: string;
  name: string;
}

interface LogsMeta {
  image: string;
  status: string;
  health?: string | null;
}

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  open: boolean;
  target: LogsTarget | null;
  text: string;
  meta: LogsMeta | null;
  busy: boolean;
  error: string;
  tail: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:tail": [value: string];
  refresh: [];
}>();

const TAIL_OPTIONS = ["100", "200", "500", "1000", "2000"] as const;
</script>

<template>
  <!-- Logs 抽屉 -->
  <Dialog :open="props.open" @update:open="(open: boolean) => emit('update:open', open)">
    <DialogContent class="docker-dialog docker-logs-dialog" @escape-key-down.prevent>
      <div class="docker-dialog-header">
        <DialogTitle>
          {{ props.target ? props.t("docker.logsTitle", { name: props.target.name || props.target.id.slice(0, 12) }) : "" }}
        </DialogTitle>
        <button type="button" class="icon-button" :title="props.t('docker.close')" :aria-label="props.t('docker.close')" @click="emit('update:open', false)"><X /></button>
      </div>
      <div class="docker-logs-bar">
        <label class="docker-tail-label">
          <span>{{ props.t("docker.logsTail") }}</span>
          <Select
            :model-value="props.tail"
            @update:model-value="(value: unknown) => { emit('update:tail', String(value)); emit('refresh'); }"
          >
            <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in TAIL_OPTIONS" :key="option" :value="option">{{ option }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <button type="button" class="icon-button" :title="props.t('docker.logsRefresh')" :aria-label="props.t('docker.logsRefresh')" @click="emit('refresh')">
          <Loader2 v-if="props.busy" class="spinning" />
          <RefreshCw v-else />
        </button>
      </div>
      <p v-if="props.error" class="docker-hint docker-hint-error">{{ props.t("docker.logsLoadFailed", { error: props.error }) }}</p>
      <div v-if="props.meta" class="docker-logs-meta mono">
        {{ props.meta.image }} · {{ props.meta.status }}<template v-if="props.meta.health"> · {{ props.meta.health }}</template>
      </div>
      <pre v-if="props.text" class="docker-logs-pre mono">{{ props.text }}</pre>
      <p v-else-if="!props.busy && !props.error" class="docker-empty">{{ props.t("docker.logsEmpty") }}</p>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.docker-dialog {
  max-width: 460px;
}

.docker-logs-dialog {
  max-width: 820px;
  width: min(820px, 90vw);
}

.docker-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.docker-empty {
  opacity: 0.65;
  font-size: 12px;
  padding: 8px 4px;
}

.docker-hint {
  font-size: 11px;
  opacity: 0.7;
}

.docker-hint-error {
  color: var(--danger, #d64545);
  opacity: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-logs-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.docker-tail-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.docker-logs-meta {
  font-size: 11px;
  opacity: 0.65;
}

.docker-logs-pre {
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.1);
  max-height: 50vh;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}

.spinning {
  animation: docker-spin 1s linear infinite;
}

@keyframes docker-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
