<script setup lang="ts">
// 终端分类面板（自 SettingsDialog 外抽）：分栏方向、工具栏按钮隐藏、渲染/
// 键盘/鼠标/剪贴板/声音、动作链接、gutter、上下文搜索引擎表、X11、RDP 实验
// 开关、会话自动录制、启动命令（组件自治 RPC）、连接级文件名编码。
// 行为/动作链接/gutter 只上抛增量（处理器经 props 注入，权威态唯一在 App，
// 本组件不持副本，重开弹窗无回显漂移）；X11/自动录制/RDP 实验/启动命令/
// 连接级编码沿用「组件内自治读写 sidecar 偏好」模式（App 无需感知），随本
// 组件整体搬迁。
import { computed, onMounted, ref } from "vue";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "@lucide/vue";
import { Switch } from "./ui/switch";
import type { ConnectionNameEncodingChoice } from "../lib/connectionNameEncoding";
import { STARTUP_COMMAND_MAX, STARTUP_DELAY_MAX_MS } from "../lib/startupCommands";
import { useStartupCommands } from "../composables/useStartupCommands";
import { useConnectionNameEncoding } from "../composables/useConnectionNameEncoding";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  BELL_MODES,
  LINK_MODIFIERS,
  RIGHT_CLICK_MODES,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  NOWRAP_COLUMNS_MAX,
  NOWRAP_COLUMNS_MIN,
  WORD_SEPARATOR_MAX_LENGTH,
  type TerminalBehaviorSettings,
  type TerminalBellMode,
  type TerminalLinkModifier,
  type TerminalRightClickMode,
} from "../lib/terminalBehavior";
import type { PaneDirectionPref } from "../lib/paneLayout";
import { TOOLBAR_BUTTONS, type ToolbarButtonId, type ToolbarVisibility } from "../lib/toolbarVisibility";
import { type ActionLinkMatcherToggles } from "../lib/actionLinksMatcher";
import { rdpExperimentalEnabled as parseRdpExperimentalEnabled } from "../lib/rdpExperimental";
import { GUTTER_TIMESTAMP_DEFAULT_FORMAT, type GutterSettings } from "../lib/terminalGutter";

/** reka Select 空串占位哨兵（localShell 缺省=自动检测）。 */
const LOCAL_SHELL_AUTO = "__auto__";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  /** 当前 SSH 会话的连接 id：启动命令/编码覆盖按 connectionId 分桶。 */
  connectionId?: string;
  terminalBehavior: TerminalBehaviorSettings;
  paneDirection: PaneDirectionPref;
  toolbarVisibility: ToolbarVisibility;
  webglEnabled: boolean;
  localShell: string;
  localShellOptions: Array<{ program: string; name: string; isDefault: boolean; isUserShell: boolean; injectable?: boolean }>;
  actionLinks: { enabled: boolean; matchers: ActionLinkMatcherToggles };
  gutter: GutterSettings;
  ctxSearchEngines: string;
  // —— 增量上抛处理器（权威态在 App，归一化与落地也在 App）——————
  updateBehavior: (patch: Partial<TerminalBehaviorSettings>) => void;
  updateActionLinks: (patch: { enabled?: boolean; matchers?: Partial<ActionLinkMatcherToggles> }) => void;
  updateGutter: (patch: { showLineNumbers?: boolean; showTimestamps?: boolean; timestampFormat?: string }) => void;
  setPaneDirection: (value: PaneDirectionPref) => void;
  setToolbarVisibility: (id: ToolbarButtonId, visible: boolean) => void;
  setWebgl: (value: boolean) => void;
  setLocalShell: (program: string) => void;
  setCtxSearchEngines: (value: string) => void;
}>();

const emit = defineEmits<{
  (event: "error", cause: unknown): void;
}>();

