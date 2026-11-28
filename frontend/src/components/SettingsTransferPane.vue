<script setup lang="ts">
// 传输分类面板（自 SettingsDialog 外抽）：下载设置、上传并发/重复目标策略、
// 文件浏览双击行为、外部编辑器配置（关联/默认/回传策略）、传输管线（会话
// 并发深度/兼容模式/文件名编码/限速）、压缩传输。草稿态与编辑器目录探测在
// 本组件内自治，随主「保存」经 save() 交给读写适配器落库（权威态在 App）；
// 每次打开设置时父层经 reload() 重读。sftpCompatMode 等适配器形状与父层
// props 逐字一致（结构化传递，权威定义仍在 SettingsDialog 的 props 契约）。
import { computed, onMounted, ref } from "vue";
import { FolderOpen, Plus, Trash2 } from "@lucide/vue";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { DOWNLOAD_CONFLICT_POLICIES, type DownloadConflictPolicy } from "../lib/downloadPrefs";
import { TRANSFER_DUPLICATE_POLICIES, type TransferDuplicatePolicy } from "../lib/transferQueue";
import { SFTP_NAME_ENCODINGS, type SftpNameEncoding } from "../lib/sftpName";
import { SFTP_DOUBLE_CLICK_ACTIONS, type SftpDoubleClickAction } from "../lib/settingsModel";
import type { EditorAssociation, EditorConfig, KnownEditor } from "../lib/editorRules";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  downloadPrefs: {
    loadDir(): string;
    loadUseDefault(): boolean;
    loadConflict(): DownloadConflictPolicy;
    persistDir(value: string): void;
    persistUseDefault(value: boolean): void;
    persistConflict(value: DownloadConflictPolicy): void;
  };
  transferPrefs: {
    loadConcurrency(): number;
    loadDuplicatePolicy(): TransferDuplicatePolicy;
    persistConcurrency(value: number): void;
    persistDuplicatePolicy(value: TransferDuplicatePolicy): void;
    loadMaxActive(): number;
    loadCompatMode(): boolean;
    loadNameEncoding(): SftpNameEncoding;
    persistMaxActive(value: number): void;
    persistCompatMode(value: boolean): void;
    persistNameEncoding(value: SftpNameEncoding): void;
    loadDownloadLimit(): number;
    persistDownloadLimit(value: number): void;
    loadCompressMode(): string;
    loadCompressThreshold(): number;
    persistCompressMode(value: string): void;
    persistCompressThreshold(value: number): void;
    loadDoubleClickAction(): SftpDoubleClickAction;
    persistDoubleClickAction(value: SftpDoubleClickAction): void;
  };
  editorPrefs: {
    loadConfig(): EditorConfig;
    persistConfig(value: EditorConfig): void;
    reloadEditors(): Promise<KnownEditor[]>;
  };
  /** 本机落盘能力（web/docker 形态下浏览按钮不可用）。 */
  localCanSave: boolean;
  localDownloadDir: string;
}>();

const emit = defineEmits<{
  (event: "browse-download-dir"): void;
}>();

