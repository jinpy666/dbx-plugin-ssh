<script setup lang="ts">
// 快速命令管理节（M32-A3）：编辑器 + 批量导入两个子视图从工具条弹层迁入
// 设置·终端。纯管理视图：草稿/导入预览在组件内，数据面
// （ssh/quickCommands/* RPC）留在 App——save/import 落库后 App 会整体替换
// commands 数组，组件据此收口子视图。
import { computed, reactive, ref, watch } from "vue";
import { ArrowLeft, FileUp, Pencil, Trash2 } from "@lucide/vue";
import { QUICK_COMMAND_NAME_MAX_LENGTH, QUICK_COMMAND_TEXT_MAX_LENGTH, type QuickCommand } from "../lib/quickCommands";
import { mergeQuickCommandImport, parseQuickCommandImport } from "../lib/quickCommandImport";

const props = defineProps<{
  commands: QuickCommand[];
  /** 单条 save 的 RPC 在途态（App 侧）。 */
  saving: boolean;
  /** 批量导入循环 save 的在途态（App 侧）。 */
  importing: boolean;
  limit: number;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  (e: "save", command: { id?: string; name: string; command: string }): void;
  (e: "delete", id: string): void;
  (e: "import", items: Array<{ name: string; command: string }>): void;
  (e: "error", cause: unknown): void;
}>();

const t = props.t;

// —— 编辑器子视图 ——
const editorOpen = ref(false);
const draft = reactive<{ id?: string; name: string; command: string }>({ name: "", command: "" });

// —— 导入子视图 ——
const importOpen = ref(false);
const importText = ref("");
const importFileName = ref("");
const importPlan = computed(() => parseQuickCommandImport(importText.value));
const importMerge = computed(() => mergeQuickCommandImport(props.commands, importPlan.value));

// 数据面在 App：RPC 成功后 commands 数组被整体替换（引用变化），据此感知
// "本次保存/导入已落库" 再复位子视图；失败时引用不变，草稿/预览保留可继续改。
let awaitingSaveResult = false;
let awaitingImportResult = false;
watch(() => props.commands, () => {
  if (awaitingSaveResult) {
    awaitingSaveResult = false;
    closeEditor();
  }
  if (awaitingImportResult) {
    awaitingImportResult = false;
    closeImport();
  }
});

function openEditor(item?: QuickCommand) {
  draft.id = item?.id;
  draft.name = item?.name ?? "";
  draft.command = item?.command ?? "";
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
  draft.id = undefined;
  draft.name = "";
  draft.command = "";
}

function openImport() {
  importText.value = "";
  importFileName.value = "";
  importOpen.value = true;
}

function closeImport() {
  importOpen.value = false;
  importText.value = "";
  importFileName.value = "";
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    importText.value = await file.text();
    importFileName.value = file.name;
  } catch (cause) {
    emit("error", cause);
  }
}

function saveCommand() {
  const command = draft.command.trim();
  if (!command || props.saving) return;
  if (!draft.id && props.commands.length >= props.limit) return;
  awaitingSaveResult = true;
  emit("save", { id: draft.id, name: draft.name.trim(), command });
}

/** 删除是不可逆操作：先确认（与既有工具条删除同一 confirm 语义）。 */
function deleteCommand(id: string) {
  const target = props.commands.find((item) => item.id === id);
  if (target && !window.confirm(t("quickCommandDeleteConfirm", { name: target.name || target.command }))) return;
  emit("delete", id);
}

/** 确认导入：上抛预览 accepted 条目，逐条 save 循环由 App 执行（沿用后端上限校验）。 */
function confirmImport() {
  const merge = importMerge.value;
  if (!merge.accepted.length || props.importing) return;
  awaitingImportResult = true;
  emit("import", merge.accepted);
}
</script>