// —— 终端行为枚举 → i18n key（模板按常量数组顺序迭代单选组）———————
const RIGHT_CLICK_LABELS: Record<TerminalRightClickMode, string> = {
  off: "terminalBehavior.rightClickOff",
  menu: "terminalBehavior.rightClickMenu",
  paste: "terminalBehavior.rightClickPaste",
  clipboard: "terminalBehavior.rightClickClipboard",
};
const BELL_LABELS: Record<TerminalBellMode, string> = {
  off: "terminalBehavior.bellOff",
  visual: "terminalBehavior.bellVisual",
  audible: "terminalBehavior.bellAudible",
};
const LINK_MODIFIER_LABELS: Record<TerminalLinkModifier, string> = {
  none: "terminalBehavior.linkModifierNone",
  ctrl: "terminalBehavior.linkModifierCtrl",
  alt: "terminalBehavior.linkModifierAlt",
  shift: "terminalBehavior.linkModifierShift",
  meta: "terminalBehavior.linkModifierMeta",
};

/** 数字输入框取原始串（模板里避免写 as 断言）。 */
function numberFieldValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

/** 文本输入框取原始串（同 numberFieldValue）。 */
function textFieldValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

/** 数字输入框 → 行为字段：空串或非数值直接忽略，避免清空输入框把值打成 NaN。 */
function updateScrollback(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return;
  props.updateBehavior({ scrollbackLines: value });
}

/** #306 无折行列数：空串/非数值忽略，范围钳位交给 App 侧 sanitize。 */
function updateNoWrapColumns(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return;
  props.updateBehavior({ noWrapColumns: value });
}

/** 单个匹配器开关：reka Switch 回传 boolean | string，收紧为布尔再上抛。 */
function updateMatcher(key: keyof ActionLinkMatcherToggles, value: unknown) {
  props.updateActionLinks({ matchers: { [key]: value === true } });
}

/** 时间戳格式输入：空串回退默认格式（输入中途清空不落空格式）。 */
function updateGutterFormat(raw: string) {
  const trimmed = raw.trim();
  props.updateGutter({ timestampFormat: trimmed || GUTTER_TIMESTAMP_DEFAULT_FORMAT });
}

/** 三类匹配器开关按常量数组迭代（模板不支持 as const 字面量迭代）。 */
const ACTION_LINK_MATCHER_ROWS: Array<{ key: keyof ActionLinkMatcherToggles; label: string }> = [
  { key: "ipv4", label: "actionLinks.ipv4" },
  { key: "hostPort", label: "actionLinks.hostPort" },
  { key: "archive", label: "actionLinks.archive" },
];

/** reka Select 回传 AcceptableValue（含 null 与对象），这里只接受字符串形态。 */
function updateLinkModifier(value: unknown) {
  props.updateBehavior({ linkModifier: String(value) as TerminalLinkModifier });
}

const localShellModelValue = computed(() => (props.localShell ? props.localShell : LOCAL_SHELL_AUTO));
function resolveLocalShellValue(value: string): string {
  return value === LOCAL_SHELL_AUTO ? "" : value;
}

// —— X11 转发偏好（P3-3）：组件内自治读写 sidecar 偏好——即时生效语义
// （新会话才启用），不走 props/emit（App 无需感知）。
const x11Enabled = ref(false);
const x11ReadOnlyNote = ref(false);

async function loadX11Preference() {
  try {
    const prefs = await window.dbxPlugin?.invoke<{ x11_forwarding?: unknown }>("local/preferences/get", {});
    x11Enabled.value = prefs?.x11_forwarding === true;
  } catch {
    x11Enabled.value = false;
  }
}

async function setX11Enabled(next: boolean) {
  x11Enabled.value = next;
  try {
    await window.dbxPlugin?.invoke("local/preferences/set", { x11_forwarding: next });
  } catch {
    x11Enabled.value = !next;
  }
}

// —— 会话自动录制偏好（M14，对标 iShell）：与 X11 同款模式 ————————
const autoRecordEnabled = ref(false);

// —— RDP 实验开关：默认关闭，必须由用户在设置中显式启用 ————————
const rdpExperimentalEnabled = ref(false);

async function loadRdpExperimentalPreference() {
  try {
    const prefs = await window.dbxPlugin?.invoke<{ rdp_experimental_enabled?: unknown }>("local/preferences/get", {});
    rdpExperimentalEnabled.value = parseRdpExperimentalEnabled(prefs?.rdp_experimental_enabled);
  } catch {
    rdpExperimentalEnabled.value = false;
  }
}

