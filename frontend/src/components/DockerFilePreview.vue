<script setup lang="ts">
// 文件预览/编辑子组件（从 DockerFilesPane 抽出）：只负责呈现与文本输入。
// 读取请求、可编辑判定、64 KiB 写入上限与保存动作仍由父组件掌握，这样安全
// 相关的状态机留在同一个文件里，这里不新增任何 IO。
import { Loader2, Save } from "@lucide/vue";
import {
  DOCKER_FILES_DEFAULT_MAX_BYTES,
  DOCKER_FILES_WRITE_MAX_BYTES,
  formatFileSize,
  type DockerFileContent,
  type DockerFileEntry,
} from "../lib/dockerFiles";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  entry: DockerFileEntry | null;
  content: DockerFileContent | null;
  loading: boolean;
  error: string;
  canEdit: boolean;
  previewText: string | null;
  previewTruncated: boolean;
  /** 草稿与原始全文是否不同（保存按钮的启用条件之一）。 */
  dirty: boolean;
  /** 草稿 UTF-8 字节数已超过写入上限。 */
  tooLarge: boolean;
  saving: boolean;
}>();

const emit = defineEmits<{ save: [] }>();
const draft = defineModel<string>("draft", { default: "" });
</script>

<template>
  <section class="docker-files-preview" :aria-label="props.t('docker.filesPreview')">
    <p v-if="!props.entry" class="docker-files-hint">{{ props.t("docker.filesSelectFile") }}</p>
    <p v-else-if="props.loading" class="docker-files-hint"><Loader2 class="spin" /> {{ props.t("docker.filesLoading") }}</p>
    <p v-else-if="props.error" class="docker-files-error">{{ props.t("docker.filesReadFailed") }} {{ props.error }}</p>
    <template v-else-if="props.content">
      <div class="docker-files-preview-head">
        <strong class="mono">{{ props.entry.name }}</strong>
        <span>{{ formatFileSize(props.content.size) }}</span>
        <button
          v-if="props.canEdit"
          type="button"
          class="docker-files-save"
          :disabled="props.saving || !props.dirty || props.tooLarge"
          @click="emit('save')"
        >
          <Save /> {{ props.t("docker.filesSave") }}
        </button>
      </div>
      <p v-if="props.previewTruncated" class="docker-files-hint">
        {{ props.t("docker.filesPreviewTruncated", { size: formatFileSize(props.content.size), limit: formatFileSize(DOCKER_FILES_DEFAULT_MAX_BYTES) }) }}
      </p>
      <p v-else-if="!props.canEdit" class="docker-files-hint">
        {{ props.t("docker.filesSaveTooLarge", { limit: formatFileSize(DOCKER_FILES_WRITE_MAX_BYTES) }) }}
      </p>
      <p v-if="props.canEdit && props.tooLarge" class="docker-files-error">
        {{ props.t("docker.filesSaveTooLarge", { limit: formatFileSize(DOCKER_FILES_WRITE_MAX_BYTES) }) }}
      </p>
      <textarea
        v-if="props.canEdit"
        v-model="draft"
        class="docker-files-editor mono"
        spellcheck="false"
        :aria-label="props.t('docker.filesSave')"
      />
      <pre v-else-if="props.previewText !== null" class="docker-files-text mono">{{ props.previewText }}</pre>
      <p v-else class="docker-files-hint">{{ props.t("docker.filesBinary") }}</p>
    </template>
  </section>
</template>

<style scoped>
.docker-files-preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  padding: 0.5rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 0.35rem;
}
.docker-files-preview-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  font-size: 0.8rem;
}
.docker-files-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.78rem;
  line-height: 1.4;
}
.docker-files-editor {
  flex: 1;
  min-height: 12rem;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 0.35rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 0.3rem;
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
  line-height: 1.4;
}
.docker-files-save {
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
.docker-files-save:disabled {
  opacity: 0.5;
  cursor: default;
}
.docker-files-save svg {
  width: 0.9rem;
  height: 0.9rem;
}
.docker-files-hint {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.72;
}
.docker-files-error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--destructive, #d9534f);
}
.spin {
  animation: docker-files-preview-spin 1s linear infinite;
}
@keyframes docker-files-preview-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
