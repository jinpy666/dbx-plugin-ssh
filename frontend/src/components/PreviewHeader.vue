<script setup lang="ts">
// 预览弹窗头部（从 PreviewPane 抽出）：文件图标/标题/大小、Markdown 渲染/源码
// 切换、编辑入口、打开方式、下载、最大化与关闭。纯呈现：所有动作以事件上抛，
// 会话级状态（md 视图记忆、加载/编辑）仍由 PreviewPane 持有。
import { Download, Maximize2, Minimize2, Pencil, X } from "@lucide/vue";
import { fileIcon, fileIconClass } from "../lib/fileIcons";
import type { EditorConfig, KnownEditor, ResolvedEditor } from "../lib/editorRules";
import FileOpenWithMenu from "./FileOpenWithMenu.vue";

const props = withDefaults(defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  title: string;
  path: string;
  /** 大小文案；空串表示当前形态不显示（加载中/图片/外置查看器）。 */
  meta: string;
  showMdToggle: boolean;
  mdView: "render" | "source";
  mdRenderLabel: string;
  mdSourceLabel: string;
  canEdit: boolean;
  saving: boolean;
  editors?: KnownEditor[];
  editorConfig?: EditorConfig;
  canOpen: boolean;
  disabledHint?: string;
  maximized: boolean;
}>(), {
  editors: () => [],
  editorConfig: () => ({ associations: [], customEditors: [], uploadPolicy: "auto" }),
  disabledHint: undefined,
});

const emit = defineEmits<{
  close: [];
  download: [];
  edit: [];
  "set-md-view": [view: "render" | "source"];
  "open-with": [editor: ResolvedEditor];
  "custom-command": [];
  "request-editors": [];
  "toggle-maximize": [];
}>();
</script>

<template>
  <div class="ssh-preview-header">
    <component :is="fileIcon(props.title)" :class="fileIconClass(props.title)" class="ssh-preview-fileicon" aria-hidden="true" />
    <strong :title="props.path">{{ props.title }}</strong>
    <span class="ssh-preview-meta">{{ props.meta }}</span>
    <!-- Markdown 渲染/源码切换（仅 md 文本态出现；i18n key 缺失用兜底文案）。 -->
    <span v-if="props.showMdToggle" class="ssh-preview-md-toggle" data-test="md-toggle">
      <button
        type="button"
        class="ssh-preview-chip"
        :class="{ 'ssh-preview-chip-active': props.mdView === 'render' }"
        data-test="md-render"
        :aria-pressed="props.mdView === 'render'"
        @click="emit('set-md-view', 'render')"
      >{{ props.mdRenderLabel }}</button>
      <button
        type="button"
        class="ssh-preview-chip"
        :class="{ 'ssh-preview-chip-active': props.mdView === 'source' }"
        data-test="md-source"
        :aria-pressed="props.mdView === 'source'"
        @click="emit('set-md-view', 'source')"
      >{{ props.mdSourceLabel }}</button>
    </span>
    <button v-if="props.canEdit && !props.saving" type="button" class="ssh-preview-action" data-test="preview-edit" :title="props.t('editSave.edit')" @click="emit('edit')"><Pencil />{{ props.t("editSave.edit") }}</button>
    <FileOpenWithMenu
      :file-name="props.title"
      :editors="props.editors"
      :editor-config="props.editorConfig"
      :can-open="props.canOpen"
      :disabled-hint="props.disabledHint"
      :t="props.t"
      @open="(editor: ResolvedEditor) => emit('open-with', editor)"
      @custom-command="emit('custom-command')"
      @request-editors="emit('request-editors')"
    />
    <button type="button" class="ssh-preview-action" :title="props.t('previewDialog.download')" :aria-label="props.t('previewDialog.download')" @click="emit('download')"><Download /></button>
    <button
      type="button"
      class="ssh-preview-action"
      data-test="preview-maximize"
      :title="props.t(props.maximized ? 'previewDialog.restore' : 'previewDialog.maximize')"
      :aria-label="props.t(props.maximized ? 'previewDialog.restore' : 'previewDialog.maximize')"
      @click="emit('toggle-maximize')"
    ><Minimize2 v-if="props.maximized" /><Maximize2 v-else /></button>
    <button type="button" class="ssh-preview-action ssh-preview-close" :title="props.t('close')" :aria-label="props.t('close')" @click="emit('close')"><X /></button>
  </div>
</template>
