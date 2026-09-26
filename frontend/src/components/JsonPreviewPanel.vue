<script setup lang="ts">
// JSON 格式化预览面板（issue #96）：挂在预览弹窗里替换只读 TextPreview 的纯前端组件。
// - kind=ok：格式化/原始切换（reka ToggleGroup）；格式化 = pretty 文本 + 可搜索字段列表
//   （每行复制值/复制路径）；工具栏「复制整篇文本」按当前视图取 pretty 或原文。
// - kind=invalid/too-large：提示条 + 原始文本（复用 TextPreview 只读，保留语法高亮）。
// kind=unavailable 时 App.vue 不会挂载本组件（回落既有 TextPreview）。
// 复制走 lib/clipboardBridge 三级降级（宿主桥 → navigator.clipboard → execCommand），
// 结果用按钮内联反馈（已复制/复制失败），不依赖 App 的错误条。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, Copy, Search } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { writeClipboardText, type ClipboardDeps } from "../lib/clipboardBridge";
import { filterJsonFields, type JsonPreviewField, type JsonPreviewState } from "../lib/jsonPreview";
import TextPreview from "./TextPreview.vue";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const props = defineProps<{
  state: JsonPreviewState;
  text: string;
  fileName: string;
  locale: string;
  appearance: DbxPluginAppearance;
}>();

const mode = ref<"formatted" | "raw">("formatted");
const search = ref("");
const copiedKey = ref("");
const failedKey = ref("");
let copiedTimer = 0;

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const fields = computed(() => (props.state.kind === "ok" ? props.state.fields : []));
const filteredFields = computed(() => filterJsonFields(fields.value, search.value));

// 「复制整篇文本」：格式化视图复制 pretty，原始视图复制原文。
const copyAllText = computed(() => (props.state.kind === "ok" && mode.value === "formatted" ? props.state.pretty : props.text));

const fieldCountText = computed(() => t("jsonPreview.fieldsCount", { matched: filteredFields.value.length, total: fields.value.length }));

function clipboardDeps(): ClipboardDeps {
  return {
    bridge: window.dbxPlugin?.clipboard ?? null,
    nativeClipboard: typeof navigator !== "undefined" ? navigator.clipboard ?? null : null,
  };
}

function flashResult(key: string, ok: boolean) {
  copiedKey.value = ok ? key : "";
  failedKey.value = ok ? "" : key;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copiedKey.value = "";
    failedKey.value = "";
  }, 1500);
}

async function copyText(value: string, key: string) {
  try {
    await writeClipboardText(value, clipboardDeps());
    flashResult(key, true);
  } catch {
    flashResult(key, false);
  }
}

function copyField(field: JsonPreviewField) {
  void copyText(field.fullValue, `value:${field.path}`);
}

function copyFieldPath(field: JsonPreviewField) {
  void copyText(field.path, `path:${field.path}`);
}

function copyAll() {
  void copyText(copyAllText.value, "all");
}

function setMode(value: unknown) {
  if (value === "formatted" || value === "raw") mode.value = value;
}

// 换文件（text 变化）时清空搜索词，避免上一份文件的过滤条件残留在新文件上。
watch(
  () => props.text,
  () => {
    search.value = "";
  },
);

onBeforeUnmount(() => window.clearTimeout(copiedTimer));
</script>

