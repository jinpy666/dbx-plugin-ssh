<script setup lang="ts">
// 会话导入不再写入插件私有连接库。主文件和可选 WindTerm user.config 以
// SFTP 同款 start + 二进制 offset 分块 + ACK 流上传；finish 仅返回脱敏预览
// 与可下载的规范化元数据导出，密码、私钥内容和口令永不离开 sidecar。
import { computed, onBeforeUnmount, ref } from "vue";
import { Download, FileUp, FolderInput, Loader2, PencilLine, RotateCcw } from "@lucide/vue";
import {
  IMPORT_CHUNK_LIMIT,
  importErrorCode,
  importPreviewChunk,
  importPreviewStartParams,
  parseImportSessions,
  type ImportKind,
  type ImportSessionView,
} from "../lib/otpPanel";
import { exportSanitizedJson } from "../lib/sanitizedDownload";

const props = defineProps<{ t: (key: string, values?: Record<string, string | number>) => string }>();
interface ImportSource { kind: ImportKind; labelKey: string; accept: string; windtermExtras: boolean; hintKey?: string }
const SOURCES: ImportSource[] = [
  { kind: "moba", labelKey: "importWizard.source.moba", accept: ".mxtsessions", windtermExtras: false },
  { kind: "xshell", labelKey: "importWizard.source.xshell", accept: ".xts", windtermExtras: false },
  { kind: "windterm", labelKey: "importWizard.source.windterm", accept: ".sessions", windtermExtras: true },
  { kind: "securecrt", labelKey: "importWizard.source.securecrt", accept: ".xml", windtermExtras: false },
  { kind: "finalshell", labelKey: "importWizard.source.finalshell", accept: ".zip", windtermExtras: false, hintKey: "importWizard.source.finalshellHint" },
  { kind: "electerm", labelKey: "importWizard.source.electerm", accept: ".json", windtermExtras: false },
  { kind: "termius", labelKey: "importWizard.source.termius", accept: ".json", windtermExtras: false },
];
const SECRET_NOTE_KEYS: Record<string, string> = { encrypted: "importWizard.note.encrypted", "not-carried": "importWizard.note.notCarried" };
const step = ref<1 | 2 | 3>(1);
const kind = ref<ImportKind>("moba");
const mainFile = ref<File | null>(null);
const userConfigFile = ref<File | null>(null);
const masterPassword = ref("");
const parsing = ref(false);
const parseError = ref("");
const parseErrorCode = ref<"" | "masterPassword" | "sizeLimit">("");
const sessions = ref<ImportSessionView[]>([]);
const normalizedExport = ref<unknown>(null);
const exporting = ref(false);
const exportError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const userConfigInput = ref<HTMLInputElement | null>(null);
const activeUploads = new Set<string>();
const currentSource = computed(() => SOURCES.find((source) => source.kind === kind.value) ?? SOURCES[0]);
const hasNotedSecrets = computed(() => sessions.value.some((session) => session.secretNote));
function secretNoteText(session: ImportSessionView): string { return SECRET_NOTE_KEYS[session.secretNote] ? props.t(SECRET_NOTE_KEYS[session.secretNote]) : session.secretNote; }
function chooseSource(source: ImportSource) { kind.value = source.kind; resetFileState(); step.value = 2; }
function resetFileState() { mainFile.value = null; userConfigFile.value = null; masterPassword.value = ""; parsing.value = false; parseError.value = ""; parseErrorCode.value = ""; sessions.value = []; normalizedExport.value = null; exportError.value = ""; }
function restart() { resetFileState(); kind.value = "moba"; step.value = 1; }
function onFileChange(event: Event) { const input = event.target as HTMLInputElement; mainFile.value = input.files?.[0] ?? null; input.value = ""; }
function onUserConfigChange(event: Event) { const input = event.target as HTMLInputElement; userConfigFile.value = input.files?.[0] ?? null; input.value = ""; }
function importAck(taskId: string, part: string, nextOffset: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { unsubscribe(); reject(new Error("import preview acknowledgment timed out")); }, 30_000);
    const unsubscribe = window.dbxPlugin.onEvent((event) => {
      if (event.method === "import/preview/ack" && event.params.taskId === taskId && event.params.part === part && event.params.nextOffset === nextOffset) { window.clearTimeout(timeout); unsubscribe(); resolve(); }
      if (event.method === "import/preview/error" && event.params.taskId === taskId && event.params.part === part) { window.clearTimeout(timeout); unsubscribe(); reject(new Error(String(event.params.error ?? "import preview failed"))); }
    });
  });
}
async function streamFile(taskId: string, part: "main" | "user-config", file: File) {
  for (let offset = 0; offset < file.size;) {
    const bytes = new Uint8Array(await file.slice(offset, offset + IMPORT_CHUNK_LIMIT).arrayBuffer());
    if (!bytes.byteLength) throw new Error("import file changed while reading");
    const nextOffset = offset + bytes.byteLength;
    const ack = importAck(taskId, part, nextOffset);
    try {
      await window.dbxPlugin.sendBinary(`import/preview/${taskId}/${part}`, importPreviewChunk(offset, bytes));
      await ack;
    } catch (cause) {
      // A rejected binary send would otherwise leave the ACK listener pending.
      await window.dbxPlugin.invoke("import/preview/cancel", { taskId }).catch(() => undefined);
      throw cause;
    }
    offset = nextOffset;
  }
}
async function cancelActiveUploads() {
  const taskIds = [...activeUploads];
  activeUploads.clear();
  await Promise.all(taskIds.map((taskId) => window.dbxPlugin.invoke("import/preview/cancel", { taskId }).catch(() => undefined)));
}

