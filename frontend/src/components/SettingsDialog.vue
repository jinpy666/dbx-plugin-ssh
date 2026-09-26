<script setup lang="ts">
// 设置弹窗（从 App.vue 抽出的独立组件）：承载设置主弹窗与 quick sudo 配置档
// 管理弹窗，两者共用同一份 sudoProfiles/profileDraft 草稿状态。连接级设置
// （ssh/settings/get|set）、配置档（sudo/profiles/*）、已知主机
// （ssh/knownHosts/*）、本机密钥发现（keys/discover）、MCP 限速
// （mcp/settings/*）经全局 window.dbxPlugin.invoke 直调；下载偏好与终端偏好
// （WebGL/选中复制/终端字体）的权威态在宿主 App——下载偏好经 downloadPrefs
// 适配器读写，终端偏好经 props 下发 + emits 上抛。
import { computed, reactive, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Check, FolderOpen, KeyRound, Loader2, Pencil, Plus, RotateCcw, ShieldCheck, Trash2, Upload, X } from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Switch } from "./ui/switch";
import TerminalAppearancePreview from "./TerminalAppearancePreview.vue";
import TerminalSchemePicker from "./TerminalSchemePicker.vue";
import TerminalHotkeyEditor from "./TerminalHotkeyEditor.vue";
import { AGENT_MODES, sanitizeRememberedCommands } from "../lib/agentTerminal";
import { clampFontSize, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "../lib/terminalZoom";
import { loadTerminalFontOverride } from "../lib/terminalFont";
import { MIB, mibField, settingsErrorOf, type DiscoveredKey, type KnownHostEntry, type McpSizeSettings, type SshSettings, type SudoProfileView } from "../lib/settingsModel";
import { DOWNLOAD_CONFLICT_POLICIES, type DownloadConflictPolicy } from "../lib/downloadPrefs";
import { TRANSFER_DUPLICATE_POLICIES, type TransferDuplicatePolicy } from "../lib/transferQueue";
import { SFTP_NAME_ENCODINGS, type SftpNameEncoding } from "../lib/sftpName";
import {
  allAppearanceProfiles,
  applySchemeToTerminalTheme,
  CUSTOM_SCHEME_LIMIT,
  TERMINAL_APPEARANCE_PRESETS,
  terminalOptionPatch,
  type TerminalAppearanceProfile,
  type TerminalAppearanceSettings,
  type TerminalAppearanceState,
  type TerminalCursorInactiveStyle,
  type TerminalCursorStyle,
} from "../lib/terminalAppearance";
import { BUILTIN_TERMINAL_SCHEMES, contrastRatio, parseHexColor, parseSchemeImport, type TerminalColorScheme, type TerminalThemeLike } from "../lib/terminalScheme";
import {
  BELL_MODES,
  LINK_MODIFIERS,
  RIGHT_CLICK_MODES,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  WORD_SEPARATOR_MAX_LENGTH,
  type TerminalBehaviorSettings,
  type TerminalBellMode,
  type TerminalLinkModifier,
  type TerminalRightClickMode,
} from "../lib/terminalBehavior";
import type { TerminalHotkeyBindings } from "../lib/terminalHotkeys";
import { type ActionLinkMatcherToggles, type ActionLinksSettings } from "../lib/actionLinksMatcher";
import { rdpExperimentalEnabled as parseRdpExperimentalEnabled } from "../lib/rdpExperimental";
import { GUTTER_TIMESTAMP_DEFAULT_FORMAT, type GutterSettings } from "../lib/terminalGutter";
import {
  createStartupEntry,
  mergeStartupStore,
  normalizeStartupConfig,
  STARTUP_COMMAND_MAX,
  STARTUP_DELAY_MAX_MS,
  STARTUP_DELAY_DEFAULT_MS,
  type StartupCommandEntry,
} from "../lib/startupCommands";
import {
  choiceFromOverride,
  mergeNameEncodingStore,
  overrideFromChoice,
  type ConnectionNameEncodingChoice,
} from "../lib/connectionNameEncoding";

/** 连接级启动命令（P0-4，Tabby「Login scripts」对标）：同 X11 走组件内自治
 * RPC 读写 sidecar 偏好（`startup_commands` 键按 connectionId 分桶，读改写
 * 合并只动本连接的桶）；shell 起来后按序注入，改动对新开会话生效。 */
const startupEnabled = ref(false);
const startupCommands = ref<StartupCommandEntry[]>([]);

async function loadStartupCommands() {
  const connectionId = props.connectionId;
  if (!connectionId) return;
  try {
    const prefs = await window.dbxPlugin?.invoke<{ startup_commands?: unknown }>("local/preferences/get", {});
    const store = prefs?.startup_commands as Record<string, unknown> | undefined;
    const config = normalizeStartupConfig(store?.[connectionId]);
    startupEnabled.value = config.enabled;
    startupCommands.value = config.commands;
  } catch {
    startupEnabled.value = false;
    startupCommands.value = [];
  }
}

/// 读改写合并：`local/preferences/set` 对 startup_commands 是整键替换，
/// 其他连接的桶从最新偏好读回后原样保留。
async function persistStartupCommands() {
  const connectionId = props.connectionId;
  if (!connectionId) return;
  try {
    const prefs = await window.dbxPlugin?.invoke<{ startup_commands?: unknown }>("local/preferences/get", {});
    await window.dbxPlugin?.invoke("local/preferences/set", {
      startup_commands: mergeStartupStore(
        prefs?.startup_commands,
        connectionId,
        { enabled: startupEnabled.value, commands: startupCommands.value },
      ),
    });
  } catch (cause) {
    emit("error", cause);
  }
}

async function setStartupEnabled(next: boolean) {
  startupEnabled.value = next;
  // 开启且无命令时给一行空行，省一次点击；清空命令立即持久化。
  if (next && startupCommands.value.length === 0) startupCommands.value.push(createStartupEntry());
  await persistStartupCommands();
}

function addStartupEntry() {
  if (startupCommands.value.length >= STARTUP_COMMAND_MAX) return;
  startupCommands.value.push(createStartupEntry());
  void persistStartupCommands();
}

function removeStartupEntry(index: number) {
  startupCommands.value.splice(index, 1);
  void persistStartupCommands();
}

function moveStartupEntry(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= startupCommands.value.length) return;
  const [row] = startupCommands.value.splice(index, 1);
  startupCommands.value.splice(target, 0, row);
  void persistStartupCommands();
}

/** 行内增量（命令文本 / 延迟 / 启用）：改完即持久化（@change 语义，非逐键）。 */
function updateStartupEntry(index: number, patch: Partial<StartupCommandEntry>) {
  const row = startupCommands.value[index];
  if (!row) return;
  Object.assign(row, patch);
  void persistStartupCommands();
}

/** 延迟输入收敛：空/非法回缺省 300ms，越界截断到 30s。 */
function clampStartupDelayInput(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 0) return STARTUP_DELAY_DEFAULT_MS;
  return Math.min(value, STARTUP_DELAY_MAX_MS);
}
import { pluginStore } from "../lib/pluginStore";

/** 连接级 SFTP 文件名编码覆盖（M16）：同启动命令的自治 RPC 读写
 * （`sftp_name_encoding_overrides` 键按 connectionId 分桶）。控件缺省
 * 「跟随全局」且不落盘（删除本连接桶）；连接未覆盖时全局
 * `sftp_name_encoding` 生效，判定优先级在 sidecar（覆盖 > 全局 > auto）。 */
const connNameEncodingChoice = ref<ConnectionNameEncodingChoice>("follow");

async function loadConnNameEncoding() {
  const connectionId = props.connectionId;
  if (!connectionId) return;
  try {
    const prefs = await window.dbxPlugin?.invoke<{ sftp_name_encoding_overrides?: unknown }>("local/preferences/get", {});
    const store = prefs?.sftp_name_encoding_overrides as Record<string, unknown> | undefined;
    connNameEncodingChoice.value = choiceFromOverride(store?.[connectionId]);
  } catch {
    connNameEncodingChoice.value = "follow";
  }
}

async function persistConnNameEncoding() {
  const connectionId = props.connectionId;
  if (!connectionId) return;
  try {
    const prefs = await window.dbxPlugin?.invoke<{ sftp_name_encoding_overrides?: unknown }>("local/preferences/get", {});
    await window.dbxPlugin?.invoke("local/preferences/set", {
      sftp_name_encoding_overrides: mergeNameEncodingStore(
        prefs?.sftp_name_encoding_overrides,
        connectionId,
        overrideFromChoice(connNameEncodingChoice.value),
      ),
    });
  } catch (cause) {
    emit("error", cause);
  }
}

function setConnNameEncoding(choice: ConnectionNameEncodingChoice) {
  connNameEncodingChoice.value = choice;
  void persistConnNameEncoding();
}

/** X11 转发偏好（P3-3）：组件内自治读写 sidecar 偏好——即时生效语义
 * （新会话才启用），不走 props/emit（App 无需感知）。 */
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

/** 会话自动录制偏好（M14，对标 iShell）：与 X11 同款「组件内自治读写
 * sidecar 偏好」模式，即时生效语义（之后 open 的会话才自动录制）。 */
const autoRecordEnabled = ref(false);

/** RDP 仍处实验阶段：默认关闭，必须由用户在设置中显式启用。 */
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
    await window.dbxPlugin?.invoke("local/preferences/set", { rdp_experimental_enabled: next });
    emit("update:rdpExperimental", next);
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

void loadAutoRecordPreference();
void loadRdpExperimentalPreference();

void loadX11Preference();

// 结构化补全开关（对标 Warp/fig，线 2）：组件内自治读写 pluginStore
// （键 ssh-completion-spec，"false" = 关，默认开）——不走 props/emit，
// App 在浮层弹出前直读同一键，无需事件同步。
const SPEC_COMPLETION_ENABLED_KEY = "ssh-completion-spec";
const specCompletionEnabled = ref(true);