const downloadDirDraft = ref("");
const downloadUseDefaultDraft = ref(props.downloadPrefs.loadUseDefault());
const downloadConflictDraft = ref<DownloadConflictPolicy>("rename");
// 上传并发（1..10，默认 3）与重复目标策略（P1-5）草稿。
const transferConcurrencyDraft = ref(String(props.transferPrefs.loadConcurrency()));
const transferDuplicateDraft = ref<TransferDuplicatePolicy>(props.transferPrefs.loadDuplicatePolicy());
// M14-B：会话并发深度（1-8）/ 兼容模式 / 文件名编码草稿。
const transferMaxActiveDraft = ref(String(props.transferPrefs.loadMaxActive()));
const transferDownloadLimitDraft = ref(String(props.transferPrefs.loadDownloadLimit()));
const sftpCompatModeDraft = ref(props.transferPrefs.loadCompatMode());
const sftpNameEncodingDraft = ref<SftpNameEncoding>(props.transferPrefs.loadNameEncoding());
// 文件浏览（双击文件行为）：preview=预览（默认）/ edit=直接编辑；主保存写穿。
const sftpDoubleClickDraft = ref<SftpDoubleClickAction>(props.transferPrefs.loadDoubleClickAction());
// 外部编辑器草稿：配置整体草稿化、随主「保存」落库；known 目录
// （local/editors/list 探测）每次打开设置时重探。
const editorConfigDraft = ref<EditorConfig>({ associations: [], customEditors: [], uploadPolicy: "auto" });
const editorKnownEditors = ref<KnownEditor[]>([]);
const editorAssociationPatternDraft = ref("");
const editorAssociationTargetDraft = ref("");
const editorDefaultDraft = ref("");
const editorTargetOptions = computed(() => [
  ...editorKnownEditors.value.filter((editor) => editor.available).map((editor) => ({ value: `known:${editor.id}`, label: editor.name })),
  ...editorConfigDraft.value.customEditors.map((editor) => ({ value: `custom:${editor.id}`, label: editor.name })),
]);
function editorTargetName(target: string): string {
  if (target.startsWith("custom:")) {
    const id = target.slice(7);
    return editorConfigDraft.value.customEditors.find((editor) => editor.id === id)?.name || id;
  }
  if (target.startsWith("known:")) {
    const id = target.slice(6);
    return editorKnownEditors.value.find((editor) => editor.id === id)?.name || id;
  }
  return target;
}
function associationTargetValue(assoc: EditorAssociation): string {
  return assoc.customId ? `custom:${assoc.customId}` : assoc.editorId ? `known:${assoc.editorId}` : "";
}
function editorDefaultValue(config: EditorConfig): string {
  return config.defaultCustomId
    ? `custom:${config.defaultCustomId}`
    : config.defaultEditorId
      ? `known:${config.defaultEditorId}`
      : /* reka Select 不接受空串 value，用 "system" 哨兵表示系统默认 */ "system";
}
function addEditorAssociation() {
  const pattern = editorAssociationPatternDraft.value.trim();
  const target = editorAssociationTargetDraft.value;
  if (!pattern || !target) return;
  const assoc: EditorAssociation = target.startsWith("custom:")
    ? { pattern, customId: target.slice("custom:".length) }
    : { pattern, editorId: target.slice("known:".length) };
  editorConfigDraft.value = { ...editorConfigDraft.value, associations: [...editorConfigDraft.value.associations, assoc] };
  editorAssociationPatternDraft.value = "";
  editorAssociationTargetDraft.value = "";
}
function removeEditorAssociation(index: number) {
  editorConfigDraft.value = {
    ...editorConfigDraft.value,
    associations: editorConfigDraft.value.associations.filter((_, i) => i !== index),
  };
}
function removeCustomEditor(id: string) {
  editorConfigDraft.value = {
    ...editorConfigDraft.value,
    customEditors: editorConfigDraft.value.customEditors.filter((editor) => editor.id !== id),
    associations: editorConfigDraft.value.associations.filter((assoc) => assoc.customId !== id),
  };
  if (editorDefaultDraft.value === `custom:${id}`) editorDefaultDraft.value = "system";
}
// M33：压缩传输策略与阈值草稿（阈值 0=不限下限，上限 65536 MiB）。
const TRANSFER_COMPRESS_MODES = ["auto", "on", "off"] as const;
const transferCompressModeDraft = ref(props.transferPrefs.loadCompressMode());
const transferCompressThresholdDraft = ref(String(props.transferPrefs.loadCompressThreshold()));

/** 主「保存」委托：全部草稿写穿到适配器（权威态在 App，sidecar preferences
 * 同步）。数值裁剪与缺省回退逐字保持搬移前语义。 */
