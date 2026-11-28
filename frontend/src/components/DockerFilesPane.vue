<script setup lang="ts">
// Docker 容器文件面板（B4 只读 + B6 写/删）：目录浏览、文本预览/编辑保存、
// 删除确认。路径安全、容器 id 门、固定脚本 + 位置参数、只读连接拒绝、64 KiB
// 写入上限与审计都在 sidecar；这里只做展示层归一、确认状态机与错误呈现。
import { computed, ref, watch } from "vue";
import { ArrowUp, File, Folder, Link2, RefreshCw, Trash2 } from "@lucide/vue";
import DockerFilePreview from "./DockerFilePreview.vue";
import DockerFilesConfirmBar from "./DockerFilesConfirmBar.vue";
import {
  DOCKER_FILES_DEFAULT_MAX_BYTES,
  DOCKER_FILES_WRITE_MAX_BYTES,
  confirmDockerMutation,
  decodeBase64Bytes,
  decodeFileText,
  encodeFileText,
  filterDockerFileEntries,
  formatFileSize,
  initialDockerMutation,
  isHiddenDockerName,
  parentDockerPath,
  parseDockerFileContent,
  parseDockerFilesListing,
  requestDockerDelete,
  requestDockerWrite,
  settleDockerMutation,
  utf8ByteLength,
  type DockerFileContent,
  type DockerFileEntry,
  type DockerFilesListing,
  type DockerMutationRequest,
  type DockerMutationState,
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
const fileQuery = ref("");
const listing = ref<DockerFilesListing | null>(null);
const loading = ref(false);
const error = ref("");

const selected = ref<DockerFileEntry | null>(null);
const content = ref<DockerFileContent | null>(null);
const readLoading = ref(false);
const readError = ref("");

const draft = ref("");
const saving = ref(false);
const mutation = ref<DockerMutationState>(initialDockerMutation());
const mutationError = ref("");
const notice = ref("");

const visibleEntries = computed(() =>
  filterDockerFileEntries(
    (listing.value?.entries ?? []).filter((entry) => showHidden.value || !isHiddenDockerName(entry.name)),
    fileQuery.value,
  ),
);

const previewText = computed(() => {
  if (!content.value) return null;
  return decodeFileText(decodeBase64Bytes(content.value.dataBase64));
});

/** 可编辑全文（预览只取前 200k 字符；保存必须拿到完整内容）。 */
const editableText = computed(() => {
  if (!content.value) return null;
  return decodeFileText(decodeBase64Bytes(content.value.dataBase64), 8 * 1024 * 1024);
});

const previewTruncated = computed(() => Boolean(content.value?.truncated));

const canEdit = computed(() => {
  if (!content.value || previewTruncated.value) return false;
  if (content.value.size > DOCKER_FILES_WRITE_MAX_BYTES) return false;
  return editableText.value !== null;
});

const draftBytes = computed(() => utf8ByteLength(draft.value));
const draftDirty = computed(() => editableText.value !== null && draft.value !== editableText.value);
const isLocalTarget = computed(() => props.params().target === "local");

const promptText = computed(() => {
  const pending = mutation.value.pending;
  if (!pending) return "";
  if (pending.kind === "write") {
    return props.t("docker.filesOverwriteConfirm", { path: pending.path });
  }
  return pending.recursive
    ? props.t("docker.filesDeleteRecursiveConfirm", { path: pending.path })
    : props.t("docker.filesDeleteConfirm", { path: pending.path });
});

watch(editableText, (value) => {
  draft.value = value ?? "";
});

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

function clearTransient(): void {
  mutationError.value = "";
  notice.value = "";
  mutation.value = settleDockerMutation().state;
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

async function readFile(entry: DockerFileEntry): Promise<void> {
  selected.value = entry;
  content.value = null;
  readError.value = "";
  draft.value = "";
  readLoading.value = true;
  clearTransient();
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

async function openEntry(entry: DockerFileEntry): Promise<void> {
  if (entry.kind === "dir") {
    selected.value = null;
    content.value = null;
    readError.value = "";
    draft.value = "";
    clearTransient();
    await load(entry.path);
    return;
  }
  if (entry.kind !== "file") return;
  await readFile(entry);
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

/** 保存草稿：已存在（刚读过）→ 先弹覆盖确认；确认后走 `executeMutation`。 */
function saveDraft(): void {
  if (!selected.value || saving.value || !canEdit.value || !draftDirty.value) return;
  if (draftBytes.value > DOCKER_FILES_WRITE_MAX_BYTES) {
    mutationError.value = props.t("docker.filesSaveTooLarge", {
      limit: formatFileSize(DOCKER_FILES_WRITE_MAX_BYTES),
    });
    return;
  }
  const step = requestDockerWrite(mutation.value, selected.value.path, true);
  mutation.value = step.state;
  mutationError.value = "";
  notice.value = "";
  if (step.request) void executeMutation(step.request);
}

/** 删除入口：文件与目录都二次确认；目录带 recursive。 */
function deleteEntry(entry: DockerFileEntry): void {
  if (saving.value) return;
  const step = requestDockerDelete(mutation.value, entry.path, entry.kind === "dir");
  mutation.value = step.state;
  mutationError.value = "";
  notice.value = "";
}

function confirmMutation(): void {
  const step = confirmDockerMutation(mutation.value, true);
  mutation.value = step.state;
  if (step.request) void executeMutation(step.request);
}

function cancelMutation(): void {
  mutation.value = confirmDockerMutation(mutation.value, false).state;
}

async function executeMutation(request: DockerMutationRequest): Promise<void> {
  saving.value = true;
  mutationError.value = "";
  try {
    if (request.kind === "write") {
      const bytes = utf8ByteLength(draft.value);
      if (bytes > DOCKER_FILES_WRITE_MAX_BYTES) {
        throw new Error(props.t("docker.filesSaveTooLarge", {
          limit: formatFileSize(DOCKER_FILES_WRITE_MAX_BYTES),
        }));
      }
      await window.dbxPlugin.invoke<unknown>(
        "docker/files/write",
        baseParams({
          path: request.path,
          dataBase64: encodeFileText(draft.value),
          overwrite: request.overwrite,
        }),
        { timeoutMs: 60_000 },
      );
      await load(path.value);
      const entry = selected.value;
      if (entry && entry.path === request.path) await readFile(entry);
      notice.value = props.t("docker.filesSaved");
    } else {
      await window.dbxPlugin.invoke<unknown>(
        "docker/files/delete",
        baseParams({
          path: request.path,
          recursive: request.recursive,
          ...(isLocalTarget.value ? { confirm: true } : {}),
        }),
        { timeoutMs: 60_000 },
      );
      notice.value = props.t("docker.filesDeleted");
      const current = selected.value;
      if (current && (current.path === request.path || current.path.startsWith(`${request.path}/`))) {
        selected.value = null;
        content.value = null;
      }
      await load(path.value);
    }
  } catch (cause) {
    mutationError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
    mutation.value = settleDockerMutation().state;
  }
}

watch(
  () => props.target.id,
  (id) => {
    if (!id) return;
    path.value = "/";
    selected.value = null;
    content.value = null;
    draft.value = "";
    clearTransient();
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
      <input
        v-model="fileQuery"
        class="docker-files-search"
        type="search"
        :placeholder="props.t('docker.filesSearchPlaceholder')"
        :aria-label="props.t('docker.filesSearchPlaceholder')"
        data-test="docker-files-search"
      />
    </div>

    <p v-if="error" class="docker-files-error">{{ props.t("docker.filesLoadFailed") }} {{ error }}</p>
    <p v-else-if="loading && !listing" class="docker-files-hint">{{ props.t("docker.filesLoading") }}</p>
    <p v-else-if="visibleEntries.length === 0" class="docker-files-hint">
      {{ props.t(fileQuery.trim() ? "docker.filesNoMatch" : "docker.filesEmpty") }}
    </p>
    <p v-if="listing?.truncated" class="docker-files-hint">{{ props.t("docker.filesTruncated", { count: 500 }) }}</p>

    <DockerFilesConfirmBar
      v-if="mutation.pending"
      :message="promptText"
      :confirm-label="props.t('docker.filesConfirm')"
      :cancel-label="props.t('docker.filesCancel')"
      :busy="saving"
      @confirm="confirmMutation"
      @cancel="cancelMutation"
    />
    <p v-if="mutationError" class="docker-files-error">{{ props.t("docker.filesMutationFailed") }} {{ mutationError }}</p>
    <p v-else-if="notice" class="docker-files-hint">{{ notice }}</p>

    <div class="docker-files-body">
      <ul v-if="visibleEntries.length > 0" class="docker-files-list">
        <li v-for="entry in visibleEntries" :key="entry.path">
          <div
            class="docker-files-row"
            :class="{ 'docker-files-row--active': selected?.path === entry.path }"
          >
            <button
              type="button"
              class="docker-files-open"
              :disabled="entry.kind === 'link' || entry.kind === 'other'"
              @click="openEntry(entry)"
            >
              <component :is="iconFor(entry)" class="docker-files-icon-kind" />
              <span class="docker-files-name">{{ entry.name }}</span>
              <span class="docker-files-kind">{{ kindLabel(entry) }}</span>
              <span class="docker-files-size mono">{{ entry.kind === "file" ? formatFileSize(entry.size) : "—" }}</span>
            </button>
            <button
              type="button"
              class="docker-files-icon docker-files-delete"
              :title="props.t('docker.filesDelete')"
              :aria-label="props.t('docker.filesDelete')"
              :disabled="saving"
              @click="deleteEntry(entry)"
            >
              <Trash2 />
            </button>
          </div>
        </li>
      </ul>

      <DockerFilePreview
        v-model:draft="draft"
        :t="props.t"
        :entry="selected"
        :content="content"
        :loading="readLoading"
        :error="readError"
        :can-edit="canEdit"
        :preview-text="previewText"
        :preview-truncated="previewTruncated"
        :dirty="draftDirty"
        :too-large="draftBytes > DOCKER_FILES_WRITE_MAX_BYTES"
        :saving="saving"
        @save="saveDraft"
      />
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
.docker-files-search {
  flex: 0 1 9rem;
  min-width: 5rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 0.3rem;
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
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
  gap: 0.25rem;
  width: 100%;
  padding: 0.2rem 0.35rem;
  border: 0;
  color: inherit;
  text-align: left;
}
.docker-files-row:hover,
.docker-files-row--active {
  background: rgba(128, 128, 128, 0.14);
}
.docker-files-open {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 1;
  min-width: 0;
  padding: 0.1rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.docker-files-open:disabled {
  opacity: 0.65;
  cursor: default;
}
.docker-files-delete {
  flex: none;
  opacity: 0.55;
}
.docker-files-row:hover .docker-files-delete {
  opacity: 1;
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
