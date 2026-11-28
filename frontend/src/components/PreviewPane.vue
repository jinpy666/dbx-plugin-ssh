<script lang="ts">
// Markdown 渲染/源码切换的会话级记忆：script-setup 顶层是实例作用域，
// 会话记忆须挂模块作用域（同会话多次打开预览沿用上次选择，不持久化）。
export type MarkdownView = "render" | "source";
let sessionMarkdownView: MarkdownView = "render";
</script>

<script setup lang="ts">
// 多格式预览弹窗（自 files 插件 PreviewPane 移植并适配 SSH sidecar）：
// 文本/代码走 CodeMirror，图片走原生元素，未知扩展走 text/hex 启发式；
// Office/PDF/媒体/表格/演示文稿/OFD/XMind/notebook 与 tiff/heic 等需解码的
// 图片交给 FileViewerPreview。二进制预览经 sftp/stat + sftp/read(offset) 分块
// 流式拼装（≤1MiB/片，≤256MiB）；sudo 模式走 sudo/readFile（≤4MiB/片）；
// 文本/可编辑链路仍走既有整读（≤1MiB）。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, RefreshCw } from "@lucide/vue";
import { formatBytes } from "../lib/format";
import type { EditorConfig, KnownEditor, ResolvedEditor } from "../lib/editorRules";
import { canEditBytes, hexDump, PREVIEW_MAX_BYTES, READ_MAX_BYTES, SUDO_READ_MAX_BYTES } from "../lib/preview";
import { resolvePreview, type PreviewResolution } from "../lib/previewResolver";
import { useChunkedPreview, type PreviewMode } from "../composables/useChunkedPreview";
import FileViewerPreview from "./FileViewerPreview.vue";
import MarkdownRender from "./MarkdownRender.vue";
import PreviewHeader from "./PreviewHeader.vue";
import TextPreview from "./TextPreview.vue";

const props = withDefaults(defineProps<{
  path: string | null;
  sessionId: string | undefined;
  /** sudo 车道：读取走 sudo/readFile、写回走 sudo/writeFile。 */
  sudo: boolean;
  canWrite: boolean;
  /** 宿主外观（CodeMirror 主题色板，与 sftp 编辑器同方案）。 */
  appearance: DbxPluginAppearance;
  t: (key: string, values?: Record<string, string | number>) => string;
  /** 预览头部「打开方式」数据源（App 的编辑器目录/映射配置）。 */
  editors?: KnownEditor[];
  editorConfig?: EditorConfig;
  /** 本机落盘能力：web/docker 形态下打开方式入口不可用。 */
  canOpenLocal?: boolean;
  /** 预览弹窗是否已最大化（头部按钮在最大化/还原图标间切换）。 */
  maximized?: boolean;
}>(), {
  editors: () => [],
  editorConfig: () => ({ associations: [], customEditors: [], uploadPolicy: "auto" }),
  canOpenLocal: false,
  maximized: false,
});

const emit = defineEmits<{
  (event: "close"): void;
  (event: "saved", path: string): void;
  (event: "download", path: string): void;
  (event: "open-with", editor: ResolvedEditor): void;
  (event: "custom-command"): void;
  (event: "request-editors"): void;
  (event: "toggle-maximize"): void;
}>();

type PreviewMode = "text" | "image" | "hex" | "viewer";

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const editError = ref("");
const truncated = ref(false);
// 分块预览的硬上限/大文件询问状态随分块机制下沉 useChunkedPreview。
const size = ref(0);
const mode = ref<PreviewMode>("text");
const editing = ref(false);
const text = ref("");
const draft = ref("");
const hex = ref("");
const resolution = ref<PreviewResolution | null>(null);