function save(): void {
  props.downloadPrefs.persistDir(downloadDirDraft.value);
  props.downloadPrefs.persistUseDefault(downloadUseDefaultDraft.value);
  props.downloadPrefs.persistConflict(downloadConflictDraft.value);
  props.transferPrefs.persistConcurrency(Number.parseInt(transferConcurrencyDraft.value, 10) || 3);
  props.transferPrefs.persistDuplicatePolicy(transferDuplicateDraft.value);
  props.transferPrefs.persistMaxActive(Number.parseInt(transferMaxActiveDraft.value, 10) || 3);
  props.transferPrefs.persistDownloadLimit(Math.max(0, Number.parseInt(transferDownloadLimitDraft.value, 10) || 0));
  props.transferPrefs.persistCompatMode(sftpCompatModeDraft.value);
  props.transferPrefs.persistNameEncoding(sftpNameEncodingDraft.value);
  props.transferPrefs.persistDoubleClickAction(sftpDoubleClickDraft.value);
  props.transferPrefs.persistCompressMode(transferCompressModeDraft.value);
  props.transferPrefs.persistCompressThreshold(Math.min(65536, Math.max(0, Number.parseInt(transferCompressThresholdDraft.value, 10) || 0)));
  props.editorPrefs.persistConfig({
    ...editorConfigDraft.value,
    defaultEditorId: editorDefaultDraft.value.startsWith("known:") ? editorDefaultDraft.value.slice("known:".length) : undefined,
    defaultCustomId: editorDefaultDraft.value.startsWith("custom:") ? editorDefaultDraft.value.slice("custom:".length) : undefined,
    // editorDefaultDraft === "system"（或意外值）时不落默认编辑器字段。
  });
}

/** 打开设置/重载：草稿重读 + known 编辑器目录重探。 */
function reload(): void {
  downloadDirDraft.value = props.downloadPrefs.loadDir();
  downloadUseDefaultDraft.value = props.downloadPrefs.loadUseDefault();
  downloadConflictDraft.value = props.downloadPrefs.loadConflict();
  transferConcurrencyDraft.value = String(props.transferPrefs.loadConcurrency());
  transferDuplicateDraft.value = props.transferPrefs.loadDuplicatePolicy();
  transferMaxActiveDraft.value = String(props.transferPrefs.loadMaxActive());
  transferDownloadLimitDraft.value = String(props.transferPrefs.loadDownloadLimit());
  sftpCompatModeDraft.value = props.transferPrefs.loadCompatMode();
  sftpNameEncodingDraft.value = props.transferPrefs.loadNameEncoding();
  sftpDoubleClickDraft.value = props.transferPrefs.loadDoubleClickAction();
  transferCompressModeDraft.value = props.transferPrefs.loadCompressMode();
  transferCompressThresholdDraft.value = String(props.transferPrefs.loadCompressThreshold());
  editorConfigDraft.value = props.editorPrefs.loadConfig();
  editorDefaultDraft.value = editorDefaultValue(editorConfigDraft.value);
  void props.editorPrefs.reloadEditors().then((list) => { editorKnownEditors.value = list; });
}

// 开窗时 DialogContent 先挂载、父层 reloadSettings 后跑：首次装载自行
// reload 一次（重读草稿 + 重探 known 编辑器目录），父层调用变为幂等兜底。
onMounted(reload);

/** App 侧下载询问弹窗「设为默认」/目录选择器回填（弹窗开着时即时可见）。 */
function setDownloadDirDraft(dir: string) {
  downloadDirDraft.value = dir;
}

function setDownloadUseDefaultDraft(value: boolean) {
  downloadUseDefaultDraft.value = value;
}

defineExpose({ save, reload, setDownloadDirDraft, setDownloadUseDefaultDraft });
</script>

