<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
// 语法高亮调色板来自 shared 公共层（唯一实现点），暗色为提亮后的 GitHub Dark 系。
import { dbxSyntaxHighlight } from "../../../shared/frontend/editorTheme";

const props = defineProps<{
  text: string;
  fileName: string;
  appearance: DbxPluginAppearance;
  editable?: boolean;
}>();

const emit = defineEmits<{
  change: [text: string];
}>();

const host = ref<HTMLElement>();
let view: EditorView | undefined;
let generation = 0;

function previewTheme() {
  const colors = props.appearance.colors;
  return EditorView.theme({
    "&": { height: "100%", backgroundColor: colors.background, color: colors.foreground },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: props.appearance.terminal.fontFamily,
      fontSize: `${props.appearance.terminal.fontSize}px`,
    },
    ".cm-gutters": { backgroundColor: colors.muted, color: colors.mutedForeground, borderRightColor: colors.border },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: colors.accent },
    // 选区色随明暗切换，与终端 xterm selectionBackground 保持同一观感。
    // 透明度 0x88 的旧值在亮色白底上混合后对比度仅 ~1.2:1（issue #155：
    // 选区与背景几乎一样），提高到 0xad 并加深色相，选中区域清晰可辨。
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: props.appearance.colorScheme === "dark" ? "#6481b8ad" : "#7cabecad",
    },
  }, { dark: props.appearance.colorScheme === "dark" });
}

async function extensions() {
  const language = LanguageDescription.matchFilename(languages, props.fileName);
  const support = language ? await language.load().catch(() => undefined) : undefined;
  return [
    basicSetup,
    // basicSetup 内置 defaultHighlightStyle 是浅底配色，暗色下发暗；此处按宿主
    // 明暗注入 shared 调色板高亮（后声明者优先，内置样式退为 fallback），
    // appearance 变化重建编辑器时随 colorScheme 自然跟随。
    dbxSyntaxHighlight(props.appearance.colorScheme, { HighlightStyle, syntaxHighlighting, tags }) as Extension,
    EditorState.readOnly.of(!props.editable),
    EditorView.editable.of(props.editable === true),
    EditorView.lineWrapping,
    previewTheme(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) emit("change", update.state.doc.toString());
    }),
    ...(support ? [support] : []),
  ];
}

async function createEditor() {
  const current = ++generation;
  const configured = await extensions();
  if (!host.value || current !== generation) return;
  // Seed the new editor with the live document so edits survive theme or
  // editable-mode re-creations; fall back to the incoming text on first mount.
  const doc = view?.state.doc.toString() ?? props.text;
  view?.destroy();
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({ doc, extensions: configured }),
  });
}

onMounted(createEditor);
watch(() => [props.fileName, props.appearance, props.editable] as const, createEditor, { deep: true });
watch(() => props.text, (text) => {
  if (!view || text === view.state.doc.toString()) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
});
onBeforeUnmount(() => {
  generation += 1;
  view?.destroy();
});
</script>

<template>
  <div ref="host" class="preview-editor" />
</template>
