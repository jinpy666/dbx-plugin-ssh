<script setup lang="ts">
// 会话导入向导（IMPL_PLAN P2-2 + M7 四来源）：三步流程 —— ① 来源选择
// （MobaXterm .mxtsessions / Xshell .xts / WindTerm .sessions + 可选
// user.config / SecureCRT .xml / FinalShell conn 目录打包 .zip / Electerm
// bookmarks .json / Termius 导出 .json）② 文件选择（File API 读
// ArrayBuffer → base64，WindTerm 主密码输入）③ 预览表格（勾选行 →
// import/commit，结果计数内联提示）。解析错误与「需要主密码」契约错误都
// 做了可读展示；后端 parse 已脱敏（仅 hasSecret + secretNote 原因码），
// 前端不回传任何明文凭据。纯逻辑复用 lib/otpPanel.ts 的导入解析与参数构造。
import { computed, ref } from "vue";
import { FileUp, FolderInput, Loader2, PencilLine, RotateCcw } from "@lucide/vue";
import {
  bytesToBase64,
  importBaseParams,
  importCommitParams,
  importErrorCode,
  parseImportResult,
  parseImportSessions,
  type ImportKind,
  type ImportSessionView,
} from "../lib/otpPanel";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

interface ImportSource {
  kind: ImportKind;
  labelKey: string;
  accept: string;
  /** WindTerm 需要额外的 user.config 与主密码输入。 */
  windtermExtras: boolean;
  /** 第二步展示的格式说明（如 FinalShell 需先把 conn 目录打成 zip）。 */
  hintKey?: string;
}

const SOURCES: ImportSource[] = [
  { kind: "moba", labelKey: "importWizard.source.moba", accept: ".mxtsessions", windtermExtras: false },
  { kind: "xshell", labelKey: "importWizard.source.xshell", accept: ".xts", windtermExtras: false },
  { kind: "windterm", labelKey: "importWizard.source.windterm", accept: ".sessions", windtermExtras: true },
  { kind: "securecrt", labelKey: "importWizard.source.securecrt", accept: ".xml", windtermExtras: false },
  {
    kind: "finalshell",
    labelKey: "importWizard.source.finalshell",
    accept: ".zip",
    windtermExtras: false,
    hintKey: "importWizard.source.finalshellHint",
  },
  { kind: "electerm", labelKey: "importWizard.source.electerm", accept: ".json", windtermExtras: false },
  { kind: "termius", labelKey: "importWizard.source.termius", accept: ".json", windtermExtras: false },
];

/** secretNote 原因码 → i18n 键（后端只回码，不回文案）。 */
const SECRET_NOTE_KEYS: Record<string, string> = {
  encrypted: "importWizard.note.encrypted",
  "not-carried": "importWizard.note.notCarried",
};

function secretNoteText(session: ImportSessionView): string {
  const key = SECRET_NOTE_KEYS[session.secretNote];
  return key ? props.t(key) : session.secretNote;
}

const step = ref<1 | 2 | 3>(1);
const kind = ref<ImportKind>("moba");
const fileBase64 = ref("");
const fileName = ref("");
const userConfigBase64 = ref("");
const userConfigName = ref("");
const masterPassword = ref("");
const parsing = ref(false);
const parseError = ref("");
const parseErrorCode = ref<"" | "masterPassword">("");
const sessions = ref<ImportSessionView[]>([]);
const selected = ref<Set<number>>(new Set());
const committing = ref(false);
const commitError = ref("");
const result = ref<{ imported: number; skipped: number } | null>(null);

const fileInput = ref<HTMLInputElement | null>(null);
const userConfigInput = ref<HTMLInputElement | null>(null);

const currentSource = computed(() => SOURCES.find((source) => source.kind === kind.value) ?? SOURCES[0]);
const selectedIndexes = computed(() => [...selected.value].sort((left, right) => left - right));
const allSelected = computed(() => sessions.value.length > 0 && selected.value.size === sessions.value.length);
const hasNotedSecrets = computed(() => sessions.value.some((session) => session.secretNote));