<template>
  <h3 class="settings-section-title">{{ t("downloadSettings.title") }}</h3>
  <label class="settings-field">
    <span>{{ t("downloadSettings.directory") }}</span>
    <span class="settings-dir-row">
      <input v-model="downloadDirDraft" class="mono" spellcheck="false" :placeholder="localDownloadDir || t('downloadSettings.default')" />
      <button v-if="localCanSave" type="button" class="browse-button" :title="t('downloadSettings.browse')" :aria-label="t('downloadSettings.browse')" @click="emit('browse-download-dir')"><FolderOpen /></button>
    </span>
  </label>
  <label class="settings-field settings-switch-row">
    <Switch v-model="downloadUseDefaultDraft" size="sm" />
    <span>{{ t("downloadSettings.useDefaultDir") }}</span>
  </label>
  <p class="muted settings-note">{{ t("downloadSettings.useDefaultDirHint") }}</p>
  <h3 class="settings-section-title">{{ t("downloadSettings.conflictTitle") }}</h3>
  <label v-for="policy in DOWNLOAD_CONFLICT_POLICIES" :key="policy" class="settings-field settings-radio-row">
    <input v-model="downloadConflictDraft" type="radio" name="download-conflict-policy" :value="policy" />
    <span>{{ t(`downloadSettings.conflict.${policy}`) }}</span>
  </label>
  <p class="muted settings-note">{{ t("downloadSettings.conflictHint") }}</p>
  <p class="muted settings-note">{{ t("downloadSettings.hint") }}</p>
  <!-- 上传设置（issue #337 第 2 条）：上传相关项独立成组，不再混在
       「下载设置」标题下；上传并发 + 远端同名策略搬出编辑器组之后。 -->
  <h3 class="settings-section-title">{{ t("uploadSettings.title") }}</h3>
  <label class="settings-field">
    <span>{{ t("transferCfg.concurrency") }}</span>
    <input v-model="transferConcurrencyDraft" type="number" min="1" max="10" step="1" @change="transferConcurrencyDraft = String(Math.min(10, Math.max(1, Number.parseInt(transferConcurrencyDraft, 10) || 3)))" />
  </label>
  <p class="muted settings-note">{{ t("transferCfg.concurrencyHint") }}</p>
  <label class="settings-field">
    <span>{{ t("transferCfg.duplicatePolicy") }}</span>
    <Select :model-value="transferDuplicateDraft" @update:model-value="(v) => (transferDuplicateDraft = String(v) as TransferDuplicatePolicy)">
      <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="policy in TRANSFER_DUPLICATE_POLICIES" :key="policy" :value="policy">{{ t(`transferCfg.policy.${policy}`) }}</SelectItem>
      </SelectContent>
    </Select>
  </label>
  <p class="muted settings-note">{{ t("transferCfg.duplicatePolicyHint") }}</p>
  <h3 class="settings-section-title">{{ t("fileBrowse.title") }}</h3>
  <label v-for="action in SFTP_DOUBLE_CLICK_ACTIONS" :key="action" class="settings-field settings-radio-row">
    <input v-model="sftpDoubleClickDraft" type="radio" name="sftp-double-click-action" :value="action" />
    <span>{{ t(`fileBrowse.doubleClick.${action}`) }}</span>
  </label>
  <p class="muted settings-note">{{ t("fileBrowse.doubleClickHint") }}</p>
  <h3 class="settings-section-title">{{ t("sftpEdit.settingsSection") }}</h3>
  <label class="settings-field">
    <span>{{ t("sftpEdit.defaultEditorTitle") }}</span>
    <Select :model-value="editorDefaultDraft" @update:model-value="(v) => (editorDefaultDraft = String(v))">
      <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="system">{{ t("sftpEdit.defaultEditorSystem") }}</SelectItem>
        <SelectItem v-for="option in editorTargetOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
      </SelectContent>
    </Select>
  </label>
  <p class="muted settings-note">{{ t("sftpEdit.defaultEditorHint") }}</p>
  <span class="settings-field"><span>{{ t("sftpEdit.uploadPolicyTitle") }}</span></span>
  <label class="settings-field settings-radio-row">
    <input v-model="editorConfigDraft.uploadPolicy" type="radio" name="editor-upload-policy" value="auto" />
    <span>{{ t("sftpEdit.uploadPolicy.auto") }}</span>
  </label>
  <label class="settings-field settings-radio-row">
    <input v-model="editorConfigDraft.uploadPolicy" type="radio" name="editor-upload-policy" value="ask" />
    <span>{{ t("sftpEdit.uploadPolicy.ask") }}</span>
  </label>
  <p class="muted settings-note">{{ t("sftpEdit.uploadPolicyHint") }}</p>
  <h3 class="settings-section-title">{{ t("sftpEdit.associationsTitle") }}</h3>
  <p v-if="!editorConfigDraft.associations.length" class="muted settings-note">{{ t("sftpEdit.noAssociations") }}</p>
  <div v-for="(assoc, index) in editorConfigDraft.associations" :key="`${assoc.pattern}-${index}`" class="flex items-center gap-2 py-0.5">
    <span class="mono">{{ assoc.pattern }}</span>
    <span class="muted truncate">→ {{ editorTargetName(associationTargetValue(assoc)) }}</span>
    <button type="button" class="icon-button" :title="t('delete')" :aria-label="t('delete')" @click="removeEditorAssociation(index)"><Trash2 /></button>
  </div>
  <div class="settings-dir-row">
    <input v-model="editorAssociationPatternDraft" class="mono" spellcheck="false" :placeholder="t('sftpEdit.associationPatternPlaceholder')" />
    <Select :model-value="editorAssociationTargetDraft" @update:model-value="(v) => (editorAssociationTargetDraft = String(v))">
      <SelectTrigger size="xs"><SelectValue :placeholder="t('sftpEdit.associationTargetPlaceholder')" /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="option in editorTargetOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
      </SelectContent>
    </Select>
  </div>
  <button type="button" :disabled="!editorAssociationPatternDraft.trim() || !editorAssociationTargetDraft" @click="addEditorAssociation"><Plus />{{ t("sftpEdit.addAssociation") }}</button>
  <p class="muted settings-note">{{ t("sftpEdit.associationsHint") }}</p>
  <h3 class="settings-section-title">{{ t("sftpEdit.customEditorsTitle") }}</h3>
  <p v-if="!editorConfigDraft.customEditors.length" class="muted settings-note">{{ t("sftpEdit.noCustomEditors") }}</p>
  <div v-for="editor in editorConfigDraft.customEditors" :key="editor.id" class="flex items-center gap-2 py-0.5">
    <span class="shrink-0">{{ editor.name }}</span>
    <span class="muted mono truncate">{{ editor.command }}</span>
    <button type="button" class="icon-button" :title="t('delete')" :aria-label="t('delete')" @click="removeCustomEditor(editor.id)"><Trash2 /></button>
  </div>
  <h3 class="settings-section-title">{{ t("transferCfg.pipelineTitle") }}</h3>
  <label class="settings-field">
    <span>{{ t("transferCfg.maxActive") }}</span>
    <input v-model="transferMaxActiveDraft" type="number" min="1" max="8" step="1" @change="transferMaxActiveDraft = String(Math.min(8, Math.max(1, Number.parseInt(transferMaxActiveDraft, 10) || 3)))" />
  </label>
  <p class="muted settings-note">{{ t("transferCfg.maxActiveHint") }}</p>
  <label class="settings-field">
    <span>{{ t("transferCfg.downloadLimit") }}</span>
    <input v-model="transferDownloadLimitDraft" type="number" min="0" max="1048576" step="64" @change="transferDownloadLimitDraft = String(Math.min(1048576, Math.max(0, Number.parseInt(transferDownloadLimitDraft, 10) || 0)))" />
  </label>
  <p class="muted settings-note">{{ t("transferCfg.downloadLimitHint") }}</p>
  <label class="settings-field settings-switch-row">
    <Switch v-model="sftpCompatModeDraft" size="sm" />
    <span>{{ t("transferCfg.compatMode") }}</span>
  </label>
  <p class="muted settings-note">{{ t("transferCfg.compatModeHint") }}</p>
  <label class="settings-field">
    <span>{{ t("transferCfg.nameEncoding") }}</span>
    <Select :model-value="sftpNameEncodingDraft" @update:model-value="(v) => (sftpNameEncodingDraft = String(v) as SftpNameEncoding)">
      <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="encoding in SFTP_NAME_ENCODINGS" :key="encoding" :value="encoding">{{ t(`transferCfg.encoding.${encoding}`) }}</SelectItem>
      </SelectContent>
    </Select>
  </label>
  <p class="muted settings-note">{{ t("transferCfg.nameEncodingHint") }}</p>
  <h3 class="settings-section-title">{{ t("transferCfg.compressTitle") }}</h3>
  <label class="settings-field">
    <span>{{ t("transferCfg.compressMode") }}</span>
    <Select :model-value="transferCompressModeDraft" @update:model-value="(v) => (transferCompressModeDraft = String(v))">
      <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="mode in TRANSFER_COMPRESS_MODES" :key="mode" :value="mode">{{ t(`transferCfg.compressMode.${mode}`) }}</SelectItem>
      </SelectContent>
    </Select>
  </label>
  <p class="muted settings-note">{{ t("transferCfg.compressModeHint") }}</p>
  <label class="settings-field">
    <span>{{ t("transferCfg.compressThreshold") }}</span>
    <input v-model="transferCompressThresholdDraft" type="number" min="0" max="65536" step="16" :disabled="transferCompressModeDraft === 'off'" @change="transferCompressThresholdDraft = String(Math.min(65536, Math.max(0, Number.parseInt(transferCompressThresholdDraft, 10) || 0)))" />
  </label>
  <p class="muted settings-note">{{ t("transferCfg.compressThresholdHint") }}</p>
</template>