function loadSpecCompletionEnabled(): boolean {
  try {
    return pluginStore.getItem(SPEC_COMPLETION_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

// 终端行内 ghost 自动建议开关（np8，对标 Warp/fish）：沿用 x11 的「组件内自治
// 读写」先例，但持久化走独立 pluginStore 键（UI 偏好单点，默认开）；与 x11 的
// 差异只在生效语义——ghost 渲染在 App 当前会话即时生效，故写穿后经
// update:ghostSuggest 把新值上抛（App 只握内存态，不负责持久化）。
const GHOST_SUGGEST_KEY = "ssh-terminal-ghost-suggest";
const ghostEnabled = ref(loadGhostEnabled());

function loadGhostEnabled(): boolean {
  try {
    return pluginStore.getItem(GHOST_SUGGEST_KEY) !== "0";
  } catch {
    return true;
  }
}

function setSpecCompletionEnabled(next: boolean) {
  specCompletionEnabled.value = next;
  try {
    pluginStore.setItem(SPEC_COMPLETION_ENABLED_KEY, next ? "true" : "false");
  } catch {
    // 存储不可用（无宿主桥且 localStorage 受限）：仅当前会话生效。
  }
}

specCompletionEnabled.value = loadSpecCompletionEnabled();

function setGhostEnabled(next: boolean) {
  ghostEnabled.value = next;
  try {
    pluginStore.setItem(GHOST_SUGGEST_KEY, next ? "1" : "0");
  } catch {
    // 存储不可用（沙箱降级链耗尽）：退化为会话内存态，开关仍然生效。
  }
  emit("update:ghostSuggest", next);
}

const props = defineProps<{
  open: boolean;
  profilesOpen: boolean;
  sessionId?: string;
  /** 当前 SSH 会话的连接 id：启动命令偏好按 connectionId 分桶（无会话时整区隐藏）。 */
  connectionId?: string;
  /** 终端当前生效字号（缩放链路在 App，设置页字号草稿以它为初始回显）。 */
  terminalFontSize: number;
  /** 宿主主题终端基准字号（「恢复默认」回到该值）。 */
  hostFontSize: number;
  /** 宿主终端字体族（用户未单独设置字体时预览用它）。 */
  hostFontFamily: string;
  localDownloadDir: string;
  localCanSave: boolean;
  webglEnabled: boolean;
  /** 终端行为偏好（对标 Tabby「Terminal」页）：权威态在 App，本组件只读 + 上抛增量。 */
  terminalBehavior: TerminalBehaviorSettings;
  /** 终端快捷键绑定（对标 Tabby「Hotkeys」页）：权威态在 App。 */
  terminalHotkeys: TerminalHotkeyBindings;
  /** 是否 Apple 平台：决定快捷键修饰键的显示符号与默认键位口径。 */
  applePlatform: boolean;
  /** 动作链接偏好（权威态在 App，sidecar preferences 持久化）：只读 + 上抛增量。 */
  actionLinks: ActionLinksSettings;
  /** 行号/时间戳 gutter 偏好（权威态在 App）：只读 + 上抛增量。 */
  gutter: GutterSettings;
  /** 右键「在线搜索」引擎表原始文本（每行 name|url；权威态在 App，sidecar 持久化）。 */
  ctxSearchEngines: string;
  /** 背景图偏好（权威态在 App）：开关 / 透明度（10..=90 百分比）/ 会话内存态标记。 */
  wallpaperEnabled: boolean;
  wallpaperOpacity: number;
  wallpaperSessionOnly: boolean;
  /** 终端外观偏好（权威态在 App）：本组件只读 + 经 emits 上抛改动意图。 */
  appearance: TerminalAppearanceState;
  /** 用户保存的主题快照（内置预设由 lib 常量提供，不需经 props）。 */
  customThemes: TerminalAppearanceProfile[];
  /** 当前配置命中的主题 id（null = 已改动，不再等于任何主题）。 */
  activeThemeId: string | null;
  /** 宿主派生的基础终端主题（未启用配色方案时的最终结果）。 */
  hostTheme: TerminalThemeLike;
  hostColorScheme: "light" | "dark";
  /** 下载偏好的读写适配器（权威态与 sidecar preferences 同步在 App）。 */
  downloadPrefs: {
    loadDir(): string;
    loadUseDefault(): boolean;
    loadConflict(): DownloadConflictPolicy;
    persistDir(value: string): void;
    persistUseDefault(value: boolean): void;
    persistConflict(value: DownloadConflictPolicy): void;
  };
  /** 上传并发 / 重复目标策略的读写适配器（权威态在 App，sidecar preferences 同步）。 */
  transferPrefs: {
    loadConcurrency(): number;
    loadDuplicatePolicy(): TransferDuplicatePolicy;
    persistConcurrency(value: number): void;
    persistDuplicatePolicy(value: TransferDuplicatePolicy): void;
    /** M14-B：会话级并发深度 / 兼容模式 / 文件名编码。 */
    loadMaxActive(): number;
    loadCompatMode(): boolean;
    loadNameEncoding(): SftpNameEncoding;
    persistMaxActive(value: number): void;
    persistCompatMode(value: boolean): void;
    persistNameEncoding(value: SftpNameEncoding): void;
    /** Issue #66：下载限速（KiB/s，0=不限速）。 */
    loadDownloadLimit(): number;
    persistDownloadLimit(value: number): void;
  };
  /** 命令输入建议（开关 + 查询长度上下限）的读写适配器，权威态同在 App。 */
  suggestionPrefs: {
    loadEnabled(): boolean;
    loadMinChars(): number;
    loadMaxChars(): number;
    persistEnabled(value: boolean): void;
    persistMinChars(value: number): void;
    persistMaxChars(value: number): void;
  };
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "update:profilesOpen", value: boolean): void;
  (e: "notice", message: string): void;
  (e: "error", cause: unknown): void;
  (e: "browse-download-dir"): void;
  (e: "update:webgl", value: boolean): void;
  /** RDP 是实验能力：App 仅同步工具栏入口的内存门。 */
  (e: "update:rdpExperimental", value: boolean): void;
  /** 行内 ghost 自动建议开关（组件自治持久化 pluginStore，App 只同步内存态）。 */
  (e: "update:ghostSuggest", value: boolean): void;
  /** 行为设置局部增量：App 侧会归一化 + 持久化 + 即时落地到 xterm 选项。 */
  (e: "update-behavior", patch: Partial<TerminalBehaviorSettings>): void;
  /** 快捷键整表替换（编辑器内部管理增删改，只上抛最终结果）。 */
  (e: "update-hotkeys", bindings: TerminalHotkeyBindings): void;
  (e: "apply-font", payload: { family: string | null; size: number }): void;
  (e: "update-appearance", patch: Partial<TerminalAppearanceSettings>): void;
  /** 动作链接设置增量：App 侧归一化 + sidecar 持久化 + 即时挂/摘 link provider。 */
  (e: "update:actionLinks", patch: { enabled?: boolean; matchers?: Partial<ActionLinkMatcherToggles> }): void;
  /** gutter 设置增量：App 侧归一化 + sidecar 持久化 + 即时挂/摘。 */
  (e: "update:gutter", patch: { showLineNumbers?: boolean; showTimestamps?: boolean; timestampFormat?: string }): void;
  /** 在线搜索引擎表整表替换：App 侧解析 + sidecar 持久化。 */
  (e: "update:ctxSearchEngines", value: string): void;
  /** 背景图：开关/透明度上抛增量；图片经本地读取 base64 后交 App 走 sidecar。 */
  (e: "update:wallpaperEnabled", value: boolean): void;
  (e: "update:wallpaperOpacity", value: number): void;
  (e: "set-wallpaper-image", image: { base64: string; mime: string }): void;
  (e: "clear-wallpaper"): void;
  (e: "apply-theme", theme: TerminalAppearanceProfile): void;
  (e: "save-theme", name: string): void;
  (e: "delete-theme", id: string): void;
  (e: "add-schemes", schemes: Array<Omit<TerminalColorScheme, "id" | "source">>): void;
  (e: "remove-scheme", id: string): void;
}>();

const t = props.t;

// 分类顺序对齐 Tabby 的设置页优先级：外观 / 配色方案 / 终端 / 快捷键 四个
// 终端相关分类排在最前（Tabby 把 Appearance 与 Color scheme 标为 prioritized），
// 之后才是本插件特有的 sudo / 智能体 / 传输 / 安全 / MCP。
const SETTINGS_CATEGORIES = [
  { id: "appearance", labelKey: "settingsNav.appearance" },
  { id: "scheme", labelKey: "settingsNav.scheme" },
  { id: "terminal", labelKey: "settingsNav.terminal" },
  { id: "hotkeys", labelKey: "settingsNav.hotkeys" },
  { id: "sudo", labelKey: "settingsNav.sudo" },
  { id: "agent", labelKey: "agentTerminalSection" },
  { id: "transfer", labelKey: "downloadSettings.title" },
  { id: "security", labelKey: "settingsNav.security" },
  { id: "mcp", labelKey: "mcpLimits.title" },
] as const;
type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];
const settingsCategory = ref<SettingsCategory>("appearance");

function onSettingsCategoryChange(value: string | number) {
  settingsCategory.value = value as SettingsCategory;
}

// reka Select 不接受空串 option value（空串 = 未选中占位）；空值选项用哨兵值双向映射。
const SELECT_EMPTY_SENTINEL = "__empty__";
const settingsLoading = ref(false);
const settingsLoadFailed = ref(false);
const settingsSaving = ref(false);
const settingsMeta = ref<SshSettings>();
const settingsDraft = reactive({
  quickSudo: true,
  sudoUsePty: false,
  sudoPassword: "",
  totpSecret: "",
  authFlowMode: "password_then_otp",
  passwordPromptHint: "",
  totpPromptHint: "",
  quickSudoProfileId: "",
  agentTerminalMode: "off",
  rememberedCommands: [] as string[],
});
const downloadDirDraft = ref("");
const downloadUseDefaultDraft = ref(props.downloadPrefs.loadUseDefault());
const downloadConflictDraft = ref<DownloadConflictPolicy>("rename");
// 上传并发（1..10，默认 3）与重复目标策略（P1-5）草稿；建议设置草稿（P1-1）。
const transferConcurrencyDraft = ref(String(props.transferPrefs.loadConcurrency()));
const transferDuplicateDraft = ref<TransferDuplicatePolicy>(props.transferPrefs.loadDuplicatePolicy());
// M14-B：会话并发深度（1-8）/ 兼容模式 / 文件名编码草稿。
const transferMaxActiveDraft = ref(String(props.transferPrefs.loadMaxActive()));
const transferDownloadLimitDraft = ref(String(props.transferPrefs.loadDownloadLimit()));
const sftpCompatModeDraft = ref(props.transferPrefs.loadCompatMode());
const sftpNameEncodingDraft = ref<SftpNameEncoding>(props.transferPrefs.loadNameEncoding());
const suggestionsEnabledDraft = ref(props.suggestionPrefs.loadEnabled());
const suggestionMinCharsDraft = ref(String(props.suggestionPrefs.loadMinChars()));
const suggestionMaxCharsDraft = ref(String(props.suggestionPrefs.loadMaxChars()));
// 全局 quick sudo 配置：列表与编辑表单状态（密钥只在提交时发送）。设置弹窗
// 内联 section 与独立 profiles 弹窗共存复用同一份状态。
const sudoProfiles = ref<SudoProfileView[]>([]);
const sudoProfilesLoading = ref(false);
const sudoProfilesError = ref("");
const profilesInlineOpen = ref(false);
const profileEditing = ref(false);
const profileSaving = ref(false);
const profileDraftHadPassword = ref(false);
const profileDraftHadTotp = ref(false);
const profileDraft = reactive({
  id: "",
  name: "",
  sudoPassword: "",
  totpSecret: "",
  authFlowMode: "password_then_otp",
  passwordPromptHint: "",
  totpPromptHint: "",
  sudoUsePty: false,
});
const boundProfile = computed(
  () => sudoProfiles.value.find((profile) => profile.id === settingsDraft.quickSudoProfileId),
);
const knownHosts = ref<KnownHostEntry[]>([]);
const knownHostsLoading = ref(false);
const knownHostsError = ref("");
const localKeys = ref<DiscoveredKey[]>([]);
const localKeysLoading = ref(false);
const localKeysError = ref("");
const mcpDraft = reactive({ readMiB: "", uploadMiB: "", downloadMiB: "", permissionMode: "autonomous", connectionScope: "" });
const mcpLoading = ref(false);
const mcpError = ref("");
const mcpSaving = ref(false);
const mcpInputsValid = computed(() => [mcpDraft.readMiB, mcpDraft.uploadMiB, mcpDraft.downloadMiB]
  .every((value) => /^\d+$/.test(value.trim()) && Number.parseInt(value.trim(), 10) > 0));

// AI 终端同步模式下拉随档位变化的说明文案（off/auto/strict 三键 hint）。
const agentTerminalModeHint = computed(() => t(
  settingsDraft.agentTerminalMode === "auto" ? "agentTerminalAutoHint"
  : settingsDraft.agentTerminalMode === "strict" ? "agentTerminalStrictHint"
  : "agentTerminalOffHint",
));

// 终端字体设置控件态（issue #31）：预设等宽字体 + 跟随宿主 + 自定义；哨兵值
// 只作选择器键使用，不会作为字体串写入（写入前映射回 null/真实字体串）。
const TERMINAL_FONT_FOLLOW_HOST = "__follow-host__";

// 背景图上传（P2-9）：本地 FileReader 读成 data URL，拆出 mime + 纯 base64
// 交 App 走 sidecar 落盘（web/docker 失败时 App 降级会话内存态）。客户端先做
// 8MiB 上限与 accept 类型粗校验，权威校验在 sidecar（魔数 + 大小）。
const WALLPAPER_MAX_BYTES = 8 * 1024 * 1024;
const wallpaperFileInput = ref<HTMLInputElement>();
function onWallpaperFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > WALLPAPER_MAX_BYTES) {
    emit("error", new Error(t("wallpaper.tooLarge")));
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : "";
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
    if (!match) {
      emit("error", new Error(t("wallpaper.invalidImage")));
      return;
    }
    emit("set-wallpaper-image", { base64: match[2], mime: match[1] });
  };
  reader.onerror = () => emit("error", new Error(t("wallpaper.invalidImage")));
  reader.readAsDataURL(file);
}
const TERMINAL_FONT_CUSTOM = "__custom__";
const TERMINAL_FONT_PRESETS: Array<{ value: string; label: string }> = [
  { value: "'JetBrains Mono', Consolas, monospace", label: "JetBrains Mono" },
  { value: "'Cascadia Code', 'Cascadia Mono', monospace", label: "Cascadia Code" },
  { value: "'Fira Code', monospace", label: "Fira Code" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro" },
  { value: "Menlo, Monaco, monospace", label: "Menlo" },
  { value: "Consolas, 'Courier New', monospace", label: "Consolas" },
  { value: "'DejaVu Sans Mono', monospace", label: "DejaVu Sans Mono" },
  { value: "monospace", label: "monospace" },
];
const terminalFontFamilyChoice = ref(TERMINAL_FONT_FOLLOW_HOST);
const terminalFontCustomDraft = ref("");
const terminalFontSizeDraft = ref(String(props.terminalFontSize));

// 字体控件回显当前覆盖态：初始化与应用/恢复默认后都会刷新，避免草稿漂移。
function syncFontControls(family: string | null, size: number) {
  if (!family) {
    terminalFontFamilyChoice.value = TERMINAL_FONT_FOLLOW_HOST;
    terminalFontCustomDraft.value = "";
  } else if (TERMINAL_FONT_PRESETS.some((preset) => preset.value === family)) {
    terminalFontFamilyChoice.value = family;
    terminalFontCustomDraft.value = "";
  } else {
    terminalFontFamilyChoice.value = TERMINAL_FONT_CUSTOM;
    terminalFontCustomDraft.value = family;
  }
  terminalFontSizeDraft.value = String(size);
}
syncFontControls(loadTerminalFontOverride().fontFamily, props.terminalFontSize);

// 设置页字体族下拉：跟随宿主/预设即时应用并持久化；选「自定义」时仅展开
// 输入框，待输入 @change 再应用（applyTerminalFontFromControls）。
function onTerminalFontFamilyChoice(choice: string) {
  terminalFontFamilyChoice.value = choice;
  if (choice === TERMINAL_FONT_CUSTOM) return;
  applyTerminalFont(choice === TERMINAL_FONT_FOLLOW_HOST ? null : choice, props.terminalFontSize);
}

function applyTerminalFontFromControls() {
  let family: string | null;
  if (terminalFontFamilyChoice.value === TERMINAL_FONT_CUSTOM) {
    const custom = terminalFontCustomDraft.value.trim();
    family = custom.length > 0 ? custom : null; // 空自定义视作跟随宿主
  } else if (terminalFontFamilyChoice.value === TERMINAL_FONT_FOLLOW_HOST) {
    family = null;
  } else {
    family = terminalFontFamilyChoice.value;
  }
  const parsed = Number(terminalFontSizeDraft.value);
  const size = Number.isFinite(parsed) && parsed > 0 ? clampFontSize(parsed, 0) : props.hostFontSize;
  applyTerminalFont(family, size);
}

// 恢复默认：并入「外观」分类的 resetAppearance（同一套默认值链路），
// 此处不再保留独立的字体重置入口。

/// 应用用户字体设置：应用侧（App）负责落到 xterm、持久化与 toast。
function applyTerminalFont(family: string | null, size: number) {
  emit("apply-font", { family, size });
  syncFontControls(family, size);
}

// ---------------------------------------------------------------------------
// 终端外观（配色方案 / 主题快照 / 字体间距 / 光标）
// ---------------------------------------------------------------------------
const appearanceSettings = computed(() => props.appearance.settings);
const appearanceProfiles = computed(() => allAppearanceProfiles({ ...props.appearance, customThemes: props.customThemes }));

// 预览与真实终端共用同一套纯函数合成：预览呈现的就是 xterm 实际拿到的主题，
// 不会出现「设置页好看、终端不对」的偏差。
const previewTheme = computed(() => applySchemeToTerminalTheme(
  props.hostTheme,
  appearanceSettings.value,
  props.appearance.customSchemes,
  props.hostColorScheme,
));
const previewOptions = computed(() => terminalOptionPatch(appearanceSettings.value));
const previewFontFamily = computed(() => props.appearance.font.family ?? props.hostFontFamily);
const previewContrast = computed(() => {
  const foreground = parseHexColor(previewTheme.value.foreground);
  const background = parseHexColor(previewTheme.value.background);
  return foreground && background ? contrastRatio(foreground, background) : 21;
});

const allSchemes = computed<readonly TerminalColorScheme[]>(() => [...BUILTIN_TERMINAL_SCHEMES, ...props.appearance.customSchemes]);
const themeNameDraft = ref("");
const importText = ref("");
const importError = ref("");
const importOpen = ref(false);
const schemeFileInput = ref<HTMLInputElement>();

function updateAppearance(patch: Partial<TerminalAppearanceSettings>) {
  emit("update-appearance", patch);
}

/** 数值型外观字段：留空 = 恢复默认（null 回落到 xterm 既有默认），非法输入不落地。 */
function updateAppearanceNumber(key: keyof TerminalAppearanceSettings, raw: string) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    updateAppearance({ [key]: null } as Partial<TerminalAppearanceSettings>);
    return;
  }
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) updateAppearance({ [key]: parsed } as Partial<TerminalAppearanceSettings>);
}