async function setRdpExperimentalEnabled(next: boolean) {
  rdpExperimentalEnabled.value = next;
  try {
    // 开关持久化到 sidecar 偏好即可生效（后端 rdp/start 前置检查）；
    // App 不再持有内存门副本（M32-A 后工具条无 RDP 入口）。
    await window.dbxPlugin?.invoke("local/preferences/set", { rdp_experimental_enabled: next });
  } catch {
    rdpExperimentalEnabled.value = !next;
  }
}

async function loadAutoRecordPreference() {
  try {
    const prefs = await window.dbxPlugin?.invoke<{ auto_record?: unknown }>("local/preferences/get", {});
    autoRecordEnabled.value = prefs?.auto_record === true;
  } catch {
    autoRecordEnabled.value = false;
  }
}

async function setAutoRecordEnabled(next: boolean) {
  autoRecordEnabled.value = next;
  try {
    await window.dbxPlugin?.invoke("local/preferences/set", { auto_record: next });
  } catch {
    autoRecordEnabled.value = !next;
  }
}

// 启动命令与连接级编码的自治 RPC 面下沉 useStartupCommands /
// useConnectionNameEncoding（镜像播种/收敛、读改写合并语义随迁）。
const startup = useStartupCommands({
  connectionId: () => props.connectionId,
  onError: (cause) => emit("error", cause),
});
const {
  startupEnabled,
  startupCommands,
  loadStartupCommands,
  setStartupEnabled,
  addStartupEntry,
  removeStartupEntry,
  moveStartupEntry,
  updateStartupEntry,
  clampStartupDelayInput,
} = startup;
const encoding = useConnectionNameEncoding({
  connectionId: () => props.connectionId,
  onError: (cause) => emit("error", cause),
});
const { connNameEncodingChoice, loadConnNameEncoding, setConnNameEncoding } = encoding;


onMounted(() => {
  void loadX11Preference();
  void loadAutoRecordPreference();
  void loadRdpExperimentalPreference();
  void loadStartupCommands();
  void loadConnNameEncoding();
});

</script>