onBeforeUnmount(() => { void cancelActiveUploads(); });

async function parse() {
  const file = mainFile.value;
  if (!file) return;
  parsing.value = true; parseError.value = ""; parseErrorCode.value = ""; exportError.value = "";
  let taskId = "";
  try {
    const started = await window.dbxPlugin.invoke<{ taskId: string }>("import/preview/start", importPreviewStartParams(kind.value, file.size, userConfigFile.value?.size ?? 0, masterPassword.value));
    taskId = started.taskId;
    activeUploads.add(taskId);
    await streamFile(taskId, "main", file);
    if (userConfigFile.value) await streamFile(taskId, "user-config", userConfigFile.value);
    const payload = await window.dbxPlugin.invoke<{ sessions?: unknown; export?: unknown }>("import/preview/finish", { taskId });
    sessions.value = parseImportSessions(payload);
    normalizedExport.value = payload.export ?? null;
    step.value = 3;
  } catch (cause) {
    parseError.value = cause instanceof Error ? cause.message : String(cause); parseErrorCode.value = importErrorCode(cause);
    if (taskId) await window.dbxPlugin.invoke("import/preview/cancel", { taskId }).catch(() => undefined);
  } finally {
    if (taskId) activeUploads.delete(taskId);
    parsing.value = false;
    masterPassword.value = "";
  }
}
async function exportPreview() {
  if (!normalizedExport.value) return;
  exporting.value = true; exportError.value = "";
  try {
    const bytes = new TextEncoder().encode(`${JSON.stringify(normalizedExport.value, null, 2)}\n`);
    const name = `${kind.value}-sessions-sanitized.json`;
    await exportSanitizedJson(bytes, name);
  } catch (cause) { exportError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { exporting.value = false; }
}
</script>

<template>
  <div class="import-wizard">
    <p class="import-steps">{{ t("importWizard.step", { current: step }) }}</p>
    <template v-if="step === 1">
      <div class="import-sources"><button v-for="source in SOURCES" :key="source.kind" type="button" class="import-source" :class="{ 'is-picked': source.kind === kind }" @click="chooseSource(source)"><FolderInput /><span>{{ t(source.labelKey) }}</span></button></div>
      <p class="import-hint">{{ t("importWizard.storageNote") }}</p>
    </template>
    <template v-else-if="step === 2">
      <p class="import-source-line">{{ t(currentSource.labelKey) }}</p>
      <div class="import-file-row"><button type="button" class="import-pick" :disabled="parsing" @click="fileInput?.click()"><FileUp />{{ t("importWizard.pickFile") }}</button><span v-if="mainFile" class="import-file-name" :title="mainFile.name">{{ t("importWizard.fileChosen", { name: mainFile.name }) }}</span><input ref="fileInput" type="file" :accept="currentSource.accept" class="import-file-input" @change="onFileChange" /></div>
      <template v-if="currentSource.windtermExtras"><div class="import-file-row"><button type="button" class="import-pick" :disabled="parsing" @click="userConfigInput?.click()">{{ t("importWizard.userConfig") }}</button><span v-if="userConfigFile" class="import-file-name" :title="userConfigFile.name">{{ t("importWizard.fileChosen", { name: userConfigFile.name }) }}</span><input ref="userConfigInput" type="file" accept="user.config" class="import-file-input" @change="onUserConfigChange" /></div><label class="import-field"><span>{{ t("importWizard.masterPassword") }}</span><input v-model="masterPassword" type="password" autocomplete="off" :placeholder="t('importWizard.masterPasswordHint')" /></label><p class="import-hint">{{ t("importWizard.source.windtermHint") }}</p></template>
      <p v-if="currentSource.hintKey" class="import-hint">{{ t(currentSource.hintKey) }}</p><p v-if="parseErrorCode === 'masterPassword'" class="import-error">{{ t("importWizard.needMasterPassword") }}</p><p v-else-if="parseErrorCode === 'sizeLimit'" class="import-error">{{ t("importWizard.sizeLimit") }}</p><p v-else-if="parseError" class="import-error">{{ t("importWizard.parseFailed", { error: parseError }) }}</p><p v-if="!mainFile" class="import-hint">{{ t("importWizard.parseHint") }}</p>
      <div class="import-nav"><button type="button" class="import-back" @click="step = 1">{{ t("importWizard.back") }}</button><button type="button" class="primary-button" :disabled="!mainFile || parsing" @click="() => void parse()"><Loader2 v-if="parsing" class="spinning" /><PencilLine v-else />{{ t("importWizard.parse") }}</button></div>
    </template>
    <template v-else>
      <div v-if="sessions.length" class="import-table-wrap"><p v-if="hasNotedSecrets" class="import-hint">{{ t("importWizard.notesBanner") }}</p><table class="import-table"><thead><tr><th>{{ t("importWizard.col.name") }}</th><th>{{ t("importWizard.col.host") }}</th><th>{{ t("importWizard.col.user") }}</th><th>{{ t("importWizard.col.group") }}</th><th>{{ t("importWizard.col.auth") }}</th></tr></thead><tbody><tr v-for="session in sessions" :key="session.index"><td class="import-col-name" :title="session.description || session.name">{{ session.name }}</td><td class="import-col-host">{{ session.host }}<template v-if="session.port">:{{ session.port }}</template></td><td>{{ session.username }}</td><td class="import-col-group" :title="session.groupPath">{{ session.groupPath }}</td><td><span class="import-auth" :title="session.hasSecret ? t('importWizard.hasSecret') : ''">{{ session.authKind || "—" }}</span><span v-if="session.secretNote" class="import-secret-flag" :title="secretNoteText(session)">•</span></td></tr></tbody></table></div>
      <p v-else class="import-hint">{{ t("importWizard.empty") }}</p><p v-if="exportError" class="import-error">{{ t("importWizard.exportFailed", { error: exportError }) }}</p><div class="import-nav"><button type="button" class="import-back" @click="step = 2">{{ t("importWizard.back") }}</button><button type="button" class="primary-button" :disabled="exporting || !normalizedExport" @click="() => void exportPreview()"><Loader2 v-if="exporting" class="spinning" /><Download v-else />{{ t("importWizard.export") }}</button><button type="button" class="import-back" @click="restart"><RotateCcw />{{ t("importWizard.restart") }}</button></div>
    </template>
  </div>
</template>

<style scoped>
.import-wizard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
}
.import-steps {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 11px;
}
.import-sources {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.import-source {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.import-source:hover { background: var(--accent); }
.import-source.is-picked {
  border-color: var(--primary);
  color: var(--primary);
}
.import-source svg { width: 15px; height: 15px; flex: 0 0 auto; }
.import-hint {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 11px;
}
.import-source-line {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.import-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.import-pick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 3px 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.import-pick:hover:not(:disabled) { background: var(--accent); }
.import-pick svg { width: 13px; height: 13px; }
.import-file-input { display: none; }
.import-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--muted-foreground);
}
.import-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.import-field input {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
}
.import-error {
  margin: 0;
  border: 1px solid color-mix(in srgb, var(--destructive) 60%, var(--border));
  border-radius: var(--radius);
  padding: 4px 8px;
  background: color-mix(in srgb, var(--destructive) 16%, var(--popover));
  color: color-mix(in srgb, var(--destructive) 45%, var(--foreground));
  font-size: 11px;
  word-break: break-word;
}
.import-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.import-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 10px;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.import-back:hover { background: var(--accent); }
.import-back svg { width: 13px; height: 13px; }
.import-result {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px;
  font-size: 12px;
}
.import-result p { margin: 0; }
.import-result-note {
  margin-top: 4px !important;
  color: var(--muted-foreground);
  font-size: 11px;
}
.import-table-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.import-select-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  cursor: pointer;
}
.import-selected-count {
  color: var(--muted-foreground);
  font-size: 11px;
}
.import-table-wrap { min-width: 0; }
.import-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.import-table th, .import-table td {
  border-bottom: 1px solid var(--border);
  padding: 3px 4px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 110px;
}
.import-col-check { width: 20px; }
.import-col-name { font-weight: 600; }
.import-col-group, .import-col-host { color: var(--muted-foreground); }
.import-auth {
  border-radius: 999px;
  padding: 0 5px;
  background: var(--accent);
  color: var(--muted-foreground);
}
.import-secret-flag {
  color: var(--muted-foreground);
  font-weight: 700;
  cursor: help;
}
</style>