// reka Select 不接受空串 value，字重的「默认」用哨兵值双向映射。
const FONT_WEIGHT_AUTO = "__auto__";
const FONT_WEIGHT_OPTIONS = ["300", "400", "500", "600", "700", "800", "900"];

function updateFontWeight(key: "fontWeight" | "fontWeightBold", value: unknown) {
  const next = String(value);
  updateAppearance({ [key]: next === FONT_WEIGHT_AUTO ? null : Number(next) });
}

function applyTheme(theme: TerminalAppearanceProfile) {
  emit("apply-theme", theme);
}

function resetAppearance() {
  // 复用「跟随 DBX 宿主」预设：设置重置与字体回跟随宿主走同一条链路，
  // 不另写一份默认值展开，避免两处默认值漂移。
  emit("apply-theme", TERMINAL_APPEARANCE_PRESETS[0]);
}

function saveCurrentTheme() {
  const name = themeNameDraft.value.trim();
  if (!name) return;
  emit("save-theme", name);
  themeNameDraft.value = "";
}

function deleteTheme(theme: TerminalAppearanceProfile) {
  if (!window.confirm(t("terminalAppearance.deleteThemeConfirm", { name: t(theme.name) }))) return;
  emit("delete-theme", theme.id);
}

function removeCustomScheme(scheme: TerminalColorScheme) {
  if (!window.confirm(t("terminalAppearance.importRemoveConfirm", { name: scheme.name }))) return;
  emit("remove-scheme", scheme.id);
}

// 导入：粘贴文本或选文件。解析是纯逻辑（terminalScheme.parseSchemeImport），
// 分配 id / 持久化 / 提示交给 App（权威态在 App）。
function importSchemesFromText(text: string, fallbackName: string) {
  const result = parseSchemeImport(text, fallbackName);
  if (!result.schemes.length) {
    importError.value = t("terminalAppearance.importEmpty");
    return;
  }
  importError.value = "";
  importText.value = "";
  emit("add-schemes", result.schemes);
}

function submitImport() {
  if (!importText.value.trim()) return;
  importSchemesFromText(importText.value, "Imported scheme");
}

function pickSchemeFile() {
  schemeFileInput.value?.click();
}

async function onSchemeFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    // iTerm2/.itermcolors 与 Windows Terminal 导出都是文本，File API 读原文即可，
    // 不依赖宿主 fileTransfer（web/docker 模式同样可用）。
    const text = await file.text();
    importSchemesFromText(text, file.name.replace(/\.[^.]+$/, ""));
  } catch (cause) {
    importError.value = settingsErrorOf(cause);
  } finally {
    // 清空 value：同一个文件连续选两次也要能再次触发 change。
    input.value = "";
  }
}

const CURSOR_STYLES: readonly TerminalCursorStyle[] = ["bar", "block", "underline"];
const CURSOR_INACTIVE_STYLES: readonly TerminalCursorInactiveStyle[] = ["outline", "block", "bar", "underline", "none"];
const CURSOR_STYLE_LABELS: Record<TerminalCursorStyle, string> = {
  bar: "terminalAppearance.cursorBar",
  block: "terminalAppearance.cursorBlock",
  underline: "terminalAppearance.cursorUnderline",
};
const CURSOR_INACTIVE_LABELS: Record<TerminalCursorInactiveStyle, string> = {
  outline: "terminalAppearance.inactiveOutline",
  block: "terminalAppearance.inactiveBlock",
  bar: "terminalAppearance.inactiveBar",
  underline: "terminalAppearance.inactiveUnderline",
  none: "terminalAppearance.inactiveNone",
};

// reka Select 回传 AcceptableValue（含 null 与对象），这里只接受字符串形态。
function updateCursorStyle(value: unknown) {
  updateAppearance({ cursorStyle: String(value) as TerminalCursorStyle });
}

function updateCursorInactiveStyle(value: unknown) {
  updateAppearance({ cursorInactiveStyle: String(value) as TerminalCursorInactiveStyle });
}

/** 数值输入框取原始串（模板里避免写 as 断言，TS 模板表达式支持有限）。 */
function numberFieldValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

// 单选组在模板里迭代（写死 `as const` 字面量在模板表达式中不被支持）。
const SCHEME_SOURCES: Array<{ value: TerminalAppearanceSettings["schemeSource"]; label: string }> = [
  { value: "host", label: "terminalAppearance.modeFollowHost" },
  { value: "custom", label: "terminalAppearance.modeCustom" },
];
const BACKGROUND_SOURCES: Array<{ value: TerminalAppearanceSettings["backgroundSource"]; label: string }> = [
  { value: "scheme", label: "terminalAppearance.backgroundScheme" },
  { value: "host", label: "terminalAppearance.backgroundHost" },
];

/** 终端行为枚举 → i18n key。模板按 lib 的常量数组顺序迭代，渲染单选组。 */
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

