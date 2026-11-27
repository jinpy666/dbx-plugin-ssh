<script setup lang="ts">
// Docker 容器文件面板（B4，只读）：目录浏览 + 文本预览。
// 两个 RPC 都只读（`docker/files/list` / `docker/files/read`），没有写/删入口。
// 路径安全校验、容器 id 门、固定脚本 + 位置参数都在 sidecar；这里只做
// 展示层归一与错误呈现。
import { computed, ref, watch } from "vue";
import { ArrowUp, File, Folder, Link2, Loader2, RefreshCw } from "@lucide/vue";
import {
  DOCKER_FILES_DEFAULT_MAX_BYTES,
  decodeBase64Bytes,
  decodeFileText,
  formatFileSize,
  isHiddenDockerName,
  parentDockerPath,
  parseDockerFileContent,
  parseDockerFilesListing,
  type DockerFileContent,
  type DockerFileEntry,
  type DockerFilesListing,
} from "../lib/dockerFiles";

interface FilesTarget {
  id: string;
  name?: string;
}

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  target: FilesTarget;
  /** 通用参数（target/sessionId/cli/socket/host），由面板的 dockerParams 计算。 */
  params: () => Record<string, unknown>;
}>();

const path = ref("/");
const showHidden = ref(false);
const listing = ref<DockerFilesListing | null>(null);
const loading = ref(false);
const error = ref("");

const selected = ref<DockerFileEntry | null>(null);
const content = ref<DockerFileContent | null>(null);
const readLoading = ref(false);
const readError = ref("");

const visibleEntries = computed(() =>
  (listing.value?.entries ?? []).filter((entry) => showHidden.value || !isHiddenDockerName(entry.name)),
);

const previewText = computed(() => {
  if (!content.value) return null;
  return decodeFileText(decodeBase64Bytes(content.value.dataBase64));
});

const previewTruncated = computed(() => Boolean(content.value?.truncated));

function baseParams(extra: Record<string, unknown>): Record<string, unknown> {
  return { ...props.params(), containerId: props.target.id, ...extra };
}

function iconFor(entry: DockerFileEntry) {
  if (entry.kind === "dir") return Folder;
  if (entry.kind === "link") return Link2;
  return File;
}

function kindLabel(entry: DockerFileEntry): string {
  const keys: Record<DockerFileEntry["kind"], string> = {
    file: "docker.filesKindFile",
    dir: "docker.filesKindDir",
    link: "docker.filesKindLink",
    other: "docker.filesKindOther",
  };
  return props.t(keys[entry.kind]);
}