<template>
            <!-- 分栏布局方向（issue #187）：终端与 SFTP 的排布三选；auto 沿用
                 窄屏断点，强制上下/左右不受视口影响。 -->
            <h3 class="settings-section-title">{{ t("workbenchLayout.sectionTitle") }}</h3>
            <label class="settings-field">
              <span>{{ t("workbenchLayout.direction") }}</span>
              <Select :model-value="paneDirection" @update:model-value="(v) => setPaneDirection(String(v) as PaneDirectionPref)">
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{{ t("workbenchLayout.directionAuto") }}</SelectItem>
                  <SelectItem value="vertical">{{ t("workbenchLayout.directionVertical") }}</SelectItem>
                  <SelectItem value="horizontal">{{ t("workbenchLayout.directionHorizontal") }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <!-- 工具栏按钮可配置隐藏（issue #309）：逐按钮开关，默认全显示；
                 隐藏只收敛主工作台工具条视觉密度，核心入口不进清单。 -->
            <h3 class="settings-section-title">{{ t("toolbarButtons.sectionTitle") }}</h3>
            <p class="muted settings-note">{{ t("toolbarButtons.hint") }}</p>
            <label v-for="button in TOOLBAR_BUTTONS" :key="button.id" class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="toolbarVisibility[button.id] !== false" @update:model-value="(value) => setToolbarVisibility(button.id, value === true)" />
              <span>{{ t(button.labelKey) }}</span>
            </label>
            <h3 class="settings-section-title">{{ t("terminalBehavior.renderingSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="webglEnabled" @update:model-value="(value) => setWebgl(value === true)" />
              <span>{{ t("webglLabel") }}</span>
            </label>
            <p class="muted settings-note">{{ t("webglHint") }}</p>
            <label class="settings-field">
              <span>{{ t("terminalBehavior.scrollbackLines") }}</span>
              <input type="number" :min="SCROLLBACK_MIN" :max="SCROLLBACK_MAX" step="100" :value="terminalBehavior.scrollbackLines" @change="updateScrollback(numberFieldValue($event))" />
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.scrollbackHint") }}</p>
            <!-- #306 无折行模式：宽 PTY + 横向滚动；vim/htop 等备用屏自动回退可视宽度。 -->
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.noWrap" @update:model-value="(value) => updateBehavior({ noWrap: value === true })" />
              <span>{{ t("terminalBehavior.noWrap") }}</span>
            </label>
            <label class="settings-field" v-if="terminalBehavior.noWrap">
              <span>{{ t("terminalBehavior.noWrapColumns") }}</span>
              <input type="number" :min="NOWRAP_COLUMNS_MIN" :max="NOWRAP_COLUMNS_MAX" step="50" :value="terminalBehavior.noWrapColumns" @change="updateNoWrapColumns(numberFieldValue($event))" />
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.noWrapHint") }}</p>

            <h3 class="settings-section-title">{{ t("terminalBehavior.localShellSection") }}</h3>
            <label class="settings-field">
              <span>{{ t("terminalBehavior.localShell") }}</span>
              <Select :model-value="localShellModelValue" @update:model-value="(value) => setLocalShell(resolveLocalShellValue(String(value)))">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto__">{{ t("terminalBehavior.localShellAuto") }}</SelectItem>
                  <SelectItem v-for="shell in localShellOptions" :key="shell.program" :value="shell.program" :title="shell.program">{{ shell.name === shell.program ? shell.name : `${shell.name} · ${shell.program}` }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.localShellHint") }}</p>

            <h3 class="settings-section-title">{{ t("terminalBehavior.keyboardSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.altIsMeta" @update:model-value="(v) => updateBehavior({ altIsMeta: v === true })" />
              <span>{{ t("terminalBehavior.altIsMeta") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.altIsMetaHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.altWordEditing" @update:model-value="(v) => updateBehavior({ altWordEditing: v === true })" />
              <span>{{ t("terminalBehavior.altWordEditing") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.altWordEditingHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.scrollOnInput" @update:model-value="(v) => updateBehavior({ scrollOnInput: v === true })" />
              <span>{{ t("terminalBehavior.scrollOnInput") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.scrollOnInputHint") }}</p>

            <h3 class="settings-section-title">{{ t("terminalBehavior.mouseSection") }}</h3>
            <h4 class="settings-section-title">{{ t("terminalBehavior.rightClick") }}</h4>
            <label v-for="mode in RIGHT_CLICK_MODES" :key="mode" class="settings-field settings-radio-row">
              <input type="radio" name="terminal-right-click" :value="mode" :checked="terminalBehavior.rightClick === mode" @change="updateBehavior({ rightClick: mode })" />
              <span>{{ t(RIGHT_CLICK_LABELS[mode]) }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.rightClickHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.pasteOnMiddleClick" @update:model-value="(v) => updateBehavior({ pasteOnMiddleClick: v === true })" />
              <span>{{ t("terminalBehavior.pasteOnMiddleClick") }}</span>
            </label>
            <label class="settings-field">
              <span>{{ t("terminalBehavior.wordSeparator") }}</span>
              <input class="mono" spellcheck="false" :maxlength="WORD_SEPARATOR_MAX_LENGTH" :value="terminalBehavior.wordSeparator" @change="updateBehavior({ wordSeparator: textFieldValue($event) })" />
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.wordSeparatorHint") }}</p>
            <label class="settings-field">
              <span>{{ t("terminalBehavior.linkModifier") }}</span>
              <Select :model-value="terminalBehavior.linkModifier" @update:model-value="updateLinkModifier">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="modifier in LINK_MODIFIERS" :key="modifier" :value="modifier">{{ t(LINK_MODIFIER_LABELS[modifier]) }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.linkModifierHint") }}</p>

            <h3 class="settings-section-title">{{ t("terminalBehavior.clipboardSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.copyOnSelect" @update:model-value="(v) => updateBehavior({ copyOnSelect: v === true })" />
              <span>{{ t("terminalSelectCopy.label") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalSelectCopy.hint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.bracketedPaste" @update:model-value="(v) => updateBehavior({ bracketedPaste: v === true })" />
              <span>{{ t("terminalBehavior.bracketedPaste") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.bracketedPasteHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.warnOnMultilinePaste" @update:model-value="(v) => updateBehavior({ warnOnMultilinePaste: v === true })" />
              <span>{{ t("terminalBehavior.warnOnMultilinePaste") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.warnOnMultilinePasteHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.replaceNewlinesWithSpaces" @update:model-value="(v) => updateBehavior({ replaceNewlinesWithSpaces: v === true })" />
              <span>{{ t("terminalBehavior.replaceNewlines") }}</span>
            </label>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.trimWhitespaceOnPaste" @update:model-value="(v) => updateBehavior({ trimWhitespaceOnPaste: v === true })" />
              <span>{{ t("terminalBehavior.trimWhitespace") }}</span>
            </label>

            <h3 class="settings-section-title">{{ t("terminalBehavior.soundSection") }}</h3>
            <h4 class="settings-section-title">{{ t("terminalBehavior.bell") }}</h4>
            <label v-for="mode in BELL_MODES" :key="mode" class="settings-field settings-radio-row">
              <input type="radio" name="terminal-bell" :value="mode" :checked="terminalBehavior.bell === mode" @change="updateBehavior({ bell: mode })" />
              <span>{{ t(BELL_LABELS[mode]) }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.bellHint") }}</p>

            <h3 class="settings-section-title">{{ t("actionLinks.sectionTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="actionLinks.enabled" @update:model-value="(v) => updateActionLinks({ enabled: v === true })" />
              <span>{{ t("actionLinks.enabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("actionLinks.enabledHint") }}</p>
            <template v-if="actionLinks.enabled">
              <label v-for="matcher in ACTION_LINK_MATCHER_ROWS" :key="matcher.key" class="settings-field settings-switch-row">
                <Switch size="sm" :model-value="actionLinks.matchers[matcher.key]" @update:model-value="(v) => updateMatcher(matcher.key, v)" />
                <span>{{ t(matcher.label) }}</span>
              </label>
            </template>

            <h3 class="settings-section-title">{{ t("gutter.sectionTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="gutter.showLineNumbers" @update:model-value="(v) => updateGutter({ showLineNumbers: v === true })" />
              <span>{{ t("gutter.showLineNumbers") }}</span>
            </label>
            <p class="muted settings-note">{{ t("gutter.showLineNumbersHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="gutter.showTimestamps" @update:model-value="(v) => updateGutter({ showTimestamps: v === true })" />
              <span>{{ t("gutter.showTimestamps") }}</span>
            </label>
            <p class="muted settings-note">{{ t("gutter.showTimestampsHint") }}</p>
            <label class="settings-field">
              <span>{{ t("gutter.timestampFormat") }}</span>
              <input class="mono" spellcheck="false" :maxlength="64" :placeholder="GUTTER_TIMESTAMP_DEFAULT_FORMAT" :value="gutter.timestampFormat" @change="updateGutterFormat(textFieldValue($event))" />
            </label>
            <p class="muted settings-note">{{ t("gutter.timestampFormatHint") }}</p>

            <h3 class="settings-section-title">{{ t("ctxSearch.sectionTitle") }}</h3>
            <p class="muted settings-note">{{ t("ctxSearch.hint") }}</p>
            <label class="settings-field">
              <span>{{ t("ctxSearch.enginesLabel") }}</span>
              <textarea class="mono" rows="4" spellcheck="false" :value="ctxSearchEngines" @change="setCtxSearchEngines(($event.target as HTMLTextAreaElement).value)"></textarea>
            </label>

            <p class="muted settings-note">{{ t("terminalBehavior.scopeNote") }}</p>
            <p class="muted settings-note">{{ t("terminalFont.movedHint") }}</p>

            <h3 class="settings-section-title">{{ t("x11.sectionTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch :model-value="x11Enabled" size="sm" @update:model-value="setX11Enabled(Boolean($event))" />
              <span>{{ t("x11.enabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("x11.enabledHint") }}</p>
            <p v-if="x11ReadOnlyNote" class="muted settings-note">{{ t("x11.readOnlyNote") }}</p>

            <h3 class="settings-section-title">{{ t("rdp.experimentalSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch :model-value="rdpExperimentalEnabled" size="sm" @update:model-value="setRdpExperimentalEnabled(Boolean($event))" />
              <span>{{ t("rdp.experimentalEnabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("rdp.experimentalHint") }}</p>

            <!-- 会话自动录制（M14）：新会话自动挂录制器，标 iShell 录制增强。 -->
            <h3 class="settings-section-title">{{ t("autoRecord.sectionTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch :model-value="autoRecordEnabled" size="sm" @update:model-value="setAutoRecordEnabled(Boolean($event))" />
              <span>{{ t("autoRecord.enabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("autoRecord.enabledHint") }}</p>

            <!-- 启动命令（对标 Tabby「Login scripts」）：连接建立进入 shell 后按序
                 自动键入；仅 SSH 交互 shell 会话生效（RemoteCommand exec 会话跳过）。 -->
            <template v-if="connectionId">
            <h3 class="settings-section-title">{{ t("startupCommands.sectionTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch :model-value="startupEnabled" size="sm" @update:model-value="setStartupEnabled(Boolean($event))" />
              <span>{{ t("startupCommands.enabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("startupCommands.enabledHint") }}</p>
            <template v-if="startupEnabled">
              <p v-if="!startupCommands.length" class="muted settings-note">{{ t("startupCommands.empty") }}</p>
              <ul v-else class="settings-list startup-commands-list">
                <li v-for="(entry, index) in startupCommands" :key="index">
                  <input
                    type="checkbox"
                    :checked="entry.enabled"
                    :aria-label="t('startupCommands.rowEnabled')"
                    :title="t('startupCommands.rowEnabled')"
                    @change="updateStartupEntry(index, { enabled: ($event.target as HTMLInputElement).checked })"
                  />
                  <input
                    class="mono startup-command-text"
                    spellcheck="false"
                    :value="entry.command"
                    :placeholder="t('startupCommands.commandPlaceholder')"
                    :aria-label="t('startupCommands.commandPlaceholder')"
                    @change="updateStartupEntry(index, { command: textFieldValue($event) })"
                  />
                  <input
                    class="mono startup-command-delay"
                    type="number"
                    min="0"
                    :max="STARTUP_DELAY_MAX_MS"
                    step="50"
                    :value="entry.delayMs"
                    :aria-label="t('startupCommands.delay')"
                    :title="t('startupCommands.delay')"
                    @change="updateStartupEntry(index, { delayMs: clampStartupDelayInput(($event.target as HTMLInputElement).value) })"
                  />
                  <span class="settings-list-actions">
                    <button class="icon-button" :disabled="index === 0" :title="t('startupCommands.moveUp')" :aria-label="t('startupCommands.moveUp')" @click="moveStartupEntry(index, -1)"><ArrowUp /></button>
                    <button class="icon-button" :disabled="index === startupCommands.length - 1" :title="t('startupCommands.moveDown')" :aria-label="t('startupCommands.moveDown')" @click="moveStartupEntry(index, 1)"><ArrowDown /></button>
                    <button class="icon-button" :title="t('startupCommands.remove')" :aria-label="t('startupCommands.remove')" @click="removeStartupEntry(index)"><Trash2 /></button>
                  </span>
                </li>
              </ul>
              <button v-if="startupCommands.length < STARTUP_COMMAND_MAX" class="link-button" type="button" @click="addStartupEntry"><Plus />{{ t("startupCommands.add") }}</button>
              <p class="muted settings-note">{{ t("startupCommands.scopeNote") }}</p>
            </template>

            <!-- 连接级 SFTP 文件名编码（M16）：覆盖全局 `sftp_name_encoding`；
                 缺省「跟随全局」（不落盘），白名单 auto/latin-1 与全局一致。 -->
            <h3 class="settings-section-title">{{ t("connNameEncoding.sectionTitle") }}</h3>
            <label class="settings-field">
              <span>{{ t("connNameEncoding.label") }}</span>
              <Select :model-value="connNameEncodingChoice" @update:model-value="setConnNameEncoding(String($event) as ConnectionNameEncodingChoice)">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="follow">{{ t("connNameEncoding.follow") }}</SelectItem>
                  <SelectItem value="auto">{{ t("transferCfg.encoding.auto") }}</SelectItem>
                  <SelectItem value="latin-1">{{ t("transferCfg.encoding.latin-1") }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p class="muted settings-note">{{ t("connNameEncoding.hint") }}</p>
            </template>

</template>