// Markdown 渲染视图：md 文件默认渲染面，头部「渲染/源码」分段切换。
const mdView = ref<MarkdownView>(sessionMarkdownView);
const isMarkdown = computed(() => resolution.value?.mime === "text/markdown");
const showMdToggle = computed(() => Boolean(
  isMarkdown.value
  && mode.value === "text"
  && !editing.value
  && !loading.value
  && !error.value,
));
function setMarkdownView(view: MarkdownView) {
  mdView.value = view;
  sessionMarkdownView = view;
}
/** 「打开方式」事件转发：模板内联箭头参数会丢类型，统一走具名函数。 */
function forwardOpenWith(editor: ResolvedEditor): void {
  emit("open-with", editor);
}
// i18n key 未入库时返回 key 本身，据此回退到组件内置兜底文案。
function mdLabel(key: string, fallback: string): string {
  const value = props.t(key);
  return value === key ? fallback : value;
}

const title = computed(() => (props.path ? props.path.split(/[\\/]/).pop() ?? props.path : ""));
/** 头部大小文案：加载中/图片/外置查看器不显示字节数。 */
const headerMeta = computed(() =>
  loading.value || mode.value === "image" || mode.value === "viewer" ? "" : formatBytes(size.value),
);
/** 非 UTF-8 文本（按 GB18030 展示）：编辑必须停用——TextEncoder 只按 UTF-8
 *  写回，保存会把 GB18030 字节整体替换成乱码并永久写坏远端文档。 */
const nonUtf8 = ref(false);
const canEdit = computed(() => Boolean(
  resolution.value?.editable
  && props.canWrite
  && !truncated.value
  && !loading.value
  && !error.value
  && mode.value === "text"
  && !editing.value
  && !nonUtf8.value,
));
const showEditbar = computed(() => Boolean(
  resolution.value?.editable
  && props.canWrite
  && !truncated.value
  && !loading.value
  && !error.value
  && mode.value === "text",
));

// 打开时把焦点移入预览，卸载时归还触发元素。
const previewEl = ref<HTMLElement>();
const textPreviewRef = ref<InstanceType<typeof TextPreview>>();
let returnFocusTo: HTMLElement | null = null;

onMounted(async () => {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  previewEl.value?.focus();
});

onUnmounted(() => {
  if (returnFocusTo?.isConnected) returnFocusTo.focus();
  returnFocusTo = null;
});

watch(editing, async (on) => {
  if (!on) return;
  await nextTick();
  (textPreviewRef.value as unknown as { focus?: () => void } | undefined)?.focus?.();
});

const perChunkBytes = computed(() => (props.sudo ? SUDO_READ_MAX_BYTES : READ_MAX_BYTES));

function readOnce(path: string, offset: number, length: number) {
  if (props.sudo) {
    return window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sudo/readFile", {
      sessionId: props.sessionId,
      path,
      offset,
      length,
    });
  }
  return window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sftp/read", {
    sessionId: props.sessionId,
    path,
    offset,
    maxBytes: length,
  });
}

async function load() {
  if (!props.path) return;
  loading.value = true;
  saving.value = false;
  editing.value = false;
  error.value = "";
  editError.value = "";
  hex.value = "";
  mode.value = "text";
  resolution.value = resolvePreview(props.path);
  mdView.value = sessionMarkdownView;
  text.value = "";
  draft.value = "";
  size.value = 0;
  truncated.value = false;
  nonUtf8.value = false;
  // 换文件即失效进行中的分块循环与读取请求（token 检查点见 runChunkLoop）；
  // 分块状态（进度/取消/门禁/objectURL/收口产物）随令牌一并重置。
  const token = chunked.newAttempt();
  try {
    // 二进制预览（图片/媒体/Office/PDF）：stat 取大小 → read 分块流式拼装；
    // 文本/代码与未知扩展仍走整读（可编辑链路不动）。
    if (resolution.value.previewStrategy === "image" || resolution.value.previewStrategy === "file-viewer") {
      await chunked.loadChunked(resolution.value);
      return;
    }
    const result = await readOnce(props.path, 0, perChunkBytes.value);
    // 过期响应一律作废，状态归新一次 load 所有。
    if (!chunked.isCurrent(token)) return;
    const bytes = window.dbxPlugin.decodeBase64(result.dataBase64);
    truncated.value = Boolean(result.truncated);
    // sudo/readFile 不回 size；整读语义下已加载字节即展示大小。
    size.value = result.truncated ? bytes.byteLength : bytes.byteLength;
    // 文本/代码与未知扩展：先按 UTF-8 严格解码；失败（GBK 等非 UTF-8）回退
    // GB18030 展示并停用编辑。
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      nonUtf8.value = false;
    } catch {
      decoded = new TextDecoder("gb18030").decode(bytes);
      nonUtf8.value = true;
    }
    if (resolution.value.previewStrategy === "hex" && looksBinaryText(decoded)) {
      mode.value = "hex";
      hex.value = hexDump(bytes.subarray(0, 512));
      return;
    }
    mode.value = "text";
    text.value = decoded;
    draft.value = decoded;
  } catch (cause) {
    if (!chunked.isCurrent(token)) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    // 只有当前这一次 load 才能收 loading；过期请求的 finally 不得干预。
    if (chunked.isCurrent(token)) loading.value = false;
  }
}