function chooseSource(source: ImportSource) {
  kind.value = source.kind;
  // 换来源即作废上一次的文件与预览，避免跨格式误导入。
  resetFileState();
  step.value = 2;
}

function resetFileState() {
  fileBase64.value = "";
  fileName.value = "";
  userConfigBase64.value = "";
  userConfigName.value = "";
  masterPassword.value = "";
  parseError.value = "";
  parseErrorCode.value = "";
  sessions.value = [];
  selected.value = new Set();
  result.value = null;
  commitError.value = "";
}

function restart() {
  resetFileState();
  kind.value = "moba";
  step.value = 1;
}

async function readAsBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  fileBase64.value = await readAsBase64(file);
  if (input === fileInput.value) input.value = "";
}

async function onUserConfigChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  userConfigName.value = file.name;
  userConfigBase64.value = await readAsBase64(file);
  input.value = "";
}

async function parse() {
  if (!fileBase64.value) return;
  parsing.value = true;
  parseError.value = "";
  parseErrorCode.value = "";
  try {
    const payload = await window.dbxPlugin.invoke("import/parse", importBaseParams(kind.value, fileBase64.value, userConfigBase64.value, masterPassword.value));
    sessions.value = parseImportSessions(payload);
    selected.value = new Set(sessions.value.map((session) => session.index));
    if (!sessions.value.length) {
      step.value = 2;
      return;
    }
    result.value = null;
    step.value = 3;
  } catch (cause) {
    parseError.value = cause instanceof Error ? cause.message : String(cause);
    parseErrorCode.value = importErrorCode(cause);
  } finally {
    parsing.value = false;
  }
}

function toggleSelected(index: number, checked: boolean) {
  const next = new Set(selected.value);
  if (checked) next.add(index);
  else next.delete(index);
  selected.value = next;
}

function toggleAll(checked: boolean) {
  selected.value = checked ? new Set(sessions.value.map((session) => session.index)) : new Set<number>();
}

async function commit() {
  if (!selectedIndexes.value.length) return;
  committing.value = true;
  commitError.value = "";
  try {
    const payload = await window.dbxPlugin.invoke("import/commit", importCommitParams(kind.value, fileBase64.value, userConfigBase64.value, masterPassword.value, selectedIndexes.value));
    result.value = parseImportResult(payload);
    // 已导入的行从预览中移除（skipped 的保留，便于排查后重试）。
    sessions.value = sessions.value.filter((session) => !selected.value.has(session.index));
    selected.value = new Set();
  } catch (cause) {
    commitError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    committing.value = false;
  }
}
</script>