// 行为设置只上抛增量：归一化、持久化与落地到 xterm 选项全在 App，
// 保证「权威态唯一」——本组件不持有行为设置的副本，重开弹窗也不会出现回显漂移。
function updateBehavior(patch: Partial<TerminalBehaviorSettings>) {
  emit("update-behavior", patch);
}

/** 数字输入框 → 行为字段：空串或非数值直接忽略，避免清空输入框把值打成 NaN。 */
function updateScrollback(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return;
  updateBehavior({ scrollbackLines: value });
}

/** 快捷键整表替换：编辑器内部管草稿，只把最终结果上抛给 App 持久化。 */
function updateHotkeys(bindings: TerminalHotkeyBindings) {
  emit("update-hotkeys", bindings);
}

// 动作链接/gutter 与行为设置同款增量语义：本组件不持副本，重开弹窗无回显漂移。
function updateActionLinks(patch: { enabled?: boolean; matchers?: Partial<ActionLinkMatcherToggles> }) {
  emit("update:actionLinks", patch);
}

function updateGutter(patch: { showLineNumbers?: boolean; showTimestamps?: boolean; timestampFormat?: string }) {
  emit("update:gutter", patch);
}

/** 单个匹配器开关：reka Switch 回传 boolean | string，收紧为布尔再上抛。 */
function updateMatcher(key: keyof ActionLinkMatcherToggles, value: unknown) {
  updateActionLinks({ matchers: { [key]: value === true } });
}

/** 时间戳格式输入：空串回退默认格式（输入中途清空不落空格式）。 */
function updateGutterFormat(raw: string) {
  const trimmed = raw.trim();
  updateGutter({ timestampFormat: trimmed || GUTTER_TIMESTAMP_DEFAULT_FORMAT });
}

/** 三类匹配器开关按常量数组迭代（模板不支持 as const 字面量迭代）。 */
const ACTION_LINK_MATCHER_ROWS: Array<{ key: keyof ActionLinkMatcherToggles; label: string }> = [
  { key: "ipv4", label: "actionLinks.ipv4" },
  { key: "hostPort", label: "actionLinks.hostPort" },
  { key: "archive", label: "actionLinks.archive" },
];

/** 文本输入框取原始串（同 numberFieldValue，避免在模板里写 as 断言）。 */
function textFieldValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

/** reka Select 回传 AcceptableValue（含 null 与对象），这里只接受字符串形态。 */
function updateLinkModifier(value: unknown) {
  updateBehavior({ linkModifier: String(value) as TerminalLinkModifier });
}

async function reloadSettings() {
  downloadDirDraft.value = props.downloadPrefs.loadDir();
  downloadUseDefaultDraft.value = props.downloadPrefs.loadUseDefault();
  downloadConflictDraft.value = props.downloadPrefs.loadConflict();
  transferConcurrencyDraft.value = String(props.transferPrefs.loadConcurrency());
  transferDuplicateDraft.value = props.transferPrefs.loadDuplicatePolicy();
  transferMaxActiveDraft.value = String(props.transferPrefs.loadMaxActive());
  transferDownloadLimitDraft.value = String(props.transferPrefs.loadDownloadLimit());
  sftpCompatModeDraft.value = props.transferPrefs.loadCompatMode();
  sftpNameEncodingDraft.value = props.transferPrefs.loadNameEncoding();
  suggestionsEnabledDraft.value = props.suggestionPrefs.loadEnabled();
  suggestionMinCharsDraft.value = String(props.suggestionPrefs.loadMinChars());
  suggestionMaxCharsDraft.value = String(props.suggestionPrefs.loadMaxChars());
  if (settingsLoading.value || settingsSaving.value) return;
  settingsLoading.value = true;
  settingsLoadFailed.value = false;
  settingsMeta.value = undefined;
  // 每次打开都回到收起态，并丢弃上次遗留的内联编辑草稿：
  // 主「保存」会串行提交未保存的 profile 编辑，不能把陈旧草稿静默入库。
  profilesInlineOpen.value = false;
  cancelProfileEdit();
  void loadKnownHosts();
  void loadLocalKeys();
  void loadMcpSettings();
  void loadSudoProfiles();
  void loadStartupCommands();
  void loadConnNameEncoding();
  try {
    // revealSecrets: 预填已存原值（原始凭据串），避免只能看到"已配置"占位。
    const meta = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/get", { sessionId: props.sessionId, revealSecrets: true });
    settingsMeta.value = meta;
    settingsDraft.quickSudo = meta.quickSudo;
    settingsDraft.sudoUsePty = meta.sudoUsePty;
    settingsDraft.authFlowMode = meta.authFlowMode || "password_then_otp";
    settingsDraft.passwordPromptHint = meta.passwordPromptHint || "";
    settingsDraft.totpPromptHint = meta.totpPromptHint || "";
    settingsDraft.quickSudoProfileId = meta.quickSudoProfileId || "";
    const agentMode = meta.agentTerminalMode;
    settingsDraft.agentTerminalMode = agentMode && (AGENT_MODES as readonly string[]).includes(agentMode) ? agentMode : "off";
    settingsDraft.rememberedCommands = sanitizeRememberedCommands(meta.rememberedCommands);
    settingsDraft.sudoPassword = meta.sudoPassword || "";
    settingsDraft.totpSecret = meta.totpSecret || "";
  } catch {
    settingsLoadFailed.value = true;
  } finally {
    settingsLoading.value = false;
  }
}

watch(() => props.open, (open) => {
  if (open) void reloadSettings();
});

// 弹窗开着时活跃会话切到另一连接：启动命令区按新 connectionId 重新回显。
watch(() => props.connectionId, () => {
  if (props.open) {
    void loadStartupCommands();
    void loadConnNameEncoding();
  }
});

watch(() => props.profilesOpen, (open) => {
  if (!open) return;
  profileEditing.value = false;
  resetProfileDraft();
  void loadSudoProfiles();
});

async function loadSudoProfiles() {
  sudoProfilesLoading.value = true;
  sudoProfilesError.value = "";
  try {
    const result = await window.dbxPlugin.invoke<{ profiles: SudoProfileView[] }>("sudo/profiles/list", {});
    sudoProfiles.value = result.profiles;
  } catch (cause) {
    sudoProfiles.value = [];
    sudoProfilesError.value = settingsErrorOf(cause);
  } finally {
    sudoProfilesLoading.value = false;
  }
}

function flowModeLabel(mode: string) {
  if (mode === "off") return t("flowOff");
  if (mode === "password_only") return t("flowOnly");
  if (mode === "password_plus_otp") return t("flowPlusOtp");
  return t("flowThenOtp");
}

function profileSummary(profile: SudoProfileView) {
  return [
    `${t("settingsSudoPassword")}: ${profile.sudoPasswordSet ? t("settingsConfigured") : "—"}`,
    `${t("settingsTotp")}: ${profile.totpConfigured ? t("settingsConfigured") : "—"}`,
    t("settingsFlowMode") + ": " + flowModeLabel(profile.authFlowMode),
    profile.sudoUsePty ? t("settingsUsePty") : "",
  ].filter(Boolean).join(" · ");
}

function resetProfileDraft() {
  profileDraft.id = "";
  profileDraft.name = "";
  profileDraft.sudoPassword = "";
  profileDraft.totpSecret = "";
  profileDraft.authFlowMode = "password_then_otp";
  profileDraft.passwordPromptHint = "";
  profileDraft.totpPromptHint = "";
  profileDraft.sudoUsePty = false;
  profileDraftHadPassword.value = false;
  profileDraftHadTotp.value = false;
}

function startProfileCreate() {
  resetProfileDraft();
  profileEditing.value = true;
}

function startProfileEdit(profile: SudoProfileView) {
  resetProfileDraft();
  profileDraft.id = profile.id;
  profileDraft.name = profile.name;
  profileDraft.authFlowMode = profile.authFlowMode || "password_then_otp";
  profileDraft.passwordPromptHint = profile.passwordPromptHint || "";
  profileDraft.totpPromptHint = profile.totpPromptHint || "";
  profileDraft.sudoUsePty = profile.sudoUsePty;
  profileDraftHadPassword.value = profile.sudoPasswordSet;
  profileDraftHadTotp.value = profile.totpConfigured;
  profileEditing.value = true;
  // 回显已存原值供编辑（工作台专用 reveal 方法；失败保持占位提示）。
  if (profile.sudoPasswordSet || profile.totpConfigured) {
    const editingId = profile.id;
    void window.dbxPlugin
      .invoke<{ profile: { sudoPassword?: string; totpSecret?: string } }>("sudo/profiles/reveal", { id: editingId })
      .then((revealed) => {
        if (profileEditing.value && profileDraft.id === editingId) {
          profileDraft.sudoPassword = revealed.profile?.sudoPassword || "";
          profileDraft.totpSecret = revealed.profile?.totpSecret || "";
        }
      })
      .catch(() => undefined);
  }
}

async function saveProfileDraft() {
  if (profileSaving.value) return;
  const name = profileDraft.name.trim();
  if (!name) {
    sudoProfilesError.value = t("profilesNameRequired");
    return;
  }
  profileSaving.value = true;
  sudoProfilesError.value = "";
  try {
    const payload: Record<string, unknown> = {
      authFlowMode: profileDraft.authFlowMode,
      passwordPromptHint: profileDraft.passwordPromptHint,
      totpPromptHint: profileDraft.totpPromptHint,
      sudoUsePty: profileDraft.sudoUsePty,
    };
    if (profileDraft.id) payload.id = profileDraft.id;
    payload.name = name;
    if (profileDraft.sudoPassword) payload.sudoPassword = profileDraft.sudoPassword;
    if (profileDraft.totpSecret.trim()) payload.totpSecret = profileDraft.totpSecret;
    await window.dbxPlugin.invoke("sudo/profiles/save", payload);
    profileEditing.value = false;
    resetProfileDraft();
    await loadSudoProfiles();
    await refreshSettingsMeta();
    emit("notice", t("profilesSaved"));
  } catch (cause) {
    sudoProfilesError.value = settingsErrorOf(cause);
  } finally {
    profileSaving.value = false;
  }
}

async function removeProfile(profile: SudoProfileView) {
  if (!window.confirm(t("profilesDeleteConfirm", { name: profile.name }))) return;
  try {
    await window.dbxPlugin.invoke("sudo/profiles/delete", { id: profile.id });
    if (settingsDraft.quickSudoProfileId === profile.id) settingsDraft.quickSudoProfileId = "";
    await loadSudoProfiles();
    await refreshSettingsMeta();
    emit("notice", t("profilesDeleted"));
  } catch (cause) {
    sudoProfilesError.value = settingsErrorOf(cause);
  }
}

/// 取消内联 profile 编辑：关表单并清空草稿/错误（独立 profiles 弹窗、
/// 设置弹窗内联 section 与 Esc 关闭链共用同一语义）。
function cancelProfileEdit() {
  profileEditing.value = false;
  resetProfileDraft();
  sudoProfilesError.value = "";
}

/// 全局配置或其绑定变化后，刷新设置弹窗的只读摘要（会话内即时生效）。
async function refreshSettingsMeta() {
  if (!props.open || !props.sessionId) return;
  try {
    settingsMeta.value = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/get", { sessionId: props.sessionId });
  } catch {
    // 摘要刷新失败不打断主流程；重新打开设置时会再次加载。
  }
}