/** 未知扩展的可读性启发式（files 同款 printable 比例判定）：不可读比例 >8% 走 hex。 */
function looksBinaryText(decoded: string): boolean {
  if (!decoded.length) return false;
  const printable = decoded.replace(/[^\t\n\r\x20-\x7E\u00A0-\uFFFF]/g, "");
  return 1 - printable.length / decoded.length > 0.08;
}

// 二进制分块流式加载（stat → 顺序分片 → Blob 收口）下沉 useChunkedPreview：
// 硬上限/大文件询问/取消/失败续传与令牌失效语义随迁，本组件只经返回面
// 消费状态（进度条/大文件询问/超限/图片 objectURL/viewer File）。readOnce/perChunkBytes 在上方定义，闭包惰性求值，无 TDZ 风险。
const chunked = useChunkedPreview({
  path: () => props.path,
  perChunkBytes: () => perChunkBytes.value,
  readOnce,
  title: () => title.value,
  resolution: () => resolution.value,
  loading,
  sudo: () => props.sudo,
  sessionId: () => props.sessionId,
  size,
  error,
  setMode: (value) => { mode.value = value; },
  emitClose: () => emit("close"),
});
const { chunkActive, loadedBytes, totalBytes, chunkPercent, largeFile, overCap, dataUri, sourceFile, previewLargeAnyway, cancelChunkLoad, resumeChunkLoad } = chunked;

function handleViewerError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : String(cause);
}

function startEdit() {
  if (!canEdit.value) return;
  draft.value = text.value;
  editError.value = "";
  editing.value = true;
}

function cancelEdit() {
  draft.value = text.value;
  editError.value = "";
  editing.value = false;
}