<template>
  <div class="import-wizard">
    <p class="import-steps">{{ t("importWizard.step", { current: step }) }}</p>

    <template v-if="step === 1">
      <div class="import-sources">
        <button
          v-for="source in SOURCES"
          :key="source.kind"
          type="button"
          class="import-source"
          :class="{ 'is-picked': source.kind === kind }"
          @click="chooseSource(source)"
        >
          <FolderInput />
          <span>{{ t(source.labelKey) }}</span>
        </button>
      </div>
      <p class="import-hint">{{ t("importWizard.storageNote") }}</p>
    </template>

    <template v-else-if="step === 2">
      <p class="import-source-line">{{ t(currentSource.labelKey) }}</p>
      <div class="import-file-row">
        <button type="button" class="import-pick" :disabled="parsing" @click="fileInput?.click()"><FileUp />{{ t("importWizard.pickFile") }}</button>
        <span v-if="fileName" class="import-file-name" :title="fileName">{{ t("importWizard.fileChosen", { name: fileName }) }}</span>
        <input ref="fileInput" type="file" :accept="currentSource.accept" class="import-file-input" @change="onFileChange" />
      </div>
      <template v-if="currentSource.windtermExtras">
        <div class="import-file-row">
          <button type="button" class="import-pick" :disabled="parsing" @click="userConfigInput?.click()">{{ t("importWizard.userConfig") }}</button>
          <span v-if="userConfigName" class="import-file-name" :title="userConfigName">{{ t("importWizard.fileChosen", { name: userConfigName }) }}</span>
          <input ref="userConfigInput" type="file" accept="user.config" class="import-file-input" @change="onUserConfigChange" />
        </div>
        <label class="import-field">
          <span>{{ t("importWizard.masterPassword") }}</span>
          <input v-model="masterPassword" type="password" autocomplete="off" :placeholder="t('importWizard.masterPasswordHint')" />
        </label>
        <p class="import-hint">{{ t("importWizard.source.windtermHint") }}</p>
      </template>
      <p v-if="currentSource.hintKey" class="import-hint">{{ t(currentSource.hintKey) }}</p>
      <p v-if="parseErrorCode === 'masterPassword'" class="import-error">{{ t("importWizard.needMasterPassword") }}</p>
      <p v-else-if="parseError" class="import-error">{{ t("importWizard.parseFailed", { error: parseError }) }}</p>
      <p v-if="!sessions.length" class="import-hint">{{ t("importWizard.parseHint") }}</p>
      <div class="import-nav">
        <button type="button" class="import-back" @click="step = 1">{{ t("importWizard.back") }}</button>
        <button type="button" class="primary-button" :disabled="!fileBase64 || parsing" @click="() => void parse()">
          <Loader2 v-if="parsing" class="spinning" /><PencilLine v-else />{{ t("importWizard.parse") }}
        </button>
      </div>
    </template>

    <template v-else>
      <div v-if="result" class="import-result">
        <p>{{ t("importWizard.result", { imported: result.imported, skipped: result.skipped }) }}</p>
        <p class="import-result-note">{{ t("importWizard.storageNote") }}</p>
      </div>
      <p v-if="commitError" class="import-error">{{ t("importWizard.commitFailed", { error: commitError }) }}</p>

      <div v-if="sessions.length" class="import-table-wrap">
        <p v-if="hasNotedSecrets" class="import-hint">{{ t("importWizard.notesBanner") }}</p>
        <div class="import-table-tools">
          <label class="import-select-all">
            <input type="checkbox" :checked="allSelected" @change="toggleAll(($event.target as HTMLInputElement).checked)" />
            {{ allSelected ? t("importWizard.selectNone") : t("importWizard.selectAll") }}
          </label>
          <span class="import-selected-count">{{ t("importWizard.selectedCount", { count: selected.size }) }}</span>
        </div>
        <table class="import-table">
          <thead>
            <tr>
              <th class="import-col-check" />
              <th>{{ t("importWizard.col.name") }}</th>
              <th>{{ t("importWizard.col.host") }}</th>
              <th>{{ t("importWizard.col.user") }}</th>
              <th>{{ t("importWizard.col.group") }}</th>
              <th>{{ t("importWizard.col.auth") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sessions" :key="session.index">
              <td class="import-col-check">
                <input
                  type="checkbox"
                  :checked="selected.has(session.index)"
                  :aria-label="session.name"
                  @change="toggleSelected(session.index, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="import-col-name" :title="session.description || session.name">{{ session.name }}</td>
              <td class="import-col-host">{{ session.host }}<template v-if="session.port">:{{ session.port }}</template></td>
              <td>{{ session.username }}</td>
              <td class="import-col-group" :title="session.groupPath">{{ session.groupPath }}</td>
              <td>
                <span class="import-auth" :title="session.hasSecret ? t('importWizard.hasSecret') : ''">{{ session.authKind || "—" }}</span>
                <span
                  v-if="session.secretNote"
                  class="import-secret-flag"
                  :title="secretNoteText(session)"
                >•</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="import-hint">{{ t("importWizard.empty") }}</p>

      <div class="import-nav">
        <button type="button" class="import-back" @click="step = 2">{{ t("importWizard.back") }}</button>
        <button type="button" class="primary-button" :disabled="committing || !selected.size" @click="() => void commit()">
          <Loader2 v-if="committing" class="spinning" /><FolderInput v-else />{{ t("importWizard.commit") }}
        </button>
        <button type="button" class="import-back" @click="restart"><RotateCcw />{{ t("importWizard.restart") }}</button>
      </div>
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