async function loadKnownHosts() {
  knownHostsLoading.value = true;
  knownHostsError.value = "";
  try {
    const result = await window.dbxPlugin.invoke<{ entries: KnownHostEntry[] }>("ssh/knownHosts/list", {});
    knownHosts.value = result.entries;
  } catch (cause) {
    knownHosts.value = [];
    knownHostsError.value = settingsErrorOf(cause);
  } finally {
    knownHostsLoading.value = false;
  }
}

async function removeKnownHost(entry: KnownHostEntry) {
  if (!window.confirm(t("knownHosts.removeConfirm", { host: `${entry.host}:${entry.port}` }))) return;
  try {
    await window.dbxPlugin.invoke("ssh/knownHosts/remove", { host: entry.host, port: entry.port });
    emit("notice", t("knownHosts.removed", { host: `${entry.host}:${entry.port}` }));
  } catch (cause) {
    knownHostsError.value = settingsErrorOf(cause);
  } finally {
    await loadKnownHosts();
  }
}

async function loadLocalKeys() {
  localKeysLoading.value = true;
  localKeysError.value = "";
  try {
    const result = await window.dbxPlugin.invoke<{ keys: DiscoveredKey[] }>("keys/discover", {});
    localKeys.value = result.keys.map((key) => ({ ...key, hasPassphrase: key.hasPassphrase ?? key.has_passphrase === true }));
  } catch (cause) {
    localKeys.value = [];
    localKeysError.value = settingsErrorOf(cause);
  } finally {
    localKeysLoading.value = false;
  }
}

async function loadMcpSettings() {
  mcpLoading.value = true;
  mcpError.value = "";
  try {
    const result = await window.dbxPlugin.invoke<McpSizeSettings>("mcp/settings/get", {});
    mcpDraft.readMiB = mibField(result.maxReadBytes);
    mcpDraft.uploadMiB = mibField(result.maxUploadBytes);
    mcpDraft.downloadMiB = mibField(result.maxDownloadBytes);
    // §1.3 新字段：旧 sidecar 不回时用默认（autonomous / 空=不限）。
    mcpDraft.permissionMode = result.execPermissionMode === "confirm" ? "confirm" : "autonomous";
    mcpDraft.connectionScope = Array.isArray(result.connectionScope) ? result.connectionScope.join("\n") : "";
  } catch (cause) {
    mcpError.value = settingsErrorOf(cause);
  } finally {
    mcpLoading.value = false;
  }
}

async function saveMcpSettings() {
  if (!mcpInputsValid.value || mcpSaving.value) return;
  mcpSaving.value = true;
  mcpError.value = "";
  try {
    await window.dbxPlugin.invoke("mcp/settings/set", {
      maxReadBytes: Number.parseInt(mcpDraft.readMiB.trim(), 10) * MIB,
      maxUploadBytes: Number.parseInt(mcpDraft.uploadMiB.trim(), 10) * MIB,
      maxDownloadBytes: Number.parseInt(mcpDraft.downloadMiB.trim(), 10) * MIB,
      // §1.3 MCP 权限档 + 连接作用域（每行一条，trim 去空后提交；旧 sidecar
      // 不识别新字段时整体报错，经 mcpError 容错展示）。
      execPermissionMode: mcpDraft.permissionMode === "confirm" ? "confirm" : "autonomous",
      connectionScope: mcpDraft.connectionScope.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    emit("notice", t("mcpLimits.saved"));
  } catch (cause) {
    mcpError.value = settingsErrorOf(cause);
  } finally {
    mcpSaving.value = false;
  }
}

/**
 * 一次保存链（设置弹窗主按钮）：① 未保存的 profile 编辑 → ② 连接设置 →
 * ③ MCP 限速。各步独立容错——saveProfileDraft/saveMcpSettings 内部已把失败
 * 写入 sudoProfilesError/mcpError 并展示，单步失败不阻断其余步骤；
 * MCP 表单非法时保持现有校验提示、静默跳过提交。
 */
async function saveSettings() {
  if (!props.sessionId || settingsSaving.value || settingsLoading.value || settingsLoadFailed.value || !settingsMeta.value) return;
  settingsSaving.value = true;
  try {
    props.downloadPrefs.persistDir(downloadDirDraft.value);
    props.downloadPrefs.persistUseDefault(downloadUseDefaultDraft.value);
    props.downloadPrefs.persistConflict(downloadConflictDraft.value);
    props.transferPrefs.persistConcurrency(Number.parseInt(transferConcurrencyDraft.value, 10) || 3);
    props.transferPrefs.persistDuplicatePolicy(transferDuplicateDraft.value);
    props.transferPrefs.persistMaxActive(Number.parseInt(transferMaxActiveDraft.value, 10) || 3);
    props.transferPrefs.persistDownloadLimit(Math.max(0, Number.parseInt(transferDownloadLimitDraft.value, 10) || 0));
    props.transferPrefs.persistCompatMode(sftpCompatModeDraft.value);
    props.transferPrefs.persistNameEncoding(sftpNameEncodingDraft.value);
    props.suggestionPrefs.persistEnabled(suggestionsEnabledDraft.value);
    props.suggestionPrefs.persistMinChars(Number.parseInt(suggestionMinCharsDraft.value, 10) || 2);
    props.suggestionPrefs.persistMaxChars(Number.parseInt(suggestionMaxCharsDraft.value, 10) || 64);
    if (profileEditing.value) await saveProfileDraft();
    const updates: Record<string, unknown> = {
      quickSudo: settingsDraft.quickSudo,
      sudoUsePty: settingsDraft.sudoUsePty,
      authFlowMode: settingsDraft.authFlowMode,
      passwordPromptHint: settingsDraft.passwordPromptHint,
      totpPromptHint: settingsDraft.totpPromptHint,
      quickSudoProfileId: settingsDraft.quickSudoProfileId,
      agentTerminalMode: settingsDraft.agentTerminalMode,
      rememberedCommands: sanitizeRememberedCommands(settingsDraft.rememberedCommands),
    };
    if (settingsDraft.sudoPassword) updates.sudoPassword = settingsDraft.sudoPassword;
    if (settingsDraft.totpSecret.trim()) updates.totpSecret = settingsDraft.totpSecret;
    const meta = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/set", { sessionId: props.sessionId, ...updates });
    settingsMeta.value = meta;
    settingsDraft.sudoPassword = "";
    settingsDraft.totpSecret = "";
    await saveMcpSettings();
    emit("notice", t("settingsSaved"));
  } catch (cause) {
    emit("error", cause);
  } finally {
    settingsSaving.value = false;
  }
}

async function clearStoredSecrets() {
  if (!props.sessionId || settingsSaving.value || settingsLoading.value || settingsLoadFailed.value || !settingsMeta.value) return;
  try {
    const meta = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/set", {
      sessionId: props.sessionId,
      sudoPassword: "",
      totpSecret: "",
    });
    settingsMeta.value = meta;
    emit("notice", t("settingsSecretsCleared"));
  } catch (cause) {
    emit("error", cause);
  }
}

/// Esc 分层退出：先关编辑表单，再收起配置档 section；返回 false 表示已到
/// 最底层，调用方（App Esc 链）应关闭整个弹窗。
function consumeInlineEsc(): boolean {
  if (profilesInlineOpen.value && profileEditing.value) {
    cancelProfileEdit();
    return true;
  }
  if (profilesInlineOpen.value) {
    profilesInlineOpen.value = false;
    return true;
  }
  return false;
}

/// 下载询问弹窗勾选「设为默认」/目录选择器回填后，App 同步设置页草稿
/// （弹窗开着也能立即看到）。
function setDownloadDirDraft(dir: string) {
  downloadDirDraft.value = dir;
}

function setDownloadUseDefaultDraft(value: boolean) {
  downloadUseDefaultDraft.value = value;
}

function shortFingerprint(fingerprint: string) {
  if (fingerprint.length <= 20) return fingerprint;
  return `${fingerprint.slice(0, 17)}…`;
}

defineExpose({ consumeInlineEsc, setDownloadDirDraft, setDownloadUseDefaultDraft });
</script>