async function saveEdit() {
  if (!props.path || saving.value) return;
  editError.value = "";
  const bytes = new TextEncoder().encode(draft.value);
  if (!canEditBytes(bytes.byteLength)) {
    editError.value = props.t("sftpAttrs.sizeLimit");
    return;
  }
  saving.value = true;
  try {
    const dataBase64 = window.dbxPlugin.encodeBase64(bytes);
    if (props.sudo) {
      await window.dbxPlugin.invoke("sudo/writeFile", { sessionId: props.sessionId, path: props.path, dataBase64 });
    } else {
      await window.dbxPlugin.invoke("sftp/write", { sessionId: props.sessionId, remotePath: props.path, dataBase64 });
    }
    text.value = draft.value;
    size.value = bytes.byteLength;
    editing.value = false;
    emit("saved", props.path);
  } catch (cause) {
    editError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.path,
  () => {
    if (props.path) void load();
  },
  { immediate: true },
);

// 向外暴露未保存草稿状态——App 侧关闭预览（Esc/遮罩/关闭钮）时，
// 编辑中且草稿已改动先弹丢弃确认，防止静默丢失 CodeMirror 编辑内容。
const isDirty = computed(() => editing.value && draft.value !== text.value);
defineExpose({ isDirty });

// viewer 渲染不了的文档类格式（pptx 等未装配 renderer / 损坏文件）：提示改用
// 平台外部应用打开（或下载）。
const canOpenExternal = computed(() =>
  resolution.value?.kind === "office" || resolution.value?.kind === "pdf" || resolution.value?.kind === "media",
);
</script>

<template>
  <div v-if="path" ref="previewEl" tabindex="-1" class="ssh-preview" data-test="ssh-preview">
    <PreviewHeader
      :t="t"
      :title="title"
      :path="path"
      :meta="headerMeta"
      :show-md-toggle="showMdToggle"
      :md-view="mdView"
      :md-render-label="mdLabel('previewDialog.mdRenderView', '渲染')"
      :md-source-label="mdLabel('previewDialog.mdSourceView', '源码')"
      :can-edit="canEdit"
      :saving="saving"
      :editors="editors"
      :editor-config="editorConfig"
      :can-open="canOpenLocal && canWrite"
      :disabled-hint="canOpenLocal ? undefined : t('sftpEdit.desktopOnly')"
      :maximized="maximized"
      @edit="startEdit"
      @set-md-view="setMarkdownView"
      @download="emit('download', path)"
      @toggle-maximize="emit('toggle-maximize')"
      @close="emit('close')"
      @open-with="(editor) => emit('open-with', editor)"
      @custom-command="emit('custom-command')"
      @request-editors="emit('request-editors')"
    />
    <div v-if="nonUtf8 && mode === 'text' && !loading && !error" class="ssh-preview-editbar" data-test="nonutf8-hint">{{ t("previewDialog.nonUtf8") }}</div>
    <div v-if="showEditbar" class="ssh-preview-editbar">
      <template v-if="editing">
        <span v-if="editError" class="ssh-preview-edit-error" data-test="edit-error">{{ editError }}</span>
        <button type="button" class="ssh-preview-chip" :disabled="saving" @click="cancelEdit">{{ t("cancel") }}</button>
        <button type="button" class="ssh-preview-chip ssh-preview-chip-primary" :disabled="saving" @click="saveEdit">{{ t("editSave.save") }}</button>
      </template>
      <span v-else class="ssh-preview-meta">{{ t("editSave.edit") }}</span>
    </div>
    <!-- 分块加载进度（二进制预览）：字节进度 + 取消；失败后保留以便续传重试。 -->
    <div v-if="chunkActive" class="ssh-preview-editbar" data-test="chunkbar">
      <span class="ssh-preview-meta">{{ t("previewDialog.chunkProgress", { done: formatBytes(loadedBytes), total: totalBytes ? formatBytes(totalBytes) : "" }) }}</span>
      <div class="ssh-preview-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="totalBytes ? chunkPercent : undefined"><div class="ssh-preview-progress-bar" :style="{ width: `${totalBytes ? chunkPercent : 50}%` }" /></div>
      <button type="button" class="ssh-preview-chip" data-test="chunk-cancel" @click="cancelChunkLoad">{{ t("cancel") }}</button>
    </div>
    <div class="ssh-preview-body" :aria-busy="loading">
      <template v-if="loading">
        <div class="ssh-preview-skeleton">
          <span role="status" class="ssh-preview-meta">{{ t("loading") }}</span>
          <span v-for="row in 8" :key="row" class="ssh-preview-skeleton-row" aria-hidden="true" :style="{ width: `${100 - (row % 3) * 12}%` }" />
        </div>
      </template>
      <div v-else-if="largeFile" class="ssh-preview-notice" data-test="preview-large">
        <div>{{ t("previewDialog.largeFileNotice", { size: formatBytes(totalBytes) }) }}</div>
        <div class="ssh-preview-meta">{{ t("previewDialog.largeFileHint") }}</div>
        <div class="ssh-preview-actions-row">
          <FileOpenWithMenu
            class="ssh-open-with-up"
            :file-name="title"
            :editors="editors"
            :editor-config="editorConfig"
            :can-open="canOpenLocal && canWrite"
            :disabled-hint="canOpenLocal ? undefined : t('sftpEdit.desktopOnly')"
            :t="t"
            @open="forwardOpenWith"
            @custom-command="emit('custom-command')"
            @request-editors="emit('request-editors')"
          />
          <button type="button" class="ssh-preview-chip" data-test="preview-large-download" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
          <button type="button" class="ssh-preview-chip" data-test="preview-large-anyway" @click="previewLargeAnyway">{{ t("previewDialog.previewAnyway") }}</button>
        </div>
      </div>
      <!-- 超过硬上限：不提供「仍要预览」，只保留下载 / 本地打开。 -->
      <div v-else-if="overCap" class="ssh-preview-notice" data-test="overcap">
        <div>{{ t("previewDialog.overCap", { size: formatBytes(PREVIEW_MAX_BYTES) }) }}</div>
        <div class="ssh-preview-meta">{{ t("previewDialog.largeFileHint") }}</div>
        <div class="ssh-preview-actions-row">
          <button type="button" class="ssh-preview-chip" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
          <FileOpenWithMenu
            class="ssh-open-with-up"
            :file-name="title"
            :editors="editors"
            :editor-config="editorConfig"
            :can-open="canOpenLocal && canWrite"
            :disabled-hint="canOpenLocal ? undefined : t('sftpEdit.desktopOnly')"
            :t="t"
            @open="forwardOpenWith"
            @custom-command="emit('custom-command')"
            @request-editors="emit('request-editors')"
          />
        </div>
      </div>
      <div v-else-if="error" class="ssh-preview-notice" data-test="preview-error">
        <div>{{ t("previewDialog.loadError", { error }) }}</div>
        <div v-if="canOpenExternal" class="ssh-preview-meta">{{ t("previewDialog.externalHint") }}</div>
        <div class="ssh-preview-actions-row">
          <!-- 分块失败续传：从失败 offset 继续（>0 才有意义）。 -->
          <button v-if="chunkActive && loadedBytes" type="button" class="ssh-preview-chip" data-test="chunk-retry" @click="resumeChunkLoad"><RefreshCw /> {{ t("previewDialog.retryFromOffset", { offset: loadedBytes }) }}</button>
          <button type="button" class="ssh-preview-chip" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
        </div>
      </div>
      <img v-else-if="mode === 'image'" class="ssh-preview-image" :src="dataUri" :alt="title" />
      <!-- Markdown 渲染视图：白名单子集 + 全量 HTML 转义；解析异常回退源码。 -->
      <MarkdownRender
        v-else-if="mode === 'text' && showMdToggle && mdView === 'render'"
        :text="text"
        @render-error="setMarkdownView('source')"
      />
      <!-- 文本预览/编辑：CodeMirror（与 sftp 面板同方案）；key 保证进入/退出
           编辑都从 props.text 全新装载，取消编辑即回滚草稿。 -->
      <TextPreview
        v-else-if="mode === 'text'"
        ref="textPreviewRef"
        :key="editing ? 'edit' : 'read'"
        :text="text"
        :file-name="title"
        :appearance="appearance"
        :editable="editing"
        @change="draft = $event"
      />
      <pre v-else-if="mode === 'hex'" class="ssh-preview-hex">{{ hex }}</pre>
      <FileViewerPreview
        v-else-if="mode === 'viewer' && sourceFile"
        :source="sourceFile"
        :file-name="title"
        :mime="resolution?.mime ?? undefined"
        :appearance="appearance"
        class="ssh-preview-viewer"
        @error="handleViewerError"
      />
      <div v-else class="ssh-preview-notice">{{ t("previewDialog.unsupported") }}</div>
    </div>
    <div v-if="truncated" class="ssh-preview-banner" data-test="truncated">
      <span>{{ t("previewDialog.truncatedNotice", { size: formatBytes(perChunkBytes) }) }}</span>
      <button type="button" class="ssh-preview-chip" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
    </div>
  </div>
</template>
