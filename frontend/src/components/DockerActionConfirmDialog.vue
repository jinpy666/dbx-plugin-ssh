<script setup lang="ts">
// kill/rm 强制确认弹窗（自 DockerPanel 外抽）：确认状态机在 lib/dockerActions，
// 父层持有 confirmTarget/busy 并驱动执行；本组件只呈现动作名与影响面文案。
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { X } from "@lucide/vue";
import type { DockerActionName, DockerActionTarget } from "../lib/dockerActions";

// 动作动词 → 静态 i18n key（i18nKeyReferences.spec 只认字面量 key）。
const ACTION_LABEL_KEYS: Record<DockerActionName, string> = {
  start: "docker.actionStart",
  stop: "docker.actionStop",
  restart: "docker.actionRestart",
  kill: "docker.actionKill",
  rm: "docker.actionRemove",
};

defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  target: (DockerActionTarget & { action: DockerActionName }) | null;
  busy: boolean;
  /** 确认文案里的 CLI 名（父层引擎设置的 cli，缺省 docker）。 */
  cli: string;
}>();

const emit = defineEmits<{
  (event: "confirm", accepted: boolean): void;
}>();
</script>

<template>
  <Dialog :open="!!target" @update:open="(open: boolean) => { if (!open) emit('confirm', false); }">
    <DialogContent class="docker-dialog" @escape-key-down.prevent>
      <div class="docker-dialog-header">
        <DialogTitle>
          {{ target ? t("docker.confirmTitle", { action: t(ACTION_LABEL_KEYS[target.action]) }) : "" }}
        </DialogTitle>
        <button type="button" class="icon-button" :title="t('docker.cancel')" :aria-label="t('docker.cancel')" @click="emit('confirm', false)"><X /></button>
      </div>
      <p class="docker-confirm-body mono">
        {{ target ? t("docker.confirmBody", { cli, action: target.action, name: target.name }) : "" }}
      </p>
      <div class="docker-dialog-actions">
        <button type="button" class="docker-secondary-button" :disabled="busy" @click="emit('confirm', false)">
          {{ t("docker.cancel") }}
        </button>
        <button type="button" class="docker-danger-button" :disabled="busy" @click="emit('confirm', true)">
          {{ busy ? t("docker.actionBusy") : t("docker.confirmOk") }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.docker-dialog {
  max-width: 460px;
}

.docker-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.docker-confirm-body {
  margin: 10px 0;
  word-break: break-all;
}

.docker-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.docker-secondary-button,
.docker-danger-button {
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
}

.docker-danger-button {
  background: var(--danger, #d64545);
  border-color: var(--danger, #d64545);
  color: #fff;
}

.docker-danger-button:disabled,
.docker-secondary-button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