<template>
    <!-- 设置主弹窗 -->
    <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
      <DialogContent class="modal settings-modal settings-nav-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("settings") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button></header>
        <div class="settings-body">
          <div v-if="settingsLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <div v-else-if="settingsLoadFailed" class="task-error" role="alert">
            {{ t("settingsLoadFailed") }}
            <button class="link-button" @click="reloadSettings">{{ t("refresh") }}</button>
          </div>
          <template v-else>
          <div class="settings-layout">
            <nav class="settings-nav" aria-label="settings categories">
              <Tabs :model-value="settingsCategory" orientation="vertical" class="settings-nav-tabs" @update:model-value="onSettingsCategoryChange">
                <TabsList class="settings-nav-list">
                  <TabsTrigger v-for="cat in SETTINGS_CATEGORIES" :key="cat.id" :value="cat.id" class="settings-nav-item">{{ t(cat.labelKey) }}</TabsTrigger>
                </TabsList>
              </Tabs>
            </nav>
            <div class="settings-content">
            <!-- 配色方案（对标 Tabby「Color scheme」页，从原「外观」里拆出）：主题
                 快照、实时预览、深浅两槽配色方案、终端背景来源、自定义方案导入。 -->
            <div v-show="settingsCategory === 'scheme'" class="settings-pane">
            <h3 class="settings-section-title">{{ t("terminalAppearance.themeSection") }}</h3>
            <p class="muted settings-note">{{ t("terminalAppearance.themeHint") }}</p>
            <div class="theme-chips">
              <button
                v-for="theme in appearanceProfiles"
                :key="theme.id"
                type="button"
                class="theme-chip"
                :class="{ active: theme.id === activeThemeId }"
                :aria-pressed="theme.id === activeThemeId"
                @click="applyTheme(theme)"
              >
                <Check v-if="theme.id === activeThemeId" class="theme-chip-icon" aria-hidden="true" />
                <span>{{ t(theme.name) }}</span>
                <span
                  v-if="!theme.builtin"
                  class="theme-chip-delete"
                  role="button"
                  tabindex="0"
                  :title="t('terminalAppearance.deleteTheme')"
                  :aria-label="t('terminalAppearance.deleteTheme')"
                  @click.stop="deleteTheme(theme)"
                  @keydown.enter.stop="deleteTheme(theme)"
                ><Trash2 /></span>
              </button>
              <span v-if="!activeThemeId" class="theme-chip theme-chip--dirty">{{ t("terminalAppearance.themeCustom") }}</span>
            </div>
            <div class="theme-save-row">
              <input v-model="themeNameDraft" spellcheck="false" :placeholder="t('terminalAppearance.themeNamePlaceholder')" />
              <button type="button" :disabled="!themeNameDraft.trim()" @click="saveCurrentTheme">{{ t("terminalAppearance.saveTheme") }}</button>
              <button type="button" @click="resetAppearance"><RotateCcw />{{ t("terminalAppearance.reset") }}</button>
            </div>

            <h3 class="settings-section-title">{{ t("terminalAppearance.previewTitle") }}</h3>
            <TerminalAppearancePreview
              :theme="previewTheme"
              :font-family="previewFontFamily"
              :font-size="terminalFontSize"
              :font-weight="previewOptions.fontWeight"
              :font-weight-bold="previewOptions.fontWeightBold"
              :line-height="previewOptions.lineHeight"
              :letter-spacing="previewOptions.letterSpacing"
              :cursor-style="previewOptions.cursorStyle"
              :cursor-blink="previewOptions.cursorBlink"
              :contrast-ratio="previewContrast"
              :t="t"
            />

            <h3 class="settings-section-title">{{ t("terminalAppearance.schemeSection") }}</h3>
            <p class="muted settings-note">{{ t("terminalAppearance.schemeHint") }}</p>
            <label v-for="option in SCHEME_SOURCES" :key="option.value" class="settings-field settings-radio-row">
              <input
                type="radio"
                name="terminal-scheme-source"
                :value="option.value"
                :checked="appearanceSettings.schemeSource === option.value"
                @change="updateAppearance({ schemeSource: option.value })"
              />
              <span>{{ t(option.label) }}</span>
            </label>
            <TerminalSchemePicker
              v-if="appearanceSettings.schemeSource === 'custom'"
              :dark-scheme-id="appearanceSettings.darkSchemeId"
              :light-scheme-id="appearanceSettings.lightSchemeId"
              :custom-schemes="appearance.customSchemes"
              :schemes="allSchemes"
              :host-follow-label="t('terminalAppearance.modeFollowHost')"
              :t="t"
              @pick="(payload) => updateAppearance(payload.slot === 'dark' ? { darkSchemeId: payload.id } : { lightSchemeId: payload.id })"
            />
            <template v-if="appearanceSettings.schemeSource === 'custom'">
              <h4 class="settings-section-title">{{ t("terminalAppearance.backgroundSection") }}</h4>
              <label v-for="option in BACKGROUND_SOURCES" :key="option.value" class="settings-field settings-radio-row">
                <input
                  type="radio"
                  name="terminal-background-source"
                  :value="option.value"
                  :checked="appearanceSettings.backgroundSource === option.value"
                  @change="updateAppearance({ backgroundSource: option.value })"
                />
                <span>{{ t(option.label) }}</span>
              </label>
              <p class="muted settings-note">{{ t("terminalAppearance.backgroundHint") }}</p>
            </template>

            <h4 class="settings-section-title">{{ t("terminalAppearance.importSection") }}</h4>
            <p class="muted settings-note">
              {{ t("terminalAppearance.importHint") }}
              <button class="link-button" type="button" :aria-expanded="importOpen" @click="importOpen = !importOpen">{{ t("terminalAppearance.importAction") }}</button>
            </p>
            <template v-if="importOpen">
              <label class="settings-field">
                <span>{{ t("terminalAppearance.importSection") }}</span>
                <textarea v-model="importText" rows="4" class="mono" spellcheck="false" :placeholder="t('terminalAppearance.importPlaceholder')" />
              </label>
              <div class="appearance-actions">
                <button type="button" :disabled="!importText.trim()" @click="submitImport"><Upload />{{ t("terminalAppearance.importAction") }}</button>
                <button type="button" @click="pickSchemeFile"><FolderOpen />{{ t("downloadSettings.browse") }}</button>
                <input
                  ref="schemeFileInput"
                  type="file"
                  class="hidden-file-input"
                  accept=".itermcolors,.json,.xresources,.yaml,.yml,.conf,.txt"
                  @change="onSchemeFile"
                />
              </div>
              <p v-if="importError" class="task-error" role="alert">{{ importError }}</p>
            </template>
            <ul v-if="appearance.customSchemes.length" class="settings-list">
              <li v-for="scheme in appearance.customSchemes" :key="scheme.id">
                <div class="settings-list-main">
                  <strong>{{ scheme.name }}</strong>
                  <span class="scheme-mini-swatch" aria-hidden="true"><i v-for="(color, index) in scheme.colors.slice(0, 16)" :key="index" :style="{ background: color }" /></span>
                </div>
                <button class="icon-button" :title="t('terminalAppearance.importRemove')" @click="removeCustomScheme(scheme)"><Trash2 /></button>
              </li>
            </ul>
            <p class="muted">{{ t("profilesLimit", { count: appearance.customSchemes.length, limit: CUSTOM_SCHEME_LIMIT }) }}</p>
            </div>

            <!-- 外观（对标 Tabby「Appearance」页）：字体与字号、字重/行高/字间距/内边距、
                 光标、渲染细项，末尾再放一次实时预览以便边调边看排版效果。 -->
            <div v-show="settingsCategory === 'appearance'" class="settings-pane">
            <h4 class="settings-section-title">{{ t("terminalAppearance.typographySection") }}</h4>
            <label class="settings-field">
              <span>{{ t("terminalFont.family") }}</span>
              <Select :model-value="terminalFontFamilyChoice" @update:model-value="(v) => onTerminalFontFamilyChoice(String(v))">
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="TERMINAL_FONT_FOLLOW_HOST">{{ t("terminalFont.followHost") }}</SelectItem>
                  <SelectItem v-for="preset in TERMINAL_FONT_PRESETS" :key="preset.value" :value="preset.value" class="terminal-font-option" :style="{ fontFamily: preset.value }">{{ preset.label }}</SelectItem>
                  <SelectItem :value="TERMINAL_FONT_CUSTOM">{{ t("terminalFont.custom") }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label v-if="terminalFontFamilyChoice === TERMINAL_FONT_CUSTOM" class="settings-field">
              <span>{{ t("terminalFont.custom") }}</span>
              <input v-model="terminalFontCustomDraft" class="mono" spellcheck="false" :placeholder="t('terminalFont.customPlaceholder')" @change="applyTerminalFontFromControls" />
            </label>
            <label class="settings-field">
              <span>{{ t("terminalFont.size") }}</span>
              <input v-model="terminalFontSizeDraft" type="number" :min="TERMINAL_FONT_MIN" :max="TERMINAL_FONT_MAX" step="1" @change="applyTerminalFontFromControls" />
            </label>
            <div class="appearance-number-grid">
              <label class="settings-field">
                <span>{{ t("terminalAppearance.fontWeight") }}</span>
                <Select :model-value="appearanceSettings.fontWeight == null ? FONT_WEIGHT_AUTO : String(appearanceSettings.fontWeight)" @update:model-value="(v) => updateFontWeight('fontWeight', v)">
                  <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="FONT_WEIGHT_AUTO">{{ t("terminalAppearance.valueAuto") }}</SelectItem>
                    <SelectItem v-for="weight in FONT_WEIGHT_OPTIONS" :key="weight" :value="weight">{{ weight }}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label class="settings-field">
                <span>{{ t("terminalAppearance.fontWeightBold") }}</span>
                <Select :model-value="appearanceSettings.fontWeightBold == null ? FONT_WEIGHT_AUTO : String(appearanceSettings.fontWeightBold)" @update:model-value="(v) => updateFontWeight('fontWeightBold', v)">
                  <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="FONT_WEIGHT_AUTO">{{ t("terminalAppearance.valueAuto") }}</SelectItem>
                    <SelectItem v-for="weight in FONT_WEIGHT_OPTIONS" :key="weight" :value="weight">{{ weight }}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label class="settings-field">
                <span>{{ t("terminalAppearance.lineHeight") }}</span>
                <input type="number" min="1" max="3" step="0.05" :value="appearanceSettings.lineHeight ?? ''" :placeholder="t('terminalAppearance.valueAuto')" @change="updateAppearanceNumber('lineHeight', numberFieldValue($event))" />
              </label>
              <label class="settings-field">
                <span>{{ t("terminalAppearance.letterSpacing") }}</span>
                <input type="number" min="-5" max="10" step="1" :value="appearanceSettings.letterSpacing ?? ''" :placeholder="t('terminalAppearance.valueAuto')" @change="updateAppearanceNumber('letterSpacing', numberFieldValue($event))" />
              </label>
              <label class="settings-field">
                <span>{{ t("terminalAppearance.paddingX") }}</span>
                <input type="number" min="0" max="32" step="1" :value="appearanceSettings.paddingX ?? ''" :placeholder="t('terminalAppearance.valueAuto')" @change="updateAppearanceNumber('paddingX', numberFieldValue($event))" />
              </label>
              <label class="settings-field">
                <span>{{ t("terminalAppearance.paddingY") }}</span>
                <input type="number" min="0" max="32" step="1" :value="appearanceSettings.paddingY ?? ''" :placeholder="t('terminalAppearance.valueAuto')" @change="updateAppearanceNumber('paddingY', numberFieldValue($event))" />
              </label>
            </div>
            <p class="muted settings-note">{{ t("terminalAppearance.paddingHint") }}</p>

            <h4 class="settings-section-title">{{ t("terminalAppearance.cursorSection") }}</h4>
            <label class="settings-field">
              <span>{{ t("terminalAppearance.cursorStyle") }}</span>
              <Select :model-value="appearanceSettings.cursorStyle" @update:model-value="updateCursorStyle">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="style in CURSOR_STYLES" :key="style" :value="style">{{ t(CURSOR_STYLE_LABELS[style]) }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label class="quick-sudo-control">
              <Switch size="sm" :model-value="appearanceSettings.cursorBlink" @update:model-value="(v) => updateAppearance({ cursorBlink: v === true })" />
              <span>{{ t("terminalAppearance.cursorBlink") }}</span>
            </label>
            <label class="settings-field">
              <span>{{ t("terminalAppearance.cursorInactive") }}</span>
              <Select :model-value="appearanceSettings.cursorInactiveStyle" @update:model-value="updateCursorInactiveStyle">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="style in CURSOR_INACTIVE_STYLES" :key="style" :value="style">{{ t(CURSOR_INACTIVE_LABELS[style]) }}</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <h4 class="settings-section-title">{{ t("terminalAppearance.renderSection") }}</h4>
            <label class="quick-sudo-control">
              <Switch size="sm" :model-value="appearanceSettings.drawBoldTextInBrightColors" @update:model-value="(v) => updateAppearance({ drawBoldTextInBrightColors: v === true })" />
              <span>{{ t("terminalAppearance.drawBoldInBright") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalAppearance.drawBoldInBrightHint") }}</p>
            <label class="settings-field">
              <span>{{ t("terminalAppearance.minimumContrast") }}</span>
              <input type="number" min="1" max="21" step="0.5" :value="appearanceSettings.minimumContrastRatio" @change="updateAppearanceNumber('minimumContrastRatio', numberFieldValue($event))" />
            </label>
            <p class="muted settings-note">{{ t("terminalAppearance.minimumContrastHint") }}</p>

            <h4 class="settings-section-title">{{ t("wallpaper.sectionTitle") }}</h4>
            <label class="quick-sudo-control">
              <Switch size="sm" :model-value="wallpaperEnabled" @update:model-value="(v) => emit('update:wallpaperEnabled', v === true)" />
              <span>{{ t("wallpaper.enabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("wallpaper.enabledHint") }}</p>
            <template v-if="wallpaperEnabled">
              <div class="appearance-actions">
                <button type="button" @click="wallpaperFileInput?.click()"><Upload />{{ t("wallpaper.upload") }}</button>
                <button type="button" @click="emit('clear-wallpaper')"><Trash2 />{{ t("wallpaper.clear") }}</button>
              </div>
              <input ref="wallpaperFileInput" class="hidden-file-input" type="file" accept="image/png,image/jpeg,image/webp" @change="onWallpaperFileChange" />
              <label class="settings-field">
                <span>{{ t("wallpaper.opacity") }}</span>
                <input type="range" min="10" max="90" step="5" :value="wallpaperOpacity" @change="emit('update:wallpaperOpacity', Number(($event.target as HTMLInputElement).value))" />
              </label>
              <p class="muted settings-note">{{ t("wallpaper.limitHint") }}</p>
              <p v-if="wallpaperSessionOnly" class="muted settings-note">{{ t("wallpaper.sessionOnly") }}</p>
            </template>

            <h4 class="settings-section-title">{{ t("terminalAppearance.previewTitle") }}</h4>
            <!-- 与「配色方案」页共用同一个纯展示预览组件：两处 props 必须保持一致，
                 它是无状态无 id 的纯 DOM 复刻，实例化两次没有额外副作用。 -->
            <TerminalAppearancePreview
              :theme="previewTheme"
              :font-family="previewFontFamily"
              :font-size="terminalFontSize"
              :font-weight="previewOptions.fontWeight"
              :font-weight-bold="previewOptions.fontWeightBold"
              :line-height="previewOptions.lineHeight"
              :letter-spacing="previewOptions.letterSpacing"
              :cursor-style="previewOptions.cursorStyle"
              :cursor-blink="previewOptions.cursorBlink"
              :contrast-ratio="previewContrast"
              :t="t"
            />
            </div>

            <div v-show="settingsCategory === 'sudo'" class="settings-pane">
            <label class="settings-field">
              <span>{{ t("settingsCredentialSource") }}</span>
              <span class="credential-source-row">
                <Select :model-value="settingsDraft.quickSudoProfileId || SELECT_EMPTY_SENTINEL" @update:model-value="(v) => (settingsDraft.quickSudoProfileId = v === SELECT_EMPTY_SENTINEL ? '' : String(v))">
                  <SelectTrigger size="xs" class="credential-source-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="SELECT_EMPTY_SENTINEL">{{ t("profileSourceConnection") }}</SelectItem>
                    <SelectItem v-for="profile in sudoProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}</SelectItem>
                  </SelectContent>
                </Select>
                <!-- 内联管理入口：展开/收起下方配置档 section，不再跳独立弹窗（工具栏 KeyRound 仍保留独立弹窗）。 -->
                <button class="link-button" :aria-expanded="profilesInlineOpen" @click="profilesInlineOpen = !profilesInlineOpen">{{ t("profilesManage") }}</button>
              </span>
            </label>
            <p v-if="boundProfile" class="muted settings-note">{{ t("profilesBoundSummary", { name: boundProfile.name }) }} · {{ profileSummary(boundProfile) }}</p>
            <!-- 内联 quick sudo 配置档管理：列表 + 新增/编辑同表单状态
                 （sudoProfiles/profileDraft/... 与独立 profiles 弹窗共用），主「保存」串行提交。 -->
            <section v-if="profilesInlineOpen" class="profiles-inline">
              <h3 class="settings-section-title">{{ t("profilesTitle") }}</h3>
              <p class="muted">{{ t("profilesHint") }}</p>
              <div v-if="sudoProfilesLoading && !sudoProfiles.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
              <div v-else-if="!sudoProfiles.length" class="empty compact">{{ t("profilesEmpty") }}</div>
              <ul v-else class="settings-list">
                <li v-for="profile in sudoProfiles" :key="profile.id">
                  <div class="settings-list-main">
                    <strong>{{ profile.name }}</strong>
                    <span class="muted">{{ profileSummary(profile) }}</span>
                  </div>
                  <span class="settings-list-actions">
                    <button class="icon-button" :title="t('profilesEdit')" @click="startProfileEdit(profile)"><Pencil /></button>
                    <button class="icon-button" :title="t('profilesDelete')" @click="removeProfile(profile)"><Trash2 /></button>
                  </span>
                </li>
              </ul>
              <p class="muted">{{ t("profilesLimit", { count: sudoProfiles.length, limit: 20 }) }}</p>
              <button v-if="!profileEditing" class="link-button" @click="startProfileCreate">{{ t("profilesAdd") }}</button>
              <template v-if="profileEditing">
                <h4 class="settings-section-title">{{ profileDraft.id ? t("profilesEdit") : t("profilesAdd") }}</h4>
                <label class="settings-field">
                  <span>{{ t("profilesName") }}</span>
                  <input v-model="profileDraft.name" spellcheck="false" :placeholder="t('profilesNamePlaceholder')" />
                </label>
                <label class="settings-field">
                  <span>{{ t("profilesPassword") }}</span>
                  <input v-model="profileDraft.sudoPassword" type="password" autocomplete="off" :placeholder="profileDraftHadPassword ? t('profilesPasswordKeep') : t('settingsSudoPasswordPlaceholder')" />
                </label>
                <label class="settings-field">
                  <span>{{ t("settingsTotp") }}</span>
                  <textarea v-model="profileDraft.totpSecret" rows="2" spellcheck="false" :placeholder="profileDraftHadTotp ? t('settingsConfigured') : t('settingsTotpPlaceholder')" />
                </label>
                <label class="settings-field">
                  <span>{{ t("settingsFlowMode") }}</span>
                  <Select :model-value="profileDraft.authFlowMode" @update:model-value="(v) => (profileDraft.authFlowMode = String(v))">
                    <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">{{ t("flowOff") }}</SelectItem>
                      <SelectItem value="password_then_otp">{{ t("flowThenOtp") }}</SelectItem>
                      <SelectItem value="password_plus_otp">{{ t("flowPlusOtp") }}</SelectItem>
                      <SelectItem value="password_only">{{ t("flowOnly") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label class="settings-field">
                  <span>{{ t("settingsPasswordHint") }}</span>
                  <input v-model="profileDraft.passwordPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
                </label>
                <label class="settings-field">
                  <span>{{ t("settingsTotpHint") }}</span>
                  <input v-model="profileDraft.totpPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
                </label>
                <label class="quick-sudo-control">
                  <Switch v-model="profileDraft.sudoUsePty" size="sm" />
                  <span>{{ t("settingsUsePty") }}</span>
                </label>
                <p v-if="sudoProfilesError" class="task-error">{{ sudoProfilesError }}</p>
                <footer class="profiles-form-actions">
                  <button @click="cancelProfileEdit">{{ t("cancel") }}</button>
                  <button class="primary-button" :disabled="profileSaving || !profileDraft.name.trim()" @click="saveProfileDraft"><Loader2 v-if="profileSaving" class="spinning" />{{ t("save") }}</button>
                </footer>
              </template>
            </section>
            <label class="quick-sudo-control">
              <Switch v-model="settingsDraft.quickSudo" size="sm" />
              <span>{{ t("settingsQuickSudo") }}</span>
            </label>
            <template v-if="!boundProfile">
            <label class="settings-field">
              <span>{{ t("settingsSudoPassword") }}</span>
              <input v-model="settingsDraft.sudoPassword" type="password" autocomplete="off" :placeholder="settingsMeta?.sudoPasswordSet ? t('settingsConfigured') : t('settingsSudoPasswordPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsTotp") }}</span>
              <textarea v-model="settingsDraft.totpSecret" rows="2" spellcheck="false" :placeholder="settingsMeta?.totpConfigured ? t('settingsConfigured') : t('settingsTotpPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsFlowMode") }}</span>
              <Select :model-value="settingsDraft.authFlowMode" @update:model-value="(v) => (settingsDraft.authFlowMode = String(v))">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{{ t("flowOff") }}</SelectItem>
                  <SelectItem value="password_then_otp">{{ t("flowThenOtp") }}</SelectItem>
                  <SelectItem value="password_plus_otp">{{ t("flowPlusOtp") }}</SelectItem>
                  <SelectItem value="password_only">{{ t("flowOnly") }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p class="muted settings-note">{{ t("settingsFlowHint") }}</p>
            <label class="settings-field">
              <span>{{ t("settingsPasswordHint") }}</span>
              <input v-model="settingsDraft.passwordPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsTotpHint") }}</span>
              <input v-model="settingsDraft.totpPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
            </label>
            <label class="quick-sudo-control">
              <Switch v-model="settingsDraft.sudoUsePty" size="sm" />
              <span>{{ t("settingsUsePty") }}</span>
            </label>
            </template>
            <p v-if="sudoProfilesError" class="task-error">{{ sudoProfilesError }} <button class="link-button" @click="loadSudoProfiles">{{ t("refresh") }}</button></p>
            <p class="muted settings-note">{{ t("settingsNote") }}</p>
            </div>

            <div v-show="settingsCategory === 'agent'" class="settings-pane">
            <h3 class="settings-section-title">{{ t("agentTerminalSection") }}</h3>
            <label class="settings-field">
              <span>{{ t("agentTerminalMode") }}</span>
              <Select :model-value="settingsDraft.agentTerminalMode" @update:model-value="(v) => (settingsDraft.agentTerminalMode = String(v))">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="mode in AGENT_MODES" :key="mode" :value="mode">{{ t(`agentTerminal${mode === "off" ? "Off" : mode === "auto" ? "Auto" : "Strict"}`) }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p class="muted settings-note">{{ agentTerminalModeHint }}</p>
            <div class="settings-remembered">
              <h4 class="settings-section-title">{{ t("settingsRemembered.section") }}</h4>
              <label class="settings-field"><span>{{ t("settingsRemembered.label") }}</span></label>
              <p v-if="!settingsDraft.rememberedCommands.length" class="muted settings-note">{{ t("settingsRemembered.empty") }}</p>
              <ul v-else class="remembered-list">
                <li v-for="(line, index) in settingsDraft.rememberedCommands" :key="`${index}-${line}`" class="remembered-row">
                  <code class="mono remembered-line">{{ line }}</code>
                  <button class="link-button" type="button" @click="settingsDraft.rememberedCommands.splice(index, 1)">{{ t("settingsRemembered.remove") }}</button>
                </li>
              </ul>
              <p class="muted settings-note">{{ t("settingsRemembered.hint") }}</p>
            </div>
            </div>

            <div v-show="settingsCategory === 'transfer'" class="settings-pane">
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
            <h3 class="settings-section-title">{{ t("transferCfg.title") }}</h3>
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
            </div>

            <!-- 终端（对标 Tabby「Terminal」页）：渲染 / 键盘 / 鼠标 / 剪贴板 / 声音五组。
                 只上抛增量，归一化与落地在 App；每项默认值都复现改动前的行为。 -->
            <div v-show="settingsCategory === 'terminal'" class="settings-pane">
            <h3 class="settings-section-title">{{ t("terminalBehavior.renderingSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="webglEnabled" @update:model-value="(value) => emit('update:webgl', value === true)" />
              <span>{{ t("webglLabel") }}</span>
            </label>
            <p class="muted settings-note">{{ t("webglHint") }}</p>
            <label class="settings-field">
              <span>{{ t("terminalBehavior.scrollbackLines") }}</span>
              <input type="number" :min="SCROLLBACK_MIN" :max="SCROLLBACK_MAX" step="100" :value="terminalBehavior.scrollbackLines" @change="updateScrollback(numberFieldValue($event))" />
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.scrollbackHint") }}</p>

            <h3 class="settings-section-title">{{ t("terminalBehavior.keyboardSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch size="sm" :model-value="terminalBehavior.altIsMeta" @update:model-value="(v) => updateBehavior({ altIsMeta: v === true })" />
              <span>{{ t("terminalBehavior.altIsMeta") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalBehavior.altIsMetaHint") }}</p>
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
              <textarea class="mono" rows="4" spellcheck="false" :value="ctxSearchEngines" @change="emit('update:ctxSearchEngines', ($event.target as HTMLTextAreaElement).value)"></textarea>
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
                    <button class="icon-button" :disabled="index === 0" :title="t('startupCommands.moveUp')" @click="moveStartupEntry(index, -1)"><ArrowUp /></button>
                    <button class="icon-button" :disabled="index === startupCommands.length - 1" :title="t('startupCommands.moveDown')" @click="moveStartupEntry(index, 1)"><ArrowDown /></button>
                    <button class="icon-button" :title="t('startupCommands.remove')" @click="removeStartupEntry(index)"><Trash2 /></button>
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

            <h3 class="settings-section-title">{{ t("suggestions.settingsTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch v-model="suggestionsEnabledDraft" size="sm" />
              <span>{{ t("suggestions.settingsEnabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("suggestions.settingsEnabledHint") }}</p>
            <label class="settings-field">
              <span>{{ t("suggestions.settingsMinChars") }}</span>
              <input v-model="suggestionMinCharsDraft" type="number" min="1" max="16" step="1" @change="suggestionMinCharsDraft = String(Math.min(16, Math.max(1, Number.parseInt(suggestionMinCharsDraft, 10) || 2)))" />
            </label>
            <p class="muted settings-note">{{ t("suggestions.settingsMinCharsHint") }}</p>
            <label class="settings-field">
              <span>{{ t("suggestions.settingsMaxChars") }}</span>
              <input v-model="suggestionMaxCharsDraft" type="number" min="8" max="512" step="1" @change="suggestionMaxCharsDraft = String(Math.min(512, Math.max(8, Number.parseInt(suggestionMaxCharsDraft, 10) || 64)))" />
            </label>
            <p class="muted settings-note">{{ t("suggestions.settingsMaxCharsHint") }}</p>
            <label class="settings-field settings-switch-row">
              <Switch :model-value="specCompletionEnabled" size="sm" @update:model-value="setSpecCompletionEnabled(Boolean($event))" />
              <span>{{ t("completionMenu.settingsEnabled") }}</span>
            </label>
            <p class="muted settings-note">{{ t("completionMenu.settingsEnabledHint") }}</p>

            <!-- 行内 ghost 自动建议（np8，对标 Warp/fish）：追加于「终端行为」组末尾；
                 组件内自治读写 pluginStore（ssh-terminal-ghost-suggest），即时上抛 App。 -->
            <h3 class="settings-section-title">{{ t("terminalGhost.sectionTitle") }}</h3>
            <label class="settings-field settings-switch-row">
              <Switch :model-value="ghostEnabled" size="sm" @update:model-value="setGhostEnabled(Boolean($event))" />
              <span>{{ t("terminalGhost.label") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalGhost.hint") }}</p>
            </div>

            <!-- 快捷键（对标 Tabby「Hotkeys」页）：注册表编辑器，逐动作增删改 + 冲突提示 + 单项/整体复位。 -->
            <div v-show="settingsCategory === 'hotkeys'" class="settings-pane">
            <h3 class="settings-section-title">{{ t("terminalHotkeys.sectionTitle") }}</h3>
            <p class="muted settings-note">{{ t("terminalHotkeys.hint") }}</p>
            <TerminalHotkeyEditor :bindings="terminalHotkeys" :apple-platform="applePlatform" :t="t" @update="updateHotkeys" />
            </div>

          <div v-show="settingsCategory === 'security'" class="settings-pane">
          <h3 class="settings-section-title">{{ t("knownHosts.title") }}</h3>
          <div v-if="knownHostsLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <p v-else-if="knownHostsError" class="task-error">{{ knownHostsError }} <button class="link-button" @click="loadKnownHosts">{{ t("refresh") }}</button></p>
          <div v-else-if="!knownHosts.length" class="empty compact">{{ t("knownHosts.empty") }}</div>
          <ul v-else class="settings-list">
            <li v-for="(entry, index) in knownHosts" :key="`${entry.host}:${entry.port}:${entry.keyType}:${index}`">
              <div class="settings-list-main">
                <strong class="mono">{{ entry.host }}:{{ entry.port }}</strong>
                <span class="muted">{{ entry.keyType }} · <span class="mono" :title="entry.fingerprint">{{ shortFingerprint(entry.fingerprint) }}</span></span>
              </div>
              <button class="icon-button" :title="t('delete')" @click="removeKnownHost(entry)"><Trash2 /></button>
            </li>
          </ul>

          <h3 class="settings-section-title">{{ t("keysPanel.title") }}</h3>
          <div v-if="localKeysLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <p v-else-if="localKeysError" class="task-error">{{ localKeysError }} <button class="link-button" @click="loadLocalKeys">{{ t("refresh") }}</button></p>
          <div v-else-if="!localKeys.length" class="empty compact">{{ t("keysPanel.empty") }}</div>
          <ul v-else class="settings-list">
            <li v-for="key in localKeys" :key="key.path">
              <div class="settings-list-main">
                <strong class="mono" :title="key.path">{{ key.path }}</strong>
                <span class="muted">{{ key.algorithm }} · <span class="mono" :title="key.fingerprint">{{ shortFingerprint(key.fingerprint) }}</span><template v-if="key.hasPassphrase"> · {{ t("keysPanel.hasPassphrase") }}</template></span>
              </div>
              <KeyRound class="settings-key-icon" />
            </li>
          </ul>
          <p class="muted settings-note">{{ t("keysPanel.hint") }}</p>
          </div>

          <div v-show="settingsCategory === 'mcp'" class="settings-pane">
          <h3 class="settings-section-title">{{ t("mcpLimits.title") }}</h3>
          <div v-if="mcpLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <template v-else>
            <div class="mcp-limits">
              <label class="settings-field">
                <span>{{ t("mcpLimits.read") }}</span>
                <input v-model="mcpDraft.readMiB" type="number" min="1" step="1" inputmode="numeric" />
              </label>
              <label class="settings-field">
                <span>{{ t("mcpLimits.upload") }}</span>
                <input v-model="mcpDraft.uploadMiB" type="number" min="1" step="1" inputmode="numeric" />
              </label>
              <label class="settings-field">
                <span>{{ t("mcpLimits.download") }}</span>
                <input v-model="mcpDraft.downloadMiB" type="number" min="1" step="1" inputmode="numeric" />
              </label>
            </div>
            <label class="settings-field">
              <span>{{ t("mcpSettings.permissionMode") }}</span>
              <Select :model-value="mcpDraft.permissionMode" @update:model-value="(v) => (mcpDraft.permissionMode = String(v))">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="autonomous">{{ t("mcpSettings.permissionModeAutonomous") }}</SelectItem>
                  <SelectItem value="confirm">{{ t("mcpSettings.permissionModeConfirm") }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p v-if="mcpDraft.permissionMode === 'confirm'" class="muted settings-note">{{ t("mcpSettings.permissionModeConfirmHint") }}</p>
            <label class="settings-field">
              <span>{{ t("mcpSettings.connectionScope") }}</span>
              <textarea v-model="mcpDraft.connectionScope" rows="3" class="mono" spellcheck="false" :placeholder="t('mcpSettings.connectionScopeHint')" />
            </label>
            <p v-if="!mcpInputsValid" class="task-error">{{ t("mcpLimits.invalid") }}</p>
            <p v-if="mcpError" class="task-error">{{ mcpError }} <button class="link-button" @click="loadMcpSettings">{{ t("refresh") }}</button></p>
            <!-- 独立「保存」链接已并入底部主「保存」串行链（saveSettings）。 -->
          </template>
          </div>
            </div>
          </div>
          </template>

        </div>
        <footer>
          <button :disabled="settingsLoading || settingsLoadFailed || settingsSaving || (!settingsMeta?.sudoPasswordSet && !settingsMeta?.totpConfigured)" @click="clearStoredSecrets"><Trash2 />{{ t("settingsClearSecrets") }}</button>
          <button @click="emit('update:open', false)">{{ t("close") }}</button>
          <button class="primary-button" :disabled="settingsLoading || settingsLoadFailed || settingsSaving || !settingsMeta" @click="saveSettings"><Loader2 v-if="settingsSaving" class="spinning" />{{ t("settingsSave") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

    <!-- quick sudo 配置档管理弹窗（工具栏 KeyRound 入口；与内联 section 共用草稿状态） -->
    <Dialog :open="profilesOpen" @update:open="(value) => emit('update:profilesOpen', value)">
      <DialogContent class="modal settings-modal profiles-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("profilesTitle") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="emit('update:profilesOpen', false)"><X /></button></header>
        <div class="settings-body">
          <p class="muted">{{ t("profilesHint") }}</p>
          <div class="profiles-toolbar">
            <span class="profiles-count muted">{{ t("profilesLimit", { count: sudoProfiles.length, limit: 20 }) }}</span>
            <button v-if="!profileEditing" class="primary-button profiles-add" @click="startProfileCreate"><Plus />{{ t("profilesAdd") }}</button>
          </div>
          <div class="profiles-content">
            <div v-if="sudoProfilesLoading && !sudoProfiles.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
            <div v-else-if="!sudoProfiles.length" class="profiles-empty"><ShieldCheck /><p>{{ t("profilesEmpty") }}</p></div>
            <ul v-else class="settings-list profiles-list">
              <li v-for="profile in sudoProfiles" :key="profile.id">
                <div class="settings-list-main">
                  <strong>{{ profile.name }}</strong>
                  <span class="muted">{{ profileSummary(profile) }}</span>
                </div>
                <span class="settings-list-actions">
                  <button class="icon-button" :title="t('profilesEdit')" @click="startProfileEdit(profile)"><Pencil /></button>
                  <button class="icon-button" :title="t('profilesDelete')" @click="removeProfile(profile)"><Trash2 /></button>
                </span>
              </li>
            </ul>
          </div>

          <template v-if="profileEditing">
            <h3 class="settings-section-title">{{ profileDraft.id ? t("profilesEdit") : t("profilesAdd") }}</h3>
            <label class="settings-field">
              <span>{{ t("profilesName") }}</span>
              <input v-model="profileDraft.name" spellcheck="false" :placeholder="t('profilesNamePlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("profilesPassword") }}</span>
              <input v-model="profileDraft.sudoPassword" type="password" autocomplete="off" :placeholder="profileDraftHadPassword ? t('profilesPasswordKeep') : t('settingsSudoPasswordPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsTotp") }}</span>
              <textarea v-model="profileDraft.totpSecret" rows="2" spellcheck="false" :placeholder="profileDraftHadTotp ? t('settingsConfigured') : t('settingsTotpPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsFlowMode") }}</span>
              <Select :model-value="profileDraft.authFlowMode" @update:model-value="(v) => (profileDraft.authFlowMode = String(v))">
                <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="password_then_otp">{{ t("flowThenOtp") }}</SelectItem>
                  <SelectItem value="password_plus_otp">{{ t("flowPlusOtp") }}</SelectItem>
                  <SelectItem value="password_only">{{ t("flowOnly") }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label class="settings-field">
              <span>{{ t("settingsPasswordHint") }}</span>
              <input v-model="profileDraft.passwordPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsTotpHint") }}</span>
              <input v-model="profileDraft.totpPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
            </label>
            <label class="quick-sudo-control">
              <Switch v-model="profileDraft.sudoUsePty" size="sm" />
              <span>{{ t("settingsUsePty") }}</span>
            </label>
            <p v-if="sudoProfilesError" class="task-error">{{ sudoProfilesError }}</p>
            <footer class="profiles-form-actions">
              <button @click="cancelProfileEdit">{{ t("cancel") }}</button>
              <button class="primary-button" :disabled="profileSaving || !profileDraft.name.trim()" @click="saveProfileDraft"><Loader2 v-if="profileSaving" class="spinning" />{{ t("save") }}</button>
            </footer>
          </template>
        </div>
        <footer><button @click="emit('update:profilesOpen', false)">{{ t("close") }}</button></footer>
      </DialogContent>
    </Dialog>
</template>
