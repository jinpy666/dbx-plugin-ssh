<script setup lang="ts">
// 容器文件写/删的二次确认条（B6）：纯展示，状态机在 `lib/dockerFiles.ts`。
import { Check, X } from "@lucide/vue";

const props = defineProps<{
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <div class="docker-files-confirm" role="alertdialog">
    <span class="docker-files-confirm-text">{{ props.message }}</span>
    <button type="button" class="docker-files-confirm-ok" :disabled="props.busy" @click="emit('confirm')">
      <Check /> {{ props.confirmLabel }}
    </button>
    <button type="button" class="docker-files-confirm-cancel" :disabled="props.busy" @click="emit('cancel')">
      <X /> {{ props.cancelLabel }}
    </button>
  </div>
</template>

<style scoped>
.docker-files-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--destructive, #d9534f);
  border-radius: 0.35rem;
  font-size: 0.8rem;
}
.docker-files-confirm-text {
  flex: 1;
  min-width: 10rem;
}
.docker-files-confirm-ok,
.docker-files-confirm-cancel {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  border-radius: 0.3rem;
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.docker-files-confirm-ok {
  border-color: var(--destructive, #d9534f);
  color: var(--destructive, #d9534f);
}
.docker-files-confirm-ok:disabled,
.docker-files-confirm-cancel:disabled {
  opacity: 0.5;
  cursor: default;
}
.docker-files-confirm-ok svg,
.docker-files-confirm-cancel svg {
  width: 0.9rem;
  height: 0.9rem;
}
</style>