<template>
  <div class="json-preview">
    <div class="json-preview-toolbar">
      <ToggleGroup v-if="state.kind === 'ok'" type="single" :model-value="mode" class="json-preview-toggle" @update:model-value="setMode">
        <ToggleGroupItem value="formatted" :title="t('jsonPreview.formatted')">{{ t("jsonPreview.formatted") }}</ToggleGroupItem>
        <ToggleGroupItem value="raw" :title="t('jsonPreview.raw')">{{ t("jsonPreview.raw") }}</ToggleGroupItem>
      </ToggleGroup>
      <span v-else class="json-preview-hint" role="status">{{ state.kind === "invalid" ? t("jsonPreview.invalidHint") : t("jsonPreview.tooLargeHint") }}</span>
      <span v-if="state.kind === 'ok'" class="json-preview-spacer" />
      <label v-if="state.kind === 'ok' && mode === 'formatted'" class="json-preview-search">
        <Search aria-hidden="true" />
        <input v-model="search" type="text" spellcheck="false" :placeholder="t('jsonPreview.searchPlaceholder')" :aria-label="t('jsonPreview.searchPlaceholder')" />
        <span class="json-preview-count">{{ fieldCountText }}</span>
      </label>
      <button type="button" class="json-preview-copy-all" :title="t('jsonPreview.copyAll')" @click="copyAll">
        <Check v-if="copiedKey === 'all'" class="json-preview-copied" />
        <Copy v-else />
        {{ failedKey === "all" ? t("jsonPreview.copyFailed") : copiedKey === "all" ? t("jsonPreview.copied") : t("jsonPreview.copyAll") }}
      </button>
    </div>
    <div v-if="state.kind === 'ok' && mode === 'formatted'" class="json-preview-body">
      <pre class="json-preview-text">{{ state.pretty }}</pre>
      <div class="json-preview-fields" role="list">
        <div v-if="filteredFields.length === 0" class="json-preview-empty">{{ t("jsonPreview.noMatch") }}</div>
        <div v-for="field in filteredFields" :key="field.path" class="json-field-row" role="listitem">
          <div class="json-field-line">
            <span class="json-field-path" :title="field.path">{{ field.path }}</span>
            <button type="button" class="json-field-copy" :title="copiedKey === `path:${field.path}` ? t('jsonPreview.copied') : t('jsonPreview.copyPath')" @click="copyFieldPath(field)">
              <Check v-if="copiedKey === `path:${field.path}`" class="json-preview-copied" />
              <Copy v-else />
            </button>
          </div>
          <div class="json-field-line">
            <span class="json-field-value" :title="field.value">{{ field.value }}</span>
            <span class="json-field-type" :data-type="field.type">{{ field.type }}</span>
            <button type="button" class="json-field-copy" :title="copiedKey === `value:${field.path}` ? t('jsonPreview.copied') : t('jsonPreview.copyValue')" @click="copyField(field)">
              <Check v-if="copiedKey === `value:${field.path}`" class="json-preview-copied" />
              <Copy v-else />
            </button>
          </div>
        </div>
      </div>
    </div>
    <TextPreview v-else :text="text" :file-name="fileName" :appearance="appearance" :editable="false" />
  </div>
</template>

<style scoped>
.json-preview {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--background);
}

.json-preview-toolbar {
  display: flex;
  min-height: 28px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 4px 8px;
}

.json-preview-hint {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.json-preview-spacer {
  flex: 1;
}

.json-preview-toggle :deep([data-slot="toggle-group-item"]) {
  min-height: 22px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 10px;
  background: var(--background);
  color: var(--muted-foreground);
  font-size: 11px;
}

.json-preview-toggle :deep([data-slot="toggle-group-item"][data-state="on"]) {
  background: var(--accent);
  color: var(--accent-foreground);
}

.json-preview-search {
  display: flex;
  min-width: 120px;
  max-width: 260px;
  flex: 0 1 240px;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  color: var(--muted-foreground);
}

.json-preview-search svg {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
}

.json-preview-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--foreground);
  font-size: 11px;
}

.json-preview-count {
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 10px;
  white-space: nowrap;
}

.json-preview-copy-all {
  display: inline-flex;
  min-height: 22px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 9px;
  background: var(--background);
  color: var(--foreground);
  font-size: 11px;
}

.json-preview-copy-all:hover:not(:disabled) {
  background: var(--accent);
}

.json-preview-copy-all svg {
  width: 12px;
  height: 12px;
}

.json-preview-copied {
  color: var(--success);
}

.json-preview-body {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.json-preview-text {
  min-width: 0;
  flex: 1 1 60%;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  background: var(--ssh-terminal-background);
  color: var(--foreground);
  font-family: var(--terminal-font-family, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}

.json-preview-fields {
  width: 300px;
  flex: 0 0 300px;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  background: var(--background);
}

.json-preview-empty {
  padding: 12px;
  color: var(--muted-foreground);
  font-size: 11px;
  text-align: center;
}

.json-field-row {
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  padding: 4px 6px 4px 8px;
}

.json-field-row:hover {
  background: var(--accent);
}

.json-field-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.json-field-line + .json-field-line {
  margin-top: 1px;
}

.json-field-path,
.json-field-value {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-family: var(--terminal-font-family, ui-monospace, monospace);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.json-field-value {
  color: var(--muted-foreground);
}

.json-field-type {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 0 5px;
  color: var(--muted-foreground);
  font-size: 9px;
  letter-spacing: 0.02em;
}

.json-field-copy {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}

.json-field-copy:hover {
  background: var(--accent);
  color: var(--foreground);
}

.json-field-copy svg {
  width: 11px;
  height: 11px;
}
</style>