<template>
  <div class="quick-commands-section">
    <template v-if="importOpen">
      <header class="quick-editor-head">
        <button class="icon-button compact" :title="t('cancel')" @click="closeImport"><ArrowLeft /></button>
        <h3>{{ t("quickCommandsImport") }}</h3>
      </header>
      <div class="quick-command-editor">
        <label class="quick-import-file">
          <FileUp />
          <span>{{ importFileName || t("quickCommandsImportFile") }}</span>
          <input type="file" accept=".json,application/json,text/plain" @change="onImportFile" />
        </label>
        <textarea v-model="importText" class="mono" rows="6" :placeholder="t('quickCommandsImportPlaceholder')" spellcheck="false" />
        <p v-if="importText.trim()" class="muted quick-import-summary">
          <template v-if="importPlan.invalid < 0">{{ t("quickCommandsImportInvalid") }}</template>
          <template v-else>{{ t("quickCommandsImportSummary", { accepted: importMerge.accepted.length, skipped: importMerge.skippedExisting, dup: importPlan.duplicates, invalid: importPlan.invalid, overflow: importMerge.overflow }) }}</template>
        </p>
        <div class="quick-command-editor-actions">
          <button class="primary-button" :disabled="importing || !importMerge.accepted.length" @click="confirmImport">{{ t("quickCommandsImportConfirm", { count: importMerge.accepted.length }) }}</button>
          <button @click="closeImport">{{ t("cancel") }}</button>
        </div>
        <p class="muted quick-import-note">{{ t("quickCommandsImportPolicy") }}</p>
      </div>
    </template>
    <template v-else-if="editorOpen">
      <header class="quick-editor-head">
        <button class="icon-button compact" :title="t('cancel')" @click="closeEditor"><ArrowLeft /></button>
        <h3>{{ draft.id ? t("quickCommandsEdit") : t("quickCommandsNew") }}</h3>
      </header>
      <footer class="quick-command-editor">
        <input v-model="draft.name" :placeholder="t('quickCommandsName')" :maxlength="QUICK_COMMAND_NAME_MAX_LENGTH" autofocus />
        <textarea v-model="draft.command" class="mono" rows="4" :placeholder="t('quickCommandsCommand')" :maxlength="QUICK_COMMAND_TEXT_MAX_LENGTH" @keydown.ctrl.enter="saveCommand" />
        <div class="quick-command-editor-actions">
          <button class="primary-button" :disabled="saving || !draft.command.trim() || (!draft.id && commands.length >= limit)" @click="saveCommand">{{ draft.id ? t("save") : t("quickCommandsAdd") }}</button>
          <button @click="closeEditor">{{ t("cancel") }}</button>
          <span class="quick-command-limit">{{ t("quickCommandsLimit", { count: commands.length, limit }) }}</span>
        </div>
      </footer>
    </template>
    <template v-else>
      <ul v-if="commands.length" class="settings-list quick-manage-list">
        <li v-for="item in commands" :key="item.id">
          <span class="quick-manage-main">
            <strong>{{ item.name }}</strong>
            <span class="mono" :title="item.command">{{ item.command }}</span>
          </span>
          <span class="settings-list-actions">
            <button class="icon-button" :title="t('quickCommandsEdit')" @click="openEditor(item)"><Pencil /></button>
            <button class="icon-button" :title="t('delete')" @click="deleteCommand(item.id)"><Trash2 /></button>
          </span>
        </li>
      </ul>
      <p v-else class="muted settings-note">{{ t("quickCommandsEmpty") }}</p>
      <p class="muted settings-note">{{ t("quickCommandsLimit", { count: commands.length, limit }) }}</p>
      <footer class="quick-manage-actions">
        <button class="link-button" type="button" :disabled="commands.length >= limit" @click="openEditor()">{{ t("quickCommandsNew") }}</button>
        <button class="link-button" type="button" :disabled="commands.length >= limit" @click="openImport()">{{ t("quickCommandsImport") }}</button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
/* 设置页管理视图：简单两行卡片（名称 + 命令）+ 行内编辑/删除，样式对齐
   startup-commands-list 的 settings-list 行为。 */
.quick-manage-list { max-height: min(320px, calc(100vh - 380px)); overflow-y: auto; }
.quick-manage-main { display: flex; min-width: 0; flex: 1 1 auto; flex-direction: column; gap: 1px; }
.quick-manage-main strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.quick-manage-main .mono { overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.quick-manage-actions { display: flex; align-items: center; gap: 16px; }
/* 迁入自 App.vue 弹层（编辑器/导入子视图原样式，见 App.vue <style scoped> 历史）。 */
.quick-editor-head { display: flex; align-items: center; gap: 6px; }
.quick-editor-head h3 { flex: 1; margin: 0; }
.quick-command-editor { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.quick-command-editor input { width: 100%; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.quick-command-editor textarea { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; background: var(--background); color: var(--foreground); font-size: 12px; line-height: 1.5; }
.quick-command-editor input:focus, .quick-command-editor textarea:focus { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); outline: none; }
.quick-command-editor-actions { display: flex; align-items: center; gap: 6px; }
.quick-command-editor-actions .quick-command-limit { flex: 1; overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.quick-import-file { display: flex; align-items: center; gap: 6px; height: 26px; border: 1px dashed var(--border); border-radius: var(--radius); padding: 0 8px; font-size: 11px; color: var(--muted-foreground); cursor: pointer; }
.quick-import-file:hover { border-color: color-mix(in srgb, var(--primary) 60%, var(--border)); background: var(--accent); }
.quick-import-file svg { width: 13px; height: 13px; flex: none; }
.quick-import-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quick-import-file input[type="file"] { display: none; }
.quick-import-summary { margin: 0; font-size: 10px; line-height: 1.5; }
.quick-import-note { margin: 0; font-size: 10px; line-height: 1.5; }
</style>