async function load(nextPath: string): Promise<void> {
  const target = String(nextPath || "/");
  loading.value = true;
  error.value = "";
  try {
    const payload = await window.dbxPlugin.invoke<unknown>(
      "docker/files/list",
      baseParams({ path: target, showHidden: showHidden.value }),
      { timeoutMs: 30_000 },
    );
    const parsed = parseDockerFilesListing(payload);
    listing.value = parsed;
    path.value = parsed.path;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function openEntry(entry: DockerFileEntry): Promise<void> {
  if (entry.kind === "dir") {
    selected.value = null;
    content.value = null;
    readError.value = "";
    await load(entry.path);
    return;
  }
  if (entry.kind !== "file") return;
  selected.value = entry;
  content.value = null;
  readError.value = "";
  readLoading.value = true;
  try {
    const payload = await window.dbxPlugin.invoke<unknown>(
      "docker/files/read",
      baseParams({ path: entry.path, maxBytes: DOCKER_FILES_DEFAULT_MAX_BYTES }),
      { timeoutMs: 60_000 },
    );
    content.value = parseDockerFileContent(payload);
  } catch (cause) {
    readError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    readLoading.value = false;
  }
}

function goUp(): void {
  void load(parentDockerPath(path.value));
}

function refresh(): void {
  void load(path.value);
}

function toggleHidden(): void {
  void load(path.value);
}

watch(
  () => props.target.id,
  (id) => {
    if (!id) return;
    path.value = "/";
    selected.value = null;
    content.value = null;
    void load("/");
  },
  { immediate: true },
);
</script>

<template>
  <div class="docker-files-pane">
    <div class="docker-files-toolbar">
      <button type="button" class="docker-files-icon" :title="props.t('docker.filesUp')" :aria-label="props.t('docker.filesUp')" :disabled="path === '/' || loading" @click="goUp">
        <ArrowUp />
      </button>
      <input
        v-model="path"
        class="docker-files-path mono"
        :aria-label="props.t('docker.filesPath')"
        spellcheck="false"
        @keyup.enter="load(path)"
      />
      <button type="button" class="docker-files-icon" :title="props.t('docker.filesRefresh')" :aria-label="props.t('docker.filesRefresh')" :disabled="loading" @click="refresh">
        <RefreshCw :class="{ spin: loading }" />
      </button>
      <label class="docker-files-hidden">
        <input v-model="showHidden" type="checkbox" @change="toggleHidden" />
        {{ props.t("docker.filesShowHidden") }}
      </label>
    </div>

    <p v-if="error" class="docker-files-error">{{ props.t("docker.filesLoadFailed") }} {{ error }}</p>
    <p v-else-if="loading && !listing" class="docker-files-hint">{{ props.t("docker.filesLoading") }}</p>
    <p v-else-if="visibleEntries.length === 0" class="docker-files-hint">{{ props.t("docker.filesEmpty") }}</p>
    <p v-if="listing?.truncated" class="docker-files-hint">{{ props.t("docker.filesTruncated", { count: 500 }) }}</p>

    <div class="docker-files-body">
      <ul v-if="visibleEntries.length > 0" class="docker-files-list">
        <li v-for="entry in visibleEntries" :key="entry.path">
          <button
            type="button"
            class="docker-files-row"
            :class="{ 'docker-files-row--active': selected?.path === entry.path }"
            :disabled="entry.kind === 'link' || entry.kind === 'other'"
            @click="openEntry(entry)"
          >
            <component :is="iconFor(entry)" class="docker-files-icon-kind" />
            <span class="docker-files-name">{{ entry.name }}</span>
            <span class="docker-files-kind">{{ kindLabel(entry) }}</span>
            <span class="docker-files-size mono">{{ entry.kind === "file" ? formatFileSize(entry.size) : "—" }}</span>
          </button>
        </li>
      </ul>

      <section class="docker-files-preview" :aria-label="props.t('docker.filesPreview')">
        <p v-if="!selected" class="docker-files-hint">{{ props.t("docker.filesSelectFile") }}</p>
        <p v-else-if="readLoading" class="docker-files-hint"><Loader2 class="spin" /> {{ props.t("docker.filesLoading") }}</p>
        <p v-else-if="readError" class="docker-files-error">{{ props.t("docker.filesReadFailed") }} {{ readError }}</p>
        <template v-else-if="content">
          <div class="docker-files-preview-head">
            <strong class="mono">{{ selected.name }}</strong>
            <span>{{ formatFileSize(content.size) }}</span>
          </div>
          <p v-if="previewTruncated" class="docker-files-hint">
            {{ props.t("docker.filesPreviewTruncated", { size: formatFileSize(content.size), limit: formatFileSize(DOCKER_FILES_DEFAULT_MAX_BYTES) }) }}
          </p>
          <pre v-if="previewText !== null" class="docker-files-text mono">{{ previewText }}</pre>
          <p v-else class="docker-files-hint">{{ props.t("docker.filesBinary") }}</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.docker-files-pane {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  height: 100%;
}
.docker-files-toolbar {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.docker-files-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 0.3rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.docker-files-icon svg {
  width: 1rem;
  height: 1rem;
}
.docker-files-icon:disabled {
  opacity: 0.45;
  cursor: default;
}
.docker-files-path {
  flex: 1;
  min-width: 8rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 0.3rem;
  background: transparent;
  color: inherit;
}
.docker-files-hidden {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.78rem;
  white-space: nowrap;
}
.docker-files-body {
  display: grid;
  grid-template-columns: minmax(14rem, 1fr) minmax(16rem, 1.2fr);
  gap: 0.6rem;
  min-height: 0;
  flex: 1;
}
.docker-files-list {
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 0.35rem;
}
.docker-files-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.3rem 0.45rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.docker-files-row:hover:not(:disabled),
.docker-files-row--active {
  background: rgba(128, 128, 128, 0.14);
}
.docker-files-row:disabled {
  opacity: 0.65;
  cursor: default;
}
.docker-files-icon-kind {
  width: 0.9rem;
  height: 0.9rem;
  flex: none;
}
.docker-files-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.docker-files-kind,
.docker-files-size {
  flex: none;
  font-size: 0.72rem;
  opacity: 0.7;
}
.docker-files-size {
  min-width: 4.5rem;
  text-align: right;
}
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
  animation: docker-files-spin 1s linear infinite;
}
@keyframes docker-files-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 720px) {
  .docker-files-body {
    grid-template-columns: 1fr;
  }
}
</style>
