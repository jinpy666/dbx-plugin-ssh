<script setup lang="ts">
// 串口文件上传弹窗（NyaTerm 对齐 P0-3）：选文件 + 选协议 + 开始。
// 文件字节由这里经 File API 分块读出（App.vue 执有送数流程），sidecar 不
// 落盘；进度展示在终端 overlay，不在本弹窗。
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import {
  SERIAL_UPLOAD_MAX_BYTES,
  SERIAL_UPLOAD_PROTOCOLS,
  type SerialUploadProtocol,
} from "../lib/serialUpload";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface Props {
  locale: string;
  open: boolean;
  busy: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  "update:open": [boolean];
  start: [{ file: File; protocol: SerialUploadProtocol }];
}>();

const t = (key: string, values: Record<string, string | number> = {}) =>
  workbenchMessage(props.locale, key, values);

const file = ref<File | null>(null);
const protocol = ref<SerialUploadProtocol>("xmodem");
const sizeError = ref(false);
const fileInput = ref<HTMLInputElement>();

watch(
  () => props.open,
  (open) => {
    if (open) {
      file.value = null;
      sizeError.value = false;
    }
  },
);

const fileLabel = computed(() => (file.value ? file.value.name : t("serial.upload.choose")));

function pickFile() {
  fileInput.value?.click();
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const selected = input.files?.[0] ?? null;
  file.value = selected;
  sizeError.value = selected !== null && selected.size > SERIAL_UPLOAD_MAX_BYTES;
  input.value = "";
}

function submit() {
  if (!file.value || sizeError.value || props.busy) return;
  emit("update:open", false);
  emit("start", { file: file.value, protocol: protocol.value });
}
</script>

<template>
  <Dialog :open="open" @update:open="(open) => emit('update:open', open)">
    <DialogContent class="modal small-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("serial.upload.title") }}</DialogTitle>
        <button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <div class="serial-form-grid">
        <label class="settings-field serial-port-field">
          <span>{{ t("serial.upload.file") }}</span>
          <button class="mono serial-upload-file-button" type="button" @click="pickFile">{{ fileLabel }}</button>
          <input ref="fileInput" type="file" class="visually-hidden" @change="onFileChange" />
          <small v-if="sizeError" class="muted serial-ports-empty">{{ t("serial.upload.tooLarge") }}</small>
        </label>
        <label class="settings-field">
          <span>{{ t("serial.upload.protocol") }}</span>
          <select v-model="protocol">
            <option v-for="entry in SERIAL_UPLOAD_PROTOCOLS" :key="entry" :value="entry">{{ entry.toUpperCase() }}</option>
          </select>
        </label>
      </div>
      <p class="muted serial-upload-hint">{{ t("serial.upload.hint") }}</p>
      <footer>
        <button @click="emit('update:open', false)">{{ t("cancel") }}</button>
        <button class="primary-button" :disabled="!file || sizeError || busy" @click="submit">{{ t("serial.upload.start") }}</button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.serial-upload-file-button {
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.serial-upload-hint {
  font-size: 11px;
  line-height: 1.5;
  margin: 0 0 8px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
