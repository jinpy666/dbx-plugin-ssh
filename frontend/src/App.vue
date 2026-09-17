<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  Activity,
  Archive,
  Circle,
  Disc,
  Film,
  Pause,
  Play,
  Plus,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpDown,
  Bot,
  Braces,
  ClipboardPaste,
  Columns3,
  Copy,
  Download,
  Eraser,
  File as FileIcon,
  FilePlus,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  ImagePlay,
  History,
  Home,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  Lock,
  PackageOpen,
  Palette,
  PanelRightClose,
  Pencil,
  PlugZap,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Siren,
  Square,
  SquareTerminal,
  Star,
  TextSelect,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "@lucide/vue";
import type { Detection as ZmodemDetection, Session as ZmodemSession, Sentry as ZmodemSentry } from "zmodem.js";
import { TrzszFilter } from "trzsz";
import {
  canStartTrzszTransfer,
  detectTrzszAnnounceFromBytes,
  initialTrzszProgressState,
  installTrzszHandlers,
  isTrzszStopMessage,
  reduceTrzszProgress,
  resolveTerminalInputRoute,
  trzszProgressPercent,
  type TrzszAnnounce,
  type TrzszDownloadFile,
  type TrzszProgressEvent,
  type TrzszProgressState,
} from "./lib/terminalTrzsz";
import { Osc7DirectoryParser } from "./lib/terminalDirectoryTracking";
import {
  resolveTerminalKeyAction,
  resolveTerminalRightClickAction,
  sanitizeSearchOptions,
  sanitizeSelectCopyEnabled,
  TERMINAL_SEARCH_OPTIONS_KEY,
  terminalSearchSeedFromSelection,
  canAcceptTerminalDrop,
  normalizeDropTargetDir,
  type TerminalSearchOptions,
} from "./lib/terminalInteraction";
import { createTerminalWriteThrottle, type TerminalWriteThrottle } from "./lib/terminalWriteThrottle";
import { createTerminalInputQueue } from "./lib/terminalInputQueue";
import { describeReconnectCountdown, describeReconnectRestoredNotice, isConnectionInactiveError, shouldReattachTerminal, terminalReconnectDelay, TERMINAL_RECONNECT_DELAYS, type ReconnectCountdown } from "./lib/terminalReconnect";
import { classifyConnectError, connectErrorKey } from "./lib/connectError";
import { decideConnectRetry } from "./lib/connectRetry";
import { createConnectLog } from "./lib/connectLog";
import { focusableElements, nextFocusIndex, pickModalFocusTarget } from "./lib/modalFocus";
import { createZmodemSentry, sendZmodemFiles, type ZmodemUploadProgress } from "./lib/terminalZmodem";
import { sampleTransferSpeed, type TransferSpeedSample } from "./lib/transferSpeed";
import { buildPasteConfirmation, type PasteConfirmation } from "./lib/dangerousCommands";
import { readClipboardText, writeClipboardText, type ClipboardDeps } from "./lib/clipboardBridge";
import { filesFromClipboard } from "./lib/clipboardFiles";
import { friendlySftpError } from "./lib/sftpErrors";
import { filterDiskMounts, filterNetworkInterfaces } from "./lib/metricsView";
import { isCountdownActive, nextCountdownValue, RECORD_COUNTDOWN_START } from "./lib/recordingCountdown";
import { expandSelection, filterSftpEntries, type SftpTypeFilter } from "./lib/sftpFileFilters";
import { pushPathHistory, sanitizePathHistories } from "./lib/sftpPathHistory";
import {
  defaultBookmarkLabel,
  deleteBookmark,
  listBookmarks,
  SFTP_BOOKMARKS_LIMIT,
  SFTP_BOOKMARK_LABEL_MAX_LENGTH,
  saveBookmark,
  sortBookmarksByLabel,
  validateBookmarkInput,
  type SftpBookmark,
} from "./lib/sftpBookmarks";
import { browseCommandHistory, commandInputAction, isPersistableCommand, pushCommandHistory, sanitizeCommandHistory } from "./lib/commandHistory";
import { filterQuickCommands, normalizeQuickCommands, QUICK_COMMANDS_LIMIT, quickCommandText, type QuickCommand } from "./lib/quickCommands";
import { batchTargetLabel, deriveBatchCommandName, normalizeBatchTargets, quickPickCommandById, selectBatchTargets, summarizeBatchResults, toggleBatchTarget, type BatchSendSummary, type BatchSendTarget } from "./lib/batchSend";
import { formatLatency, formatAuthMethodLabel, normalizeConnectionPort, normalizeConnectionText, type KnownAuthMethod } from "./lib/connectionInfo";
import { clampFontSize } from "./lib/terminalZoom";
import { commandMarkerTooltip, formatCommandDuration, Osc633CommandParser, runningCommandElapsedMs, type Osc633StreamUpdates } from "./lib/terminalCommandMarkers";
import { advanceBatchProgress, batchProgressPercent, createBatchProgress, type BatchProgressState } from "./lib/sftpBatchProgress";
import { describeWorkbenchSessionStatus, type WorkbenchSessionStatus } from "./lib/sessionStatus";
import { sanitizeCommandOutput } from "./lib/terminalOutputText";
import { normalizeTerminalInputBytes } from "./lib/terminalInput";
import { looksBinary } from "./lib/textSniff";
import { formatBytes, formatRate } from "./lib/format";
import { DBX_POPOVER, resolveAppearance, TERMINAL_ANSI, type DbxPluginAppearanceInput } from "./lib/appearance";
import { isDbxPluginTheme, onHostThemeChange, themeToAppearance } from "./lib/hostTheme";
import { AGENT_MODES, approvalRemainingSecs, buildAgentResolveBody, dropAgentPrompt, enqueueAgentPrompt, sanitizeRememberedCommands, type AgentFinishPayload, type AgentNoticePayload, type AgentPromptPayload, type AgentTerminalMode } from "./lib/agentTerminal";
import { purposeKeyLabel, sanitizeTriagePayload, severityClass, type TriageResult } from "./lib/alertTriage";
import {
  compileRules,
  highlightFillStyle,
  matchesInLine,
  normalizeHighlightRules,
  sanitizeHighlightRuleInput,
  HIGHLIGHT_COLOR_DEFAULT,
  HIGHLIGHT_RULES_LIMIT,
  type HighlightRuleView,
} from "./lib/keywordHighlight";
import { pushSample, sparklinePath, METRICS_SAMPLE_CAPACITY } from "./lib/metricsSparkline";
import { transferPausable, matchResumableUpload, canResumeUpload, type ResumableUploadTask } from "./lib/transferResume";
import { buildTimeline, eventIndexAtTime, gifFramePlan, mergeEventPages, replayDuration, type RecordingSummary, type ReplayEvent, type ReplayEventPage } from "./lib/replayScheduler";
import { encodeGif } from "./lib/gifEncoder";
import { canKillProcess, sortProcessRows, type ProcessSortKey } from "./lib/processActions";
import { distroBadge, type DistroBadge } from "./lib/distroBadge";
import { auditKindLabel, auditKindOptions, auditOutcomeLabel, sanitizeAuditEntries, type AuditEntry } from "./lib/auditLog";
import { resolveSftpPaneOpen, sanitizeSftpPaneDefaultOpen, type SshWorkbenchPaneOrder } from "./lib/workbenchLayout";
import { pickLiveSessionForReattach, type SessionSummary } from "./lib/sessionRestore";
import { toolbarTintStyle } from "./lib/toolbarTint";
import { createGhostClickGuard } from "./lib/ghostClickGuard";
import { createRequestEpoch } from "./lib/requestEpoch";
import { sanitizeSftpEntries } from "./lib/sftpEntries";
import { resolveRemotePath } from "./lib/remotePathInput";
import { shouldCommitRename } from "./lib/sftpRename";
import { decideFileRowAction } from "./lib/fileRowKeydown";
import { attachWebglRenderer, loadWebglEnabled, persistWebglEnabled, syncWebglRenderer, type WebglRendererLike } from "./lib/terminalWebgl";
import { cellFromMouseEvent, clickCursorArrows, resolveClickCursorMove } from "./lib/terminalClickCursor";
import { bridgeBinaryBytes } from "../../shared/frontend/binaryEvent";
import { applyTreeChildren, createTreeRoot, findTreeNode, markTreeStale, type DirTreeNode } from "./lib/sftpDirTree";
import { workbenchMessage } from "./lib/i18n";
import TextPreview from "./components/TextPreview.vue";
import TerminalSearchPanel from "./components/TerminalSearchPanel.vue";
import ConnectingCard from "./components/ConnectingCard.vue";
import FolderPickerDialog from "./components/FolderPickerDialog.vue";
import SideNavPanel, { type SftpSideQuickPath } from "./components/SideNavPanel.vue";

interface SessionInfo {
  sessionId: string;
  connectionId: string;
  workbenchId?: string;
  connected: boolean;
  sequence: number;
  chunkSize: number;
  directoryTrackingSupported?: boolean;
  replay?: ReplayResult;
}

interface ReplayResult {
  frameCount: number;
  firstAvailableSequence: number;
  tailSequence: number;
  complete: boolean;
}

interface SftpEntry {
  name: string;
  uri: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt?: number;
  permissions?: string;
  contentType?: string;
}

interface SftpStatInfo {
  path: string;
  kind: SftpEntry["kind"];
  size?: number;
  modifiedAt?: number;
  mode?: string;
  owner?: string;
  group?: string;
}

// 服务器内复制/剪切/粘贴的剪贴板：仅当前连接内有效。
interface SftpClipboard {
  mode: "copy" | "cut";
  paths: string[];
  connectionId: string;
}

interface HostKeyPrompt {
  challengeId: string;
  operationId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

interface TransferTask {
  taskId: string;
  sessionId?: string;
  direction: "upload" | "download";
  fileName: string;
  size: number;
  transferred: number;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  error?: string;
  // saveToLocal 下载完成后的本机落盘路径（用于展示与在文件管理器中定位）。
  localPath?: string;
}

// sftp/transfer/history 行（落盘历史 + 内存 live 合并视图）：status 沿用现有枚举、无 queued。
interface TransferHistoryEntry {
  taskId: string;
  sessionId?: string;
  connectionId?: string;
  direction: "upload" | "download";
  fileName: string;
  size: number;
  transferred: number;
  status: "running" | "completed" | "cancelled" | "failed";
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  localPath?: string;
}

interface WorkbenchState {
  sessionId?: string;
  terminalSequence?: number;
  sftpPath?: string;
  followDirectory?: boolean;
  sudoMode?: boolean;
  splitRatio?: number;
  paneOrder?: SshWorkbenchPaneOrder;
  sftpPaneOpen?: boolean;
  visibleColumns?: SftpColumn[];
}

interface ConnectionSummary {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  color?: string;
  readOnly?: boolean;
}

interface DownloadInfo {
  taskId: string;
  fileName: string;
  size: number;
  chunkSize: number;
  // 断点续传：start 带 offset 时回显的恢复起点。
  resumeOffset?: number;
}

interface ExecResult {
  output: string;
  exitCode: number;
}

interface ServerMetrics {
  hostname?: string | null;
  kernel?: string | null;
  uptimeSeconds?: number | null;
  cpu?: { cores?: number | null; percent?: number | null; load1?: number | null; load5?: number | null; load15?: number | null };
  memory?: { totalBytes?: number; availableBytes?: number; usedBytes?: number; swapTotalBytes?: number; swapUsedBytes?: number };
  disks?: Array<{ filesystem: string; mount: string; totalBytes: number; usedBytes: number; availableBytes: number; percentUsed: number }>;
  // Extensions reported by newer sidecars; when absent the network and
  // process sections simply stay hidden instead of erroring.
  network?: Array<{ name: string; rxRate: number; txRate: number; rxTotal: number; txTotal: number }>;
  processes?: Array<{ pid: number; user: string; cpuPercent: number; memPercent: number; command: string }>;
  // §1.5 发行版识别（/etc/os-release）：读不到时两字段整体缺省，
  // 旧 sidecar 自然缺失，前端不渲染徽标（optional 降级）。
  osId?: string;
  osPretty?: string;
}

interface SshSettings {
  quickSudo: boolean;
  sudoUsePty: boolean;
  sudoPasswordSet: boolean;
  totpConfigured: boolean;
  authFlowMode: string;
  passwordPromptHint: string;
  totpPromptHint: string;
  // revealSecrets: true 时回显的本连接原始凭据（设置弹窗预填用）。
  sudoPassword?: string;
  totpSecret?: string;
  // 全局 quick sudo 配置来源（空串 = 使用本连接自己的凭据）。
  quickSudoProfileId?: string;
  quickSudoProfileName?: string;
  // AI 终端同步执行模式（连接级；off 默认 / auto 分级 / strict 全审）。
  agentTerminalMode?: string;
  // 已记住的免审批命令（连接级原始行，sudoers 式 token 语义）。
  rememberedCommands?: string[];
}

// 全局 quick sudo 配置视图：密钥永不回显，只有已设置布尔位。
interface SudoProfileView {
  id: string;
  name: string;
  sudoPasswordSet: boolean;
  totpConfigured: boolean;
  authFlowMode: string;
  passwordPromptHint: string;
  totpPromptHint: string;
  sudoUsePty: boolean;
  createdAt: number;
  updatedAt: number;
}

interface DiskUsage {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  percentUsed: number;
}

interface KnownHostEntry {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

interface DiscoveredKey {
  path: string;
  algorithm: string;
  fingerprint: string;
  // The protocol doc names this field `hasPassphrase`; the current sidecar
  // serializes Rust's snake_case `has_passphrase`. Accept both spellings.
  hasPassphrase?: boolean;
  has_passphrase?: boolean;
}

interface McpSizeSettings {
  maxReadBytes?: number;
  maxUploadBytes?: number;
  maxDownloadBytes?: number;
  // §1.3 MCP 权限档与连接作用域（新字段，旧 sidecar 不回即用默认值）。
  execPermissionMode?: string;
  connectionScope?: string[];
}

type SftpColumn = "size" | "modified" | "permissions";
type SftpSortColumn = "name" | "size" | "modified";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", svg: "svg+xml", bmp: "bmp", ico: "x-icon" };
// 已知二进制扩展名在双击时直接提示不打开；无后缀/改名文件由打开前的内容嗅探兜底。
const BINARY_PREVIEW_EXTENSIONS = new Set(["7z", "bin", "bz2", "class", "dll", "dmg", "dylib", "exe", "gz", "iso", "jar", "lz4", "o", "obj", "otf", "pdf", "pyc", "rar", "so", "tar", "tif", "tiff", "ttf", "war", "woff", "woff2", "xz", "zip", "zst"]);
// 打开预览前先读该字节数做二进制嗅探（looksBinary），避免向编辑器灌入乱码。
const SNIFF_CHUNK_BYTES = 8 * 1024;
const MAX_INLINE_PREVIEW_BYTES = 1024 * 1024;
const MAX_DIRECT_WRITE_BYTES = 4 * 1024 * 1024;
const MIB = 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 20 * MIB;
// Above this size the browser download path buffers the whole file in memory, so ask first.
const WEB_DOWNLOAD_WARNING_BYTES = 512 * MIB;
const ZMODEM_DETECTION_TIMEOUT_MS = 5000;
// 粘贴防护：内容含换行或达到该字符数时先确认（对齐 tiny-rdm TerminalPane 阈值）。
const PASTE_CONFIRM_CHAR_THRESHOLD = 200;
// SFTP 路径历史：每连接最多保留 10 条，存 localStorage（对齐 tiny-rdm pathHistory）。
const SFTP_PATH_HISTORY_KEY = "sftp-path-history";
const SFTP_PATH_HISTORY_LIMIT = 10;
// 传输历史查询上限（sftp/transfer/history，后端环形 200，面板一次取 50）。
const TRANSFER_HISTORY_LIMIT = 50;
// Upper bound for out-of-order terminal frames held while waiting for the
// missing sequence; the replay path re-delivers anything dropped beyond it.
const TERMINAL_PENDING_FRAME_LIMIT = 1024;
const SFTP_QUICK_PATHS = ["/", "/home", "/tmp", "/etc", "/var", "/root"];
// 命令历史 / 快速命令 / 终端字号：localStorage 持久化（敏感命令不入持久层）。
const COMMAND_HISTORY_KEY = "ssh-command-history";
// 快速命令旧键：迁移到 sidecar 全局存储后仅作一次性迁移种子（见 hydrateQuickCommands）。
const QUICK_COMMANDS_KEY = "ssh-quick-commands";
const TERMINAL_FONT_SIZE_KEY = "ssh-terminal-font-size";
// SFTP 面板默认打开偏好：localStorage 全局持久化（"false" = 新工作台仅终端）。
const SFTP_PANE_OPEN_KEY = "ssh-sftp-pane-open";
// 侧栏形态偏好：tree/quick tab（默认 tree）与收起状态，localStorage 全局持久化。
const SFTP_SIDE_TAB_KEY = "ssh-sftp-side-tab";
const SFTP_SIDE_COLLAPSED_KEY = "ssh-sftp-side-collapsed";
const DOWNLOAD_DIR_KEY = "ssh-download-directory";
// 是否默认下载到「下载保存目录」（默认开）；关闭则每次下载打开目录选择窗口。
const DOWNLOAD_USE_DEFAULT_KEY = "ssh-download-use-default-dir";
// 文件已存在时的处理策略：rename（自动重命名，默认）/ ask（询问我）/ overwrite（覆盖）。
const DOWNLOAD_CONFLICT_KEY = "ssh-download-conflict-policy";
type DownloadConflictPolicy = "rename" | "ask" | "overwrite";
// 下载偏好的内存权威态：setup 早期（downloadUseDefaultDraft 初始化）就会被读，
// 必须声明在所有读取点之前（存储语义见下方 loadDownloadDir 一带的注释）。
const downloadDirState = ref("");
const downloadUseDefaultState = ref(true);
const downloadConflictState = ref<DownloadConflictPolicy>("rename");
const DOWNLOAD_CONFLICT_POLICIES: readonly DownloadConflictPolicy[] = ["rename", "ask", "overwrite"];

function sanitizeConflictPolicy(value: unknown): DownloadConflictPolicy {
  return value === "ask" || value === "overwrite" ? value : "rename";
}
// 终端交互：选中复制 + 右键粘贴（localStorage 全局偏好，默认开，"false" 关闭）。
const SELECT_COPY_KEY = "ssh-terminal-select-copy";
// 关键词高亮总开关（IMPL_PLAN_NETCATTY_PARITY §3-B1）：localStorage 全局持久化，
// 默认开、仅显式 "false" 关（对齐 sanitizeSelectCopyEnabled 模式）；关闭时零挂钩子。
const HIGHLIGHT_ENABLED_KEY = "ssh-keyword-highlight";
// decoration 引擎护栏：全局在档 decoration 上限（超限停止本帧注册）。
const HIGHLIGHT_DECORATION_LIMIT = 400;
// rAF 节流目标：≤30fps（约 33ms 一帧）。
const HIGHLIGHT_SCAN_MIN_INTERVAL_MS = 33;
// 8 色板（新增规则默认色板；自定义 hex 输入并行提供）。
const HIGHLIGHT_PALETTE = ["#ef4444", "#f59e0b", "#facc15", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];

type TerminalSearchMatchState = "idle" | "match" | "no-match";

const terminalHost = ref<HTMLElement>();
const sftpPane = ref<HTMLElement>();
const paneContainer = ref<HTMLElement>();
const uploadInput = ref<HTMLInputElement>();
const zmodemInput = ref<HTMLInputElement>();
const trzszInput = ref<HTMLInputElement>();
const hostContext = ref<Record<string, unknown>>({});
// 宿主未下发 appearance 前的兜底：DBX `.dark` 规范令牌。
const appearance = ref(resolveAppearance());
const terminalState = ref<"connecting" | "connected" | "disconnected" | "error">("connecting");
const terminalError = ref("");
// 连接卡片：用户取消（在途 open 无法中止，仅切换 UI 态并在 promise 落地后回收
// 孤儿会话）、Show logs 展开态与连接尝试日志（环形 200 条，跨尝试保留历史）。
const connectCancelled = ref(false);
// 成功过渡动画：open 成功后先切 success 卡片（进度到顶 + 对号），hold 播完再进终端。
const connectSucceeded = ref(false);
const CONNECT_SUCCESS_HOLD_MS = 750;
const connectLogsOpen = ref(false);
const connectLog = createConnectLog();
const sftpError = ref("");
const sftpErrorRetry = ref<(() => void) | null>(null);
const notice = ref("");
const noticeActions = ref<Array<{ label: string; run: () => void }>>([]);
const session = ref<SessionInfo>();
const currentPath = ref("/");
const entries = ref<SftpEntry[]>([]);
const selectedPath = ref("");
const loadingFiles = ref(false);
const hostKeyPrompt = ref<HostKeyPrompt>();
const rememberHostKey = ref(true);
// AI 终端同步执行：审批挑战队列 / 执行横幅状态（ssh/agent/* 事件仅当前会话生效）。
// 跨会话并发审批按 challengeId 排队，弹窗一次只渲染队首（后端同会话已串行化）。
const agentPromptQueue = ref<AgentPromptPayload[]>([]);
const agentPromptCommand = ref("");
const agentPromptRemaining = ref(0);
const agentPromptExpired = ref(false);
// 「记住此命令」勾选态：批准时随 resolve 提交，把命令写入连接级免审批清单
// （后端 D2 兜底：破坏性命令自动忽略记住标记）。
const agentPromptRemember = ref(false);
const agentRunning = ref<AgentNoticePayload>();
const splitRatio = ref(58);
const paneOrder = ref<SshWorkbenchPaneOrder>("terminal-left");
// SFTP 面板可见性：每个工作台即时开关（写入 workbenchState）；
// 新工作台的初始值取全局"默认打开"偏好（localStorage）。
const sftpPaneOpen = ref(loadSftpPaneDefaultOpen());
const sftpPaneDefaultOpen = ref(loadSftpPaneDefaultOpen());
// 侧栏导航形态偏好：tree（目录树，默认）/ quick（快捷路径）+ 收起状态。
const sftpSideTab = ref<"tree" | "quick">(loadSftpSideTab());
const sftpSideCollapsed = ref(loadSftpSideCollapsed());
// 侧栏目录树：根 = 连接根 "/"，展开时经 sftp/list 懒加载子目录（仅目录）。
const sftpTree = ref<DirTreeNode>(createTreeRoot("/", "/"));
// sftp/home 探测结果：quick tab 置顶展示（获取失败时该项隐藏）。
const sftpHomePath = ref("");
// 选中复制 + 右键粘贴（终端交互偏好，全局生效，切换即持久化）。
const termSelectCopy = ref(loadSelectCopyEnabled());
const followDirectory = ref(false);
const directoryTrackingSupported = ref<boolean | undefined>();
const visibleColumns = ref<SftpColumn[]>(["size", "modified"]);
const sort = ref<{ column: SftpSortColumn; direction: "asc" | "desc" }>({ column: "name", direction: "asc" });
const transferTasks = reactive<Record<string, TransferTask>>({});
// 断点续传（F1）：暂停中的任务（两分片之间生效）；等待恢复的回调登记表。
const pausedTaskIds = reactive(new Set<string>());
const pauseWaiters = new Map<string, Array<() => void>>();
// 后端扫描出的可续传上传任务（spool 前缀仍在磁盘上）。
const transferPanelOpen = ref(false);
// 传输历史（sftp/transfer/history，落盘+内存合并）：面板打开或活动任务清零时刷新；
// 历史区与活跃任务并列展示，后端未升级/读取失败仅提示加载失败（optional 特性降级）。
const transferHistory = ref<TransferHistoryEntry[]>([]);
const transferHistoryLoading = ref(false);
const transferHistoryFailed = ref(false);
const resumableTasks = ref<ResumableUploadTask[]>([]);
const resumableLoading = ref(false);
const resumeInput = ref<HTMLInputElement | null>(null);
const resumeTargetTaskId = ref("");
const columnsOpen = ref(false);
const transferSpeeds = reactive<Record<string, number>>({});
const previewOpen = ref(false);
const previewTitle = ref("");
const previewText = ref("");
const previewLoading = ref(false);
const previewPath = ref("");
const previewSize = ref(0);
const previewEditable = ref(false);
const previewDraft = ref("");
const previewSaving = ref(false);
const previewMode = ref<"text" | "image">("text");
const previewImageUrl = ref("");
const previewImageZoomed = ref(false);
// Baseline snapshot of the content when it was opened (or last saved); the
// dirty marker compares the live draft against it.
const previewBaseline = ref("");
// 仅加载了文件头部（大文件确认预览）时置位：预览只读，禁止保存以免整文件覆盖。
const previewTruncated = ref(false);
const sudoMode = ref(false);
const archiveBusy = ref(false);
const operationDialog = ref<"mkdir" | null>(null);
const operationDraft = ref("");
const deleteTarget = ref<SftpEntry>();
const deleteSubmitting = ref(false);
const renamingPath = ref("");
const renameDraft = ref("");
const renameSubmitting = ref(false);
const dragActive = ref(false);
// Terminal-local drag overlay: true only while files are dragged over the
// terminal pane and the drop can actually be accepted (writable session).
const terminalDragActive = ref(false);
const terminalMenu = ref<{ x: number; y: number }>();
// 行右键菜单：selection 为打开菜单瞬间的多选快照（>1 时切换为批量区）。
const fileMenu = ref<{ x: number; y: number; entry: SftpEntry; selection: string[] }>();
// 文件列表空白处右键：新建文件夹 / 新建文件 / 刷新（拦截浏览器默认菜单）。
const blankMenu = ref<{ x: number; y: number }>();
// 侧栏（目录树/快捷路径）行右键：打开 / 复制路径 / 复制文件名 / 压缩。
const sideMenu = ref<{ x: number; y: number; path: string }>();
// 下载历史项右键：只为已有本机落盘路径提供定位/打开操作。
const transferHistoryMenu = ref<{ x: number; y: number; path: string }>();
const zmodemState = ref<"idle" | "waiting" | "uploading">("idle");
const zmodemFileName = ref("");
const zmodemTransferred = ref(0);
const zmodemTotalSize = ref(0);
const zmodemSpeed = ref(0);
// trzsz (trz/tsz)：进度 overlay 状态镜像（真实状态机在 lib/terminalTrzsz.ts）。
const trzszPhase = ref<TrzszProgressState["phase"]>("idle");
const trzszDirection = ref<TrzszProgressState["direction"]>("");
const trzszFileName = ref("");
const trzszFileIndex = ref(0);
const trzszFileCount = ref(0);
const trzszPercent = ref(0);
const trzszSpeed = ref(0);
const trzszMessage = ref("");
const commandOpen = ref(false);
const commandDraft = ref("");
const commandUseSudo = ref(true);
const commandRunning = ref(false);
const commandExecId = ref("");
const commandResult = ref<ExecResult>();
const commandError = ref("");
// 命令历史：内存环形 + localStorage 非敏感持久化；index 为 -1 表示未在浏览历史。
const commandHistory = ref<string[]>(loadCommandHistory());
const commandHistoryIndex = ref(-1);
const commandHistoryBackup = ref("");
// 快速命令：用户自定义片段（≤20 条），全局存储在插件数据目录（sidecar），
// 所有连接/工作台共享；工具栏下拉一键发送到 PTY。
const quickCommands = ref<QuickCommand[]>(loadQuickCommands());
const quickMenuOpen = ref(false);
const quickSaving = ref(false);
const quickDraft = reactive<{ id?: string; name: string; command: string }>({ name: "", command: "" });
// Termius Snippets 式面板状态：搜索过滤 / 卡片展开 / 编辑器子视图。
const quickSearch = ref("");
const quickExpandedId = ref<string | null>(null);
const quickEditorOpen = ref(false);
const filteredQuickCommands = computed(() => filterQuickCommands(quickCommands.value, quickSearch.value));

function openQuickEditor(item?: QuickCommand) {
  quickDraft.id = item?.id;
  quickDraft.name = item?.name ?? "";
  quickDraft.command = item?.command ?? "";
  quickEditorOpen.value = true;
}

function closeQuickEditor() {
  quickEditorOpen.value = false;
  quickDraft.id = undefined;
  quickDraft.name = "";
  quickDraft.command = "";
}

function toggleQuickExpand(id: string) {
  quickExpandedId.value = quickExpandedId.value === id ? null : id;
}
// 批量发送命令条（Electerm quick-command bar 风格）：常驻贴在终端底部，回车
// 即发送。目标来自 ssh/sessions/list（跨连接全部活跃会话），命令写入各会话
// 交互终端（PTY 键盘语义，输出回显在各自终端，对齐 tiny-rdm batch send）。
const BATCH_BAR_OPEN_KEY = "ssh-batch-bar-open";

function loadBatchBarOpen(): boolean {
  try {
    return window.localStorage.getItem(BATCH_BAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

const batchBarOpen = ref(loadBatchBarOpen());
const batchTargetsOpen = ref(false);
const batchLoading = ref(false);
const batchSending = ref(false);
const batchTargets = ref<BatchSendTarget[]>([]);
const batchSelected = ref<string[]>([]);
const batchDraft = ref("");
const batchError = ref("");
const batchSummary = ref<BatchSendSummary>();
const batchQuickPickId = ref("");
// 保存为快速命令的内联名称态（保存走 ssh/quickCommands/save，全局共享）。
const batchSaveMode = ref(false);
const batchSaveName = ref("");
const batchSaving = ref(false);
// 命令条 ↑↓ 浏览历史（与命令弹窗共用 commandHistory 一份存储）。
const batchHistoryIndex = ref(-1);
const batchHistoryBackup = ref("");
// 跨工作台同步源标识：sidecar 把本端状态广播给所有 webview，各端按 source
// 过滤回声；sidecar 缺该方法（旧版二进制）时静默降级，只影响同步。
const batchBarSourceId = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `bar-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let batchBroadcastTimer: number | undefined;
// 连接信息面板（只读摘要 + echo 往返延迟）。
const connectionInfoOpen = ref(false);
const connectionLatency = ref<number | null>(null);
const connectionLatencyBusy = ref(false);
const connectionLatencyFailed = ref(false);
// 认证方式只读名称（来自 ssh/sessions/list 的 authMethod；仅方法名，无凭据）。
const connectionAuthMethod = ref("");
// 生效只读门禁（来自 ssh/sessions/list 行的 readOnly：表单 read_only ∥
// 宿主标准 read_only）。后端门禁为权威来源，前端据此禁用写操作。
const connectionReadOnly = ref(false);
const metricsOpen = ref(false);
// F2：进程管理面板 + 排序键；F3：录制/回放状态。
interface ProcessRow {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  etime: string;
  state: string;
  command: string;
}
const processesOpen = ref(false);
const processRows = ref<ProcessRow[]>([]);
const processLoading = ref(false);
const processSortKey = ref<ProcessSortKey>("cpu");
const recordingActive = ref(false);
const recordingsOpen = ref(false);
const recordings = ref<RecordingSummary[]>([]);
const recordingsLoading = ref(false);
// 删除确认走应用内弹窗：工作台 iframe 是 sandbox="allow-scripts"（无
// allow-modals），window.confirm 恒返回 false——曾让删除按钮看起来完全失效。
const recordingDeleteTarget = ref<RecordingSummary | null>(null);
const recordingDeleteSubmitting = ref(false);
// 行内导出进行中的 recordingId：多条记录共用全局导出锁（replayExporting），
// 只有发起行显示 Encoding…，其余行仅禁用。
const recordingExportingId = ref<string | null>(null);
const replayState = ref<{ summary: RecordingSummary; events: ReplayEvent[] } | null>(null);
const replayPlaying = ref(false);
const replaySpeed = ref(1);
const replayPlayheadMs = ref(0);
const replayExporting = ref(false);
const replayHost = ref<HTMLDivElement | null>(null);
const metrics = ref<ServerMetrics>();
const metricsLoading = ref(false);
const metricsError = ref("");
const settingsOpen = ref(false);
// 设置弹窗分类导航（左栏）：标签复用各区块既有 i18n 键，不新增文案。
const SETTINGS_CATEGORIES = [
  { id: "sudo", labelKey: "settingsQuickSudo" },
  { id: "agent", labelKey: "agentTerminalSection" },
  { id: "transfer", labelKey: "downloadSettings.title" },
  { id: "terminal", labelKey: "settingsNav.terminal" },
  { id: "security", labelKey: "settingsNav.security" },
  { id: "mcp", labelKey: "mcpLimits.title" },
] as const;
type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];
const settingsCategory = ref<SettingsCategory>("sudo");
const auditOpen = ref(false);
const settingsLoading = ref(false);
const settingsLoadFailed = ref(false);
const settingsSaving = ref(false);
const settingsMeta = ref<SshSettings>();
// 终端 MCP 模式快速开关（工具栏弹出层）：连接级 agentTerminalMode 的就地入口，
// 与设置弹窗共用 ssh/settings/set，值语义见 lib/agentTerminal.ts。
const agentModeOpen = ref(false);
const agentMode = ref<AgentTerminalMode>("off");
const agentModeBusy = ref(false);
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
const downloadUseDefaultDraft = ref(loadDownloadUseDefaultDir());
const downloadConflictDraft = ref<DownloadConflictPolicy>("rename");
// 全局 quick sudo 配置集中管理：列表与编辑弹窗状态（密钥只在提交时发送）。
const sudoProfiles = ref<SudoProfileView[]>([]);
const sudoProfilesLoading = ref(false);
const sudoProfilesError = ref("");
const profilesOpen = ref(false);
// 设置弹窗内联的 quick sudo 配置档管理 section（展开/收起；独立 profiles 弹窗
// 仍是工具栏 KeyRound 的入口，两者共存复用同一份 sudoProfiles/草稿状态）。
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
const chmodTarget = ref<SftpEntry>();
const chmodDraft = ref("");
const chmodSubmitting = ref(false);
const diskUsage = ref<DiskUsage>();
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
const searchOpen = ref(false);
// 打开搜索面板时的种子状态：选区首行预填 + 持久化的选项开关（见 openTerminalSearch）。
const searchSeedQuery = ref("");
const searchSeedOptions = ref<TerminalSearchOptions>(sanitizeSearchOptions(null));
const searchMatchState = ref<TerminalSearchMatchState>("idle");
const searchResultIndex = ref(0);
const searchResultCount = ref(0);
const pasteConfirm = ref<PasteConfirmation>();
// 终端拖入文件的落点询问：null 表示取消；"cwd" 用 SFTP 当前目录（目录跟随
// 开启时即 shell cwd）；{ dir } 是用户输入的目标目录（文件原名落其下）。
const dropUploadPrompt = ref<{ files: File[] }>();
const dropUploadTarget = ref<"cwd" | "custom">("cwd");
const dropUploadPathInput = ref("");
const dropUploadPathInputEl = ref<HTMLInputElement>();
const terminalFontSize = ref(appearance.value.terminal.fontSize);
// 终端 WebGL 渲染加速（对标 iShell GPU 加速）：localStorage 全局偏好，
// 默认开；WebGL 不可用（headless/无 context）时静默回退 DOM 渲染。只有主
// 终端长期挂 renderer；回放弹窗保持 DOM 渲染，GIF 导出在导出期间给离屏
// 终端临时挂载（取像素依赖 canvas），导出完随终端 dispose 释放 context。
const webglEnabled = ref(loadWebglEnabled());
const webglRenderer = ref<WebglRendererLike | null>(null);
// True while attachSession sits inside its bounded backoff loop; turns the
// status pill and overlay into the dedicated "reconnecting" phase.
const reconnectPending = ref(false);
// Pure-display reconnect countdown for the status pill: seconds until the
// next retry plus the progress through the current backoff delay.
const reconnectCountdown = ref<ReconnectCountdown | null>(null);
let reconnectNextAt = 0;
let reconnectDelayMs = 0;
let reconnectCountdownTimer = 0;
// Set the moment a backoff loop starts; consumed by afterSessionConnected to
// show the "connection restored" notice (with cwd context) only after a real
// reconnect, not on the initial connect.
let reconnectWasPending = false;
const commandMarker = reactive({
  installed: false,
  active: false,
  command: "",
  exitCode: null as number | null,
  durationMs: null as number | null,
  cwd: "",
  // Start timestamp of the currently running command; drives the 1s tick that
  // keeps the marker strip duration live while a command is in flight.
  startedAt: null as number | null,
});
// Live elapsed milliseconds for the running marker (null when idle or finished).
const commandMarkerElapsed = ref<number | null>(null);
const sftpSearch = ref("");
const sftpTypeFilter = ref<SftpTypeFilter>("all");
const selectedUris = ref<string[]>([]);
const lastClickedUri = ref("");
const sftpClipboard = ref<SftpClipboard>();
const pasteBusy = ref(false);
const pathHistoryOpen = ref(false);
const pathHistories = reactive<Record<string, string[]>>(loadPathHistories());
// SFTP 路径书签（全局清单，sftp-bookmarks.json）：路径栏星标收藏 + 路径弹层内跳转/删除。
const sftpBookmarks = ref<SftpBookmark[]>([]);
const bookmarkSaveOpen = ref(false);
const bookmarkSaving = ref(false);
const bookmarkLabelDraft = ref("");
const newFileDialog = ref(false);
const newFileDraft = ref("");
const newFileSubmitting = ref(false);
const attrsTarget = ref<SftpEntry>();
const attrsInfo = ref<SftpStatInfo>();
const attrsLoading = ref(false);
const attrsMode = ref("");
const attrsSubmitting = ref(false);
const batchDeleteOpen = ref(false);
const batchDeleteSubmitting = ref(false);
// Aggregated progress for multi-item batch operations (delete / archive);
// null while no batch is in flight.
const batchProgress = ref<BatchProgressState | null>(null);

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let searchAddon: SearchAddon | undefined;
let terminalPasteHandler: ((event: ClipboardEvent) => void) | undefined;
let terminalWheelHandler: ((event: WheelEvent) => void) | undefined;
// 点击定位光标（iTerm2 风格）：按下位置记忆 + 松开时判定“原地点击”。
let terminalMouseDownHandler: ((event: MouseEvent) => void) | undefined;
let terminalMouseUpHandler: ((event: MouseEvent) => void) | undefined;
let terminalMouseDownAt: { clientX: number; clientY: number } | undefined;
let pasteConfirmResolver: ((accepted: boolean) => void) | undefined;
let dropUploadResolver: ((choice: "cancel" | "cwd" | { dir: string }) => void) | undefined;
let zoomNoticeTimer = 0;
let resizeObserver: ResizeObserver | undefined;
let disposeInput: { dispose(): void } | undefined;
let disposeSelectionCopy: { dispose(): void } | undefined;
let unsubscribeEvent: (() => void) | undefined;
let unsubscribeBinary: (() => void) | undefined;
let unsubscribeAppearance: (() => void) | undefined;
let unsubscribeTheme: (() => void) | undefined;
let unsubscribeLocale: (() => void) | undefined;
let unsubscribeContext: (() => void) | undefined;
let unsubscribeFileDrag: (() => void) | undefined;
let unsubscribeFileDrop: (() => void) | undefined;
let persistTimer = 0;
let resizeTimer = 0;
let reconnectTimer = 0;
let reconnectAttempt = 0;
let disposed = false;
const OPEN_RETRY_MAX = 3;
let openRetryAttempt = 0;
let lastSequence = 0;
let replayInFlight = false;
// Consecutive replays that returned complete without filling the detected
// sequence hole. A sidecar that keeps reporting complete on a gap that never
// closes cannot self-heal by retrying — after a few attempts the drain must
// resync past the hole instead of spinning the replay loop forever.
let replayNoProgress = 0;
let noticeTimer = 0;
let errorTimer = 0;
let commandMarkerTimer = 0;
let agentPromptTimer = 0;
let zmodemSentry: ZmodemSentry | null = null;
let zmodemSession: ZmodemSession | null = null;
let pendingZmodemFiles: File[] = [];
let zmodemDetectionTimer = 0;
let zmodemSampledAt = 0;
let zmodemSampledBytes = 0;
// trzsz：filter 常驻（与 zmodem sentry 同一条下行流），进度状态机与速度采样。
let trzszFilter: TrzszFilter | null = null;
let trzszProgress: TrzszProgressState = initialTrzszProgressState();
let trzszSpeedSample: TransferSpeedSample | undefined;
let trzszDetectionTimer = 0;
let trzszWatchdogTimer = 0;
let trzszOverlayTimer = 0;
let trzszPickResolver: ((files: File[] | undefined) => void) | undefined;
let pendingTerminalInput = "";
let activeTerminalSessionId = "";
const pendingTerminalFrames = new Map<number, { stream: number; data: Uint8Array }>();
const uploadAckWaiters = new Map<string, { nextOffset: number; resolve: () => void; reject: (error: Error) => void; timer: number }>();
const downloadChunkWaiters = new Map<string, { offset: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: number }>();
const transferSamples = new Map<string, TransferSpeedSample>();
// Download task ids the user cancelled from the transfer panel; lets the download
// loop distinguish a user cancel (notice) from a real failure (error banner).
const cancelledTransferTasks = new Set<string>();
const directoryParser = new Osc7DirectoryParser();
// OSC 633 shell-integration markers (pure frontend parse; no-op streams pass through).
const commandMarkerParser = new Osc633CommandParser();

// Large-output rendering throttle: coalesce consecutive PTY frames into one
// merged xterm write per animation frame (capped, order preserving). The sink
// reads `terminal` lazily so it also works across terminal recreation.
const terminalWriteThrottle: TerminalWriteThrottle = createTerminalWriteThrottle({
  sink: (data) => terminal?.write(data),
});
const terminalInputQueue = createTerminalInputQueue({
  send: (sessionId, payload) => window.dbxPlugin.sendBinary(`ssh/terminal/in/${sessionId}`, payload),
  onError: (cause) => showError(cause, "terminal"),
});

const locale = ref("zh-CN");
const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(locale.value, key, values);
const connectionId = computed(() => normalizeConnectionText(hostContext.value.connectionId));
// Host API 1.1 provides a stable workbenchId in the host context; on 1.0 a
// locally generated id keeps session scoping per workbench instance.
const fallbackWorkbenchId = crypto.randomUUID();
const workbenchId = computed(() => normalizeConnectionText(hostContext.value.workbenchId) || fallbackWorkbenchId);
const restored = computed(() => hostContext.value.restored === true);
const connection = computed<ConnectionSummary>(() => {
  const value = hostContext.value.connection;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    name: normalizeConnectionText(raw.name),
    host: normalizeConnectionText(raw.host),
    port: normalizeConnectionPort(raw.port),
    username: normalizeConnectionText(raw.username),
    color: normalizeConnectionText(raw.color),
    readOnly: raw.readOnly === true,
  };
});
const canWrite = computed(() => !connection.value.readOnly && !connectionReadOnly.value);
const selectedEntry = computed(() => entries.value.find((entry) => entry.uri === selectedPath.value));
const connected = computed(() => terminalState.value === "connected" && !!session.value);
const sessionStatus = computed<WorkbenchSessionStatus>(() => describeWorkbenchSessionStatus(terminalState.value, { reattaching: reconnectPending.value }));
// 连接卡片四态：用户取消优先于底层 terminalState（在途 open 仍是 connecting）；
// open 成功后的短暂 success 态优先于 connecting；其余（error/disconnected）
// 统一呈现错误行 + Reconnect。
const connectCardState = computed<"connecting" | "error" | "cancelled" | "success">(() => {
  if (connectCancelled.value) return "cancelled";
  if (connectSucceeded.value) return "success";
  return terminalState.value === "connecting" ? "connecting" : "error";
});
const connectLogEntries = computed(() => connectLog.entries.value);
// Connect-error friendlification: raw sidecar/russh error strings stay as the
// tooltip detail while the primary line renders a localized per-category hint
// (auth / refused / DNS / timeout / host key). Non-connect errors pass through.
const terminalErrorDetail = computed(() => terminalError.value);
const terminalErrorFriendly = computed(() => {
  const kind = classifyConnectError(terminalError.value);
  return kind ? t(connectErrorKey(kind)) : "";
});
// Reconnect countdown lifecycle: while the backoff loop is pending a 250ms
// tick recomputes the pure countdown; any exit from "reconnecting" stops it.
watch(reconnectPending, (pending) => {
  if (pending) reconnectWasPending = true;
  if (reconnectCountdownTimer) {
    window.clearInterval(reconnectCountdownTimer);
    reconnectCountdownTimer = 0;
  }
  if (!pending) {
    reconnectCountdown.value = null;
    return;
  }
  const update = () => {
    reconnectCountdown.value = describeReconnectCountdown({
      pending: true,
      attempt: reconnectAttempt,
      nextAt: reconnectNextAt,
      now: Date.now(),
      delayMs: reconnectDelayMs,
    });
  };
  update();
  reconnectCountdownTimer = window.setInterval(update, 250);
});
const commandOutputText = computed(() => (commandResult.value ? sanitizeCommandOutput(commandResult.value.output) : ""));
// AI 终端同步模式下拉随档位变化的说明文案（off/auto/strict 三键 hint）。
const agentTerminalModeHint = computed(() => t(
  settingsDraft.agentTerminalMode === "auto" ? "agentTerminalAutoHint"
  : settingsDraft.agentTerminalMode === "strict" ? "agentTerminalStrictHint"
  : "agentTerminalOffHint",
));
const agentModeHint = computed(() => t(
  agentMode.value === "auto" ? "agentTerminalAutoHint"
  : agentMode.value === "strict" ? "agentTerminalStrictHint"
  : "agentTerminalOffHint",
));
// Hover tooltip for the terminal command marker strip: full command, exit
// code, duration and working directory (localized, multi-line).
const commandMarkerDetails = computed(() => commandMarkerTooltip(
  {
    command: commandMarker.command,
    exitCode: commandMarker.exitCode,
    durationMs: commandMarker.durationMs,
    elapsedMs: commandMarkerElapsed.value,
    cwd: commandMarker.cwd,
  },
  {
    command: t("terminalCommand.tooltipCommand"),
    exitCode: t("terminalCommand.tooltipExitCode"),
    duration: t("terminalCommand.tooltipDuration"),
    directory: t("terminalCommand.tooltipDirectory"),
  },
));
const connectionIdentity = computed(() => {
  const host = connection.value.host || connection.value.name || connectionId.value || "–";
  const identity = connection.value.username ? `${connection.value.username}@${host}` : host;
  const port = connection.value.port && connection.value.port !== 22 ? `:${connection.value.port}` : "";
  return `${identity}${port}`;
});
// 认证方式的本地化标签：已知方法名走 i18n，未知值原样展示（只读信息）。
const connectionAuthMethodLabel = computed(() => formatAuthMethodLabel(connectionAuthMethod.value, (method) => {
  const labels: Record<KnownAuthMethod, string> = {
    password: t("authMethodPassword"),
    "private-key": t("authMethodPrivateKey"),
    "private-key-password": t("authMethodPrivateKeyPassword"),
    agent: t("authMethodAgent"),
    none: t("authMethodNone"),
  };
  return labels[method];
}));
// 连接色染色按主题分级（light 压低 alpha 保 muted 文字 AA 对比度，P2-4）。
const toolbarStyle = computed(() => toolbarTintStyle(connection.value.color, appearance.value.colorScheme));
const terminalBasis = computed(() => ({ flexBasis: sftpPaneOpen.value ? `${splitRatio.value}%` : "100%" }));
const orderedPaneClass = computed(() => [
  paneOrder.value === "sftp-left" ? "panes panes--reversed" : "panes",
  sftpPaneOpen.value ? "" : "panes--solo",
].filter(Boolean).join(" "));
const sortedEntries = computed(() => {
  const direction = sort.value.direction === "asc" ? 1 : -1;
  return [...entries.value].sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (left.kind !== "directory" && right.kind === "directory") return 1;
    let result = 0;
    if (sort.value.column === "size") result = (left.size ?? -1) - (right.size ?? -1);
    else if (sort.value.column === "modified") result = (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0);
    else result = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    return result * direction;
  });
});
// Object insertion order is the order a task joined this workbench. Do not
// sort by taskId: task IDs are UUIDs, so doing so randomly reorders a batch.
const transferList = computed(() => Object.values(transferTasks));
const activeTransfers = computed(() => transferList.value.filter((task) => task.status === "queued" || task.status === "running").length);
const zmodemBusy = computed(() => zmodemState.value !== "idle");
const zmodemPercent = computed(() => zmodemTotalSize.value > 0 ? Math.min(100, Math.round((zmodemTransferred.value / zmodemTotalSize.value) * 100)) : 0);
// 文件传输占用统一语义：ZMODEM 或 trzsz 任一持有终端流即视为 busy。
const terminalTransferBusy = computed(() => zmodemBusy.value || trzszBusy.value);
const trzszBusy = computed(() => trzszPhase.value === "waiting" || trzszPhase.value === "transferring");
const trzszOverlayVisible = computed(() => trzszPhase.value !== "idle");
const sftpGridStyle = computed(() => ({
  gridTemplateColumns: ["minmax(120px, 1fr)", visibleColumns.value.includes("size") ? "72px" : "", visibleColumns.value.includes("modified") ? "128px" : "", visibleColumns.value.includes("permissions") ? "84px" : ""].filter(Boolean).join(" "),
  minWidth: `${180 + (visibleColumns.value.includes("size") ? 78 : 0) + (visibleColumns.value.includes("modified") ? 134 : 0) + (visibleColumns.value.includes("permissions") ? 90 : 0)}px`,
}));
const sftpFiltersActive = computed(() => sftpSearch.value.trim() !== "" || sftpTypeFilter.value !== "all");
const visibleEntries = computed(() => filterSftpEntries(sortedEntries.value, sftpSearch.value, sftpTypeFilter.value));
const selectedEntries = computed(() => entries.value.filter((entry) => selectedUris.value.includes(entry.uri)));
const currentPathHistory = computed(() => pathHistories[connectionId.value] || []);
const previewDirty = computed(() => previewEditable.value && previewDraft.value !== previewBaseline.value);
// 编辑保存走 sftp/write 整文件覆写：只有完整加载（未截断）且不超直写上限的
// 文本才允许进入编辑，否则保存会把未加载部分丢掉。
const previewEditableAllowed = computed(() => canWrite.value && previewMode.value === "text" && !previewTruncated.value && previewSize.value <= MAX_DIRECT_WRITE_BYTES);
const mcpInputsValid = computed(() => [mcpDraft.readMiB, mcpDraft.uploadMiB, mcpDraft.downloadMiB]
  .every((value) => /^\d+$/.test(value.trim()) && Number.parseInt(value.trim(), 10) > 0));

function initialState(): WorkbenchState {
  const value = hostContext.value.workbenchState;
  return value && typeof value === "object" ? (value as WorkbenchState) : {};
}

function restoreUiState() {
  const state = initialState();
  currentPath.value = typeof state.sftpPath === "string" ? normalizeRemotePath(state.sftpPath) : "/";
  splitRatio.value = typeof state.splitRatio === "number" && state.splitRatio >= 35 && state.splitRatio <= 80 ? state.splitRatio : 58;
  paneOrder.value = state.paneOrder === "sftp-left" ? "sftp-left" : "terminal-left";
  sftpPaneOpen.value = resolveSftpPaneOpen(state, sftpPaneDefaultOpen.value);
  followDirectory.value = state.followDirectory === true;
  sudoMode.value = state.sudoMode === true && canWrite.value;
  visibleColumns.value = Array.isArray(state.visibleColumns) ? state.visibleColumns.filter((column): column is SftpColumn => ["size", "modified", "permissions"].includes(column)) : ["size", "modified"];
  lastSequence = typeof state.terminalSequence === "number" ? state.terminalSequence : 0;
}

function writeWorkbenchState() {
  return window.dbxPlugin.workbenchState?.set({
    sessionId: session.value?.sessionId,
    terminalSequence: lastSequence,
    sftpPath: currentPath.value,
    followDirectory: followDirectory.value,
    sudoMode: sudoMode.value,
    splitRatio: splitRatio.value,
    paneOrder: paneOrder.value,
    sftpPaneOpen: sftpPaneOpen.value,
    visibleColumns: visibleColumns.value,
  }).catch(() => undefined);
}

function persistState() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    void writeWorkbenchState();
  }, 150);
}

// —— 自定义 tooltip（对齐 DBX 宿主的气泡提示）——
// 全局接管 title 属性：悬停时把值挪到 data-tooltip（抑制原生慢速灰框），
// 350ms 后显示主题化气泡；下方空间不足翻到上方。模板无需改动，所有现有
// 和未来的 title 自动生效。
const tooltip = ref<{ text: string; x: number; y: number; above: boolean; arrowOffset: number } | null>(null);
const tooltipBubble = ref<HTMLElement>();
let tooltipEl: HTMLElement | null = null;
let tooltipTimer = 0;

function hideTooltip() {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = 0;
  tooltip.value = null;
  tooltipEl = null;
}

function onTooltipOver(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest?.("[title], [data-tooltip]") as HTMLElement | null;
  if (target === tooltipEl) return;
  hideTooltip();
  if (!target) return;
  // title → data-tooltip：Vue 绑定只在值变化时重写 title，下次悬停再挪一次。
  const title = target.getAttribute("title");
  if (title !== null) {
    target.setAttribute("data-tooltip", title);
    target.removeAttribute("title");
  }
  const text = target.getAttribute("data-tooltip")?.trim();
  if (!text) return;
  tooltipEl = target;
  tooltipTimer = window.setTimeout(() => {
    tooltipTimer = 0;
    if (!target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const above = rect.bottom + 34 > window.innerHeight && rect.top > 34;
    const center = rect.left + rect.width / 2;
    tooltip.value = { text, x: center, y: above ? rect.top - 6 : rect.bottom + 6, above, arrowOffset: 0 };
    // 量出气泡实际宽度后重新钳位，保证整框（而非仅中心点）落在视口内；
    // 小三角按钳位偏差反向偏移，继续对准触发元素。
    void nextTick(() => {
      const bubble = tooltipBubble.value;
      const current = tooltip.value;
      if (!bubble || !current) return;
      const half = bubble.offsetWidth / 2;
      const clamped = Math.max(half + 8, Math.min(current.x, window.innerWidth - half - 8));
      if (clamped !== current.x) {
        tooltip.value = { ...current, x: clamped, arrowOffset: center - clamped };
      }
    });
  }, 350);
}

function onTooltipOut(event: MouseEvent) {
  if (!tooltipEl) return;
  const related = event.relatedTarget as HTMLElement | null;
  if (related && tooltipEl.contains(related)) return;
  hideTooltip();
}

// 通知/错误横幅的动作按钮（下载完成的「打开文件/打开目录」、失败的「重试」）。
interface BannerAction {
  label: string;
  run: () => void;
}
function showNotice(message: string, actions: BannerAction[] = []) {
  notice.value = message;
  noticeActions.value = actions;
  window.clearTimeout(noticeTimer);
  // 带动作的通知留得更久，给用户点按钮的时间。
  noticeTimer = window.setTimeout(() => {
    notice.value = "";
    noticeActions.value = [];
  }, actions.length ? 8000 : 3500);
}

function showError(cause: unknown, target: "terminal" | "sftp" = "sftp", retry?: () => void) {
  const message = cause instanceof Error ? cause.message : String(cause);
  // 常见错误（权限不足/文件不存在）翻成友好文案；其余原样透出。
  const display = friendlySftpError(message, (key) => t(key)) ?? message;
  if (target === "terminal") terminalError.value = display;
  else {
    sftpError.value = display;
    sftpErrorRetry.value = retry ?? null;
    // 错误横幅与通知同款自动消失（保留手动关闭），时限放宽到 8s：
    // 错误信息通常更长，需要读完的时间。
    window.clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => {
      sftpError.value = "";
      sftpErrorRetry.value = null;
    }, 8000);
  }
}

function terminalTheme() {
  const colors = appearance.value.colors;
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: appearance.value.colorScheme === "dark" ? "#5f6f8a88" : "#93b4e088",
    ...TERMINAL_ANSI[appearance.value.colorScheme],
  };
}

function applyAppearance(next: DbxPluginAppearanceInput) {
  // 宿主可能缺字段（1.0 或部分下发、1.1 theme 通道只带颜色令牌），按 DBX 规范色板补齐。
  const resolved = resolveAppearance(next);
  appearance.value = resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved.colorScheme;
  root.style.colorScheme = resolved.colorScheme;
  root.style.setProperty("--background", resolved.colors.background);
  root.style.setProperty("--foreground", resolved.colors.foreground);
  root.style.setProperty("--muted", resolved.colors.muted);
  root.style.setProperty("--muted-foreground", resolved.colors.mutedForeground);
  root.style.setProperty("--accent", resolved.colors.accent);
  root.style.setProperty("--accent-foreground", resolved.colors.accentForeground);
  root.style.setProperty("--border", resolved.colors.border);
  root.style.setProperty("--destructive", resolved.colors.destructive);
  root.style.setProperty("--popover", DBX_POPOVER[resolved.colorScheme]);
  root.style.setProperty("--ssh-terminal-background", resolved.colors.background);
  root.style.setProperty("--ui-font-family", resolved.ui.fontFamily);
  root.style.setProperty("--terminal-font-family", resolved.terminal.fontFamily);
  if (terminal) {
    terminal.options.theme = terminalTheme();
    terminal.options.fontFamily = resolved.terminal.fontFamily;
    // 宿主下发的字体大小即缩放基准；外观切换后回到基准值，
    // 但用户 A+/A- 调过的字号（localStorage）优先于宿主基准。
    const persistedFontSize = loadPersistedTerminalFontSize();
    terminalFontSize.value = persistedFontSize ?? resolved.terminal.fontSize;
    terminal.options.fontSize = terminalFontSize.value;
    scheduleFit();
  }
}

function createTerminal() {
  if (!terminalHost.value || terminal) return;
  terminalFontSize.value = loadPersistedTerminalFontSize() ?? appearance.value.terminal.fontSize;
  terminal = new Terminal({
    convertEol: false,
    cursorBlink: true,
    // 细竖线光标（bar）：块状光标在宽字距下显得笨重，竖线更接近常规输入框观感。
    cursorStyle: "bar",
    fontFamily: appearance.value.terminal.fontFamily,
    fontSize: terminalFontSize.value,
    lineHeight: 1.15,
    scrollback: 25_000,
    // SearchAddon 的 highlight decorations 走 proposed API，缺这一项会在
    // findNext/registerDecoration 时直接抛 "allowProposedApi option"。
    allowProposedApi: true,
    theme: terminalTheme(),
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(terminalHost.value);
  terminal.attachCustomKeyEventHandler(handleTerminalKey);
  searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
    if (!searchOpen.value) return;
    searchResultCount.value = resultCount;
    searchResultIndex.value = resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0;
    searchMatchState.value = resultCount > 0 ? "match" : "no-match";
  });
  disposeInput = terminal.onData((data) => {
    if (!session.value) return;
    // 文件传输占用路由：trzsz 持有流时，传输中的输入进 filter（Ctrl+C 停传输、
    // 其余吞掉），等待协商期直接吞掉（防止杂散键入干扰 trz 握手）；zmodem 持有
    // 流时输入保持阻塞，否则走普通 PTY 键盘写入（8 字节序号前缀已封装）。
    const route = resolveTerminalInputRoute({ zmodemBusy: zmodemBusy.value, trzszBusy: trzszBusy.value });
    if (route === "trzsz") {
      if (trzszPhase.value === "transferring") trzszFilter?.processTerminalInput(data);
      return;
    }
    if (route === "blocked") return;
    trackPendingInput(data);
    sendTerminalBytes(new TextEncoder().encode(data));
  });
  // 选中复制（可在设置里关闭）：选择一变化即静默写入剪贴板，不弹提示。
  disposeSelectionCopy = terminal.onSelectionChange(() => {
    if (!termSelectCopy.value || !terminal?.hasSelection()) return;
    void writeClipboardText(terminal.getSelection(), clipboardDeps()).catch(() => undefined);
  });
  // 捕获阶段的 paste 监听：拦截 Ctrl+V 之外的所有粘贴路径（浏览器右键菜单等），
  // 统一走风险确认后再写入终端。
  terminalPasteHandler = (event) => interceptTerminalPaste(event);
  terminalHost.value.addEventListener("paste", terminalPasteHandler, true);
  terminalWheelHandler = (event) => handleTerminalWheel(event);
  terminalHost.value.addEventListener("wheel", terminalWheelHandler, { passive: false, capture: true });
  terminalMouseDownHandler = (event) => handleTerminalMouseDown(event);
  terminalHost.value.addEventListener("mousedown", terminalMouseDownHandler);
  terminalMouseUpHandler = (event) => handleTerminalMouseUp(event);
  terminalHost.value.addEventListener("mouseup", terminalMouseUpHandler);
  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(terminalHost.value);
  if (webglEnabled.value) {
    webglRenderer.value = attachWebglRenderer(terminal, () => new WebglAddon());
  }
  if (highlightEnabled.value) attachHighlightRender();
  scheduleFit();
}

// 设置开关即时生效：开=挂 renderer（失败静默回退 DOM），关=dispose。
function setWebglEnabled(next: boolean) {
  webglEnabled.value = next;
  persistWebglEnabled(next);
  if (!terminal) return;
  webglRenderer.value = syncWebglRenderer(terminal, next, webglRenderer.value, () => new WebglAddon());
}

function handleTerminalKey(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey;
  if (event.type !== "keydown") return true;
  // xterm 的 false 只跳过终端处理，不会取消浏览器默认动作或冒泡。
  const consume = () => {
    event.preventDefault();
    event.stopPropagation();
    return false;
  };
  if (mod && (event.key === "f" || event.key === "F")) {
    openTerminalSearch();
    return consume();
  }
  if (mod && event.key === "0") {
    resetTerminalZoom();
    return consume();
  }
  if (event.key === "Escape" && searchOpen.value) {
    closeTerminalSearch();
    return consume();
  }
  // Windows Terminal/iTerm2 风格组合键：Ctrl/Cmd+V 与 Ctrl/Cmd+Shift+V 粘贴，
  // Ctrl/Cmd+C 有选区时复制、无选区时保持发给远端（SIGINT）。
  const keyAction = resolveTerminalKeyAction({ mod, shiftKey: event.shiftKey, key: event.key, hasSelection: terminal?.hasSelection() ?? false });
  if (keyAction === "paste") {
    // 不取消默认动作：放行浏览器原生 paste 事件（自带真实 clipboardData，
    // 沙箱 iframe 中无需剪贴板读权限），由 terminalHost 的 capture 拦截器
    // 统一走风险确认。stopPropagation 挡住宿主/文档级快捷键；返回 false
    // 让 xterm 跳过该键，否则 Ctrl+V 会先作为 ^V 字符发给远端。
    event.stopPropagation();
    return false;
  }
  if (keyAction === "copy") {
    void copyTerminalSelection();
    return consume();
  }
  return true;
}

function handleTerminalWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  adjustTerminalZoom(event.deltaY < 0 ? 1 : -1);
}

// 点击定位光标（iTerm2/kitty 风格）：readline 只认按键，所以在光标所在逻辑行内
// 的“原地点击”（无拖拽成选区）换算成 N 次左右方向键发给远端；行外点击不动作，
// 避免方向键把 shell 翻进历史命令。鼠标上报（vim/htop）与备用屏（TUI 全屏应用）
// 时点击属于应用自身语义，一律不代发。
function handleTerminalMouseDown(event: MouseEvent) {
  terminalMouseDownAt = event.button === 0 ? { clientX: event.clientX, clientY: event.clientY } : undefined;
}

function handleTerminalMouseUp(event: MouseEvent) {
  const down = terminalMouseDownAt;
  terminalMouseDownAt = undefined;
  if (!down || !terminal || !terminalHost.value || !session.value) return;
  if (terminal.hasSelection()) return;
  if (Math.abs(event.clientX - down.clientX) > 2 || Math.abs(event.clientY - down.clientY) > 2) return;
  if (terminal.modes.mouseTrackingMode !== "none") return;
  const buffer = terminal.buffer.active;
  if (buffer.type !== "normal") return;
  const click = cellFromMouseEvent(terminalHost.value, { cols: terminal.cols, rows: terminal.rows }, event.clientX, event.clientY);
  if (!click) return;
  const move = resolveClickCursorMove({ buffer, cols: terminal.cols, click });
  if (!move) return;
  const route = resolveTerminalInputRoute({ zmodemBusy: zmodemBusy.value, trzszBusy: trzszBusy.value });
  if (route !== "pty") return;
  sendTerminalBytes(new TextEncoder().encode(clickCursorArrows(move)));
}

function adjustTerminalZoom(delta: number) {
  const current = terminalFontSize.value;
  const next = clampFontSize(current, delta);
  if (next === current) return;
  applyTerminalFontSize(next);
}

function resetTerminalZoom() {
  const base = appearance.value.terminal.fontSize;
  if (terminalFontSize.value === base) return;
  applyTerminalFontSize(base);
}

function loadPersistedTerminalFontSize(): number | null {
  try {
    const raw = window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY);
    const parsed = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampFontSize(parsed, 0) : null;
  } catch {
    return null;
  }
}

function applyTerminalFontSize(size: number) {
  terminalFontSize.value = size;
  if (terminal) {
    terminal.options.fontSize = size;
    scheduleFit();
  }
  try {
    window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(size));
  } catch {
    // localStorage 不可用时字号仅对当前会话生效。
  }
  window.clearTimeout(zoomNoticeTimer);
  zoomNoticeTimer = window.setTimeout(() => showNotice(t("terminalZoom.fontSize", { size })), 500);
}

function openTerminalSearch() {
  if (!terminal) return;
  terminalMenu.value = undefined;
  // iTerm2 风格：打开搜索时用当前选区首行预填查询，并带入持久化的选项开关。
  searchSeedQuery.value = terminalSearchSeedFromSelection(terminal.getSelection() || "");
  searchSeedOptions.value = sanitizeSearchOptions(window.localStorage.getItem(TERMINAL_SEARCH_OPTIONS_KEY));
  searchOpen.value = true;
}

function closeTerminalSearch() {
  searchOpen.value = false;
  resetSearchResults();
  searchAddon?.clearDecorations();
  terminal?.focus();
}

function clearTerminalSearch() {
  resetSearchResults();
  searchAddon?.clearDecorations();
}

function resetSearchResults() {
  searchMatchState.value = "idle";
  searchResultCount.value = 0;
  searchResultIndex.value = 0;
}

function runTerminalSearch(query: string, options: { caseSensitive: boolean; regex: boolean; wholeWord: boolean }, direction: "next" | "prev") {
  if (!searchAddon || !query) return;
  const searchOptions: ISearchOptions = {
    caseSensitive: options.caseSensitive,
    regex: options.regex,
    wholeWord: options.wholeWord,
    decorations: {
      matchBackground: "#64748b55",
      matchOverviewRuler: "#64748b",
      activeMatchBackground: "#3b82f655",
      activeMatchColorOverviewRuler: "#3b82f6",
    },
  };
  if (direction === "prev") searchAddon.findPrevious(query, searchOptions);
  else searchAddon.findNext(query, searchOptions);
}

function trackPendingInput(data: string) {
  if (data.includes("\u001b")) return;
  for (const character of data) {
    if (character === "\r" || character === "\n" || character === "\u0003") pendingTerminalInput = "";
    else if (character === "\u007f") pendingTerminalInput = pendingTerminalInput.slice(0, -1);
    else if (character >= " ") pendingTerminalInput += character;
  }
}

function sendTerminalBytes(data: Uint8Array) {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  terminalInputQueue.enqueue(sessionId, normalizeTerminalInputBytes(data));
}

function scheduleFit() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!terminal || !fitAddon || !terminalHost.value?.clientWidth || !terminalHost.value.clientHeight) return;
    try {
      fitAddon.fit();
      // trzsz 进度条按终端列宽渲染（filter 内部文本进度条虽未启用，列宽保持同步）。
      trzszFilter?.setTerminalColumns(terminal.cols);
      if (session.value) {
        void window.dbxPlugin.notify("ssh/terminal/resize", { sessionId: session.value.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      }
    } catch {
      // The iframe can briefly be detached while DBX switches tabs.
    }
  }, 20);
}

function stopCommandMarkerTick() {
  if (commandMarkerTimer) {
    window.clearInterval(commandMarkerTimer);
    commandMarkerTimer = 0;
  }
  commandMarkerElapsed.value = null;
}

function startCommandMarkerTick(startedAt: number) {
  stopCommandMarkerTick();
  commandMarkerTimer = window.setInterval(() => {
    commandMarkerElapsed.value = runningCommandElapsedMs(startedAt, Date.now());
  }, 1000);
  commandMarkerElapsed.value = runningCommandElapsedMs(startedAt, Date.now());
}

function resetCommandMarker() {
  commandMarkerParser.reset();
  stopCommandMarkerTick();
  commandMarker.installed = false;
  commandMarker.active = false;
  commandMarker.command = "";
  commandMarker.exitCode = null;
  commandMarker.durationMs = null;
  commandMarker.cwd = "";
  commandMarker.startedAt = null;
}

function applyCommandMarker(updates: Osc633StreamUpdates) {
  if (updates.shellIntegrationInstalled !== undefined) commandMarker.installed = updates.shellIntegrationInstalled;
  if (updates.commandActive !== undefined) commandMarker.active = updates.commandActive;
  if (updates.command !== undefined) commandMarker.command = updates.command;
  // A fresh "E" frame starts a new command: clear the previous result so the
  // strip flips to the running state. The "A" frame's lastExitCode=null reset
  // is ignored on purpose — the finished result stays visible at the prompt
  // until the next command starts.
  if (updates.commandActive === true) {
    commandMarker.exitCode = null;
    commandMarker.durationMs = null;
    // A fresh "E" frame also starts the 1s tick so the marker strip shows a
    // live duration while the command runs; the final durationMs from the
    // "D" frame takes over once the tick stops.
    commandMarker.startedAt = Date.now();
    startCommandMarkerTick(commandMarker.startedAt);
  } else if (updates.commandActive === false) {
    stopCommandMarkerTick();
  }
  if (updates.lastExitCode !== undefined && updates.lastExitCode !== null) commandMarker.exitCode = updates.lastExitCode;
  if (updates.lastCommandDuration !== undefined) commandMarker.durationMs = updates.lastCommandDuration;
  if (updates.cwd !== undefined) {
    commandMarker.cwd = updates.cwd;
    // OSC 633 Cwd doubles as a directory-follow fallback when the backend could
    // not install OSC 7 tracking but the remote shell integration emits 633 frames.
    if (followDirectory.value && directoryTrackingSupported.value === false && updates.cwd) {
      void loadDirectory(updates.cwd, true);
    }
  }
}

function writeTerminalOutput(data: Uint8Array) {
  for (const path of directoryParser.push(data)) {
    if (followDirectory.value) void loadDirectory(path, true);
  }
  applyCommandMarker(commandMarkerParser.push(data));
  terminalWriteThrottle.write(data);
}

/**
 * Terminal output dispatch: ZMODEM owns the stream while busy; otherwise the
 * frame feeds the trzsz filter, which passes it through to the terminal and
 * watches for the remote `::TRZSZ:TRANSFER:` announce to take over exactly
 * one transfer. Plain frames thus reach the terminal untouched.
 */
function dispatchTerminalOutput(data: Uint8Array) {
  if (zmodemBusy.value) {
    writeTerminalOutput(data);
    return;
  }
  const announce = detectTrzszAnnounceFromBytes(data);
  if (announce) handleTrzszAnnounce(announce);
  ensureTrzszFilter().processServerOutput(data);
}

function resetZmodemSentry() {
  zmodemSentry = createZmodemSentry({
    send: sendTerminalBytes,
    toTerminal: dispatchTerminalOutput,
    onDetect: handleZmodemDetection,
    onRetract() {},
  });
}

function handleZmodemDetection(detection: ZmodemDetection) {
  if (!pendingZmodemFiles.length || detection.get_session_role() !== "send") {
    detection.deny();
    if (pendingZmodemFiles.length) finishZmodemUpload(new Error(t("zmodemUploadOnly")));
    return;
  }
  try {
    zmodemSession = detection.confirm();
  } catch (cause) {
    finishZmodemUpload(cause);
    return;
  }
  window.clearTimeout(zmodemDetectionTimer);
  zmodemState.value = "uploading";
  zmodemSampledAt = performance.now();
  zmodemSampledBytes = 0;
  const files = pendingZmodemFiles;
  void sendZmodemFiles(zmodemSession, files, updateZmodemProgress)
    .then(() => {
      showNotice(t("zmodemUploadComplete", { count: files.length }));
      finishZmodemUpload();
      void loadDirectory();
    })
    .catch(finishZmodemUpload);
}

function updateZmodemProgress(progress: ZmodemUploadProgress) {
  zmodemFileName.value = progress.file.name;
  zmodemTransferred.value = progress.totalTransferred;
  zmodemTotalSize.value = progress.totalSize;
  const now = performance.now();
  const elapsed = now - zmodemSampledAt;
  if (elapsed >= 250 || progress.totalTransferred === progress.totalSize) {
    const speed = elapsed > 0 ? ((progress.totalTransferred - zmodemSampledBytes) * 1000) / elapsed : 0;
    zmodemSpeed.value = zmodemSpeed.value ? zmodemSpeed.value * 0.65 + speed * 0.35 : speed;
    zmodemSampledAt = now;
    zmodemSampledBytes = progress.totalTransferred;
  }
}

function finishZmodemUpload(cause?: unknown) {
  const wasActive = zmodemState.value !== "idle";
  cancelZmodemUpload();
  if (!wasActive) return;
  if (cause) showError(new Error(t("zmodemUploadFailed", { error: cause instanceof Error ? cause.message : String(cause) })), "terminal");
  terminal?.focus();
}

/**
 * Silently tears the ZMODEM state down (abort the wire session, drop pending
 * files, reset the overlay, rebuild the sentry). Used both after a completed
 * or failed upload and when the SSH session is closed mid-transfer — without
 * it a closed session would leave zmodemBusy stuck true and terminal input
 * routed into a dead sentry.
 */
function cancelZmodemUpload() {
  window.clearTimeout(zmodemDetectionTimer);
  if (zmodemSession && !zmodemSession.has_ended()) {
    try { zmodemSession.abort(); } catch {}
  }
  pendingZmodemFiles = [];
  zmodemSession = null;
  zmodemState.value = "idle";
  zmodemFileName.value = "";
  zmodemTransferred.value = 0;
  zmodemTotalSize.value = 0;
  zmodemSpeed.value = 0;
  resetZmodemSentry();
}

// ---------------------------------------------------------------------------
// trzsz (trz / tsz)：官方 trzsz.js TrzszFilter 常驻下行流，announce 自动接管。
// 传输的协议协商/收发全在 filter 内，插件只负责：选文件（浏览器 File API）、
// 下载落盘（宿主 fileTransfer 优先、浏览器 <a download> 兜底）、进度 overlay。
// ---------------------------------------------------------------------------

const TRZSZ_DETECTION_TIMEOUT_MS = 5000;
const TRZSZ_WATCHDOG_TIMEOUT_MS = 15000;
const TRZSZ_SUCCESS_OVERLAY_MS = 2500;

/** Lazily wires the filter onto the terminal streams (keyboard input + output). */
function ensureTrzszFilter(): TrzszFilter {
  if (trzszFilter) return trzszFilter;
  const filter = new TrzszFilter({
    writeToTerminal: (output) => {
      if (typeof output === "string") writeTerminalOutput(new TextEncoder().encode(output));
      else if (output instanceof Uint8Array) writeTerminalOutput(output);
      else if (output instanceof ArrayBuffer) writeTerminalOutput(new Uint8Array(output));
    },
    // sendToServer 必须走现有 PTY 输入路径（8 字节 BE 序号前缀在 sendTerminalBytes 内封装）。
    sendToServer: (input) => sendTerminalBytes(typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input)),
    terminalColumns: terminal?.cols || 80,
  });
  installTrzszHandlers(filter, {
    pickUploadFiles: pickTrzszUploadFiles,
    saveDownloadedFiles: saveTrzszDownloadedFiles,
    emit: applyTrzszEvent,
  });
  trzszFilter = filter;
  return filter;
}

function handleTrzszAnnounce(announce: TrzszAnnounce) {
  // Announce 已到：无论等待态由谁进入（菜单触发或远端自行 trz/tsz），
  // 「等待远端响应」的检测定时器使命完成，必须先解除再判断占用。
  window.clearTimeout(trzszDetectionTimer);
  trzszDetectionTimer = 0;
  if (!canStartTrzszTransfer({ zmodemBusy: zmodemBusy.value, trzszBusy: trzszBusy.value })) return;
  // 看门狗：announce 后 filter 一直未发起传输（如去重拦截等边缘）时不让
  // waiting 态永久占用终端输入；filter 打开选文件框时即视为已接管并解除。
  window.clearTimeout(trzszWatchdogTimer);
  trzszWatchdogTimer = window.setTimeout(() => {
    trzszWatchdogTimer = 0;
    if (trzszPhase.value === "waiting") applyTrzszEvent({ type: "reset" });
  }, TRZSZ_WATCHDOG_TIMEOUT_MS);
  applyTrzszEvent({ type: "waiting", direction: announce.direction });
}

function applyTrzszEvent(event: TrzszProgressEvent) {
  trzszProgress = reduceTrzszProgress(trzszProgress, event);
  const state = trzszProgress;
  trzszPhase.value = state.phase;
  trzszDirection.value = state.direction;
  trzszFileName.value = state.fileName;
  trzszFileIndex.value = state.fileIndex;
  trzszFileCount.value = state.fileCount;
  trzszMessage.value = state.message;
  trzszPercent.value = trzszProgressPercent(state);
  if (event.type === "step") {
    trzszSpeedSample = sampleTransferSpeed(trzszSpeedSample, state.totalTransferred, performance.now());
    trzszSpeed.value = trzszSpeedSample.speed;
  } else {
    trzszSpeedSample = undefined;
    trzszSpeed.value = 0;
  }
  switch (event.type) {
    case "success":
      showNotice(t("trzszComplete", { count: Math.max(1, state.fileCount) }));
      window.clearTimeout(trzszOverlayTimer);
      // 成功态短暂可见后自动收起（失败态常驻，直到下一次传输或会话切换）。
      trzszOverlayTimer = window.setTimeout(resetTrzszOverlay, TRZSZ_SUCCESS_OVERLAY_MS);
      break;
    case "failure":
      window.clearTimeout(trzszOverlayTimer);
      // Ctrl+C 主动停止是用户意图，按提示呈现而非错误横幅。
      if (isTrzszStopMessage(event.message)) {
        resetTrzszOverlay();
        showNotice(t("trzszCancelled"));
      } else {
        showError(new Error(t("trzszFailed", { error: event.message })), "terminal");
      }
      break;
    case "cancelled":
      resetTrzszOverlay();
      break;
  }
}

function resetTrzszOverlay() {
  window.clearTimeout(trzszOverlayTimer);
  trzszOverlayTimer = 0;
  applyTrzszEvent({ type: "reset" });
}

/** Ctrl+C 等价：让 filter 停掉当前传输（协议侧走 stop/清理，随后报 cancelled）。 */
function cancelTrzszTransfer() {
  trzszFilter?.stopTransferringFiles();
}

/**
 * 会话切换 / 关闭时的静默收尾：停掉在途传输并复位 overlay，避免 busy 态
 * 卡住终端输入（与 cancelZmodemUpload 同语义）。
 */
function teardownTrzsz() {
  window.clearTimeout(trzszDetectionTimer);
  trzszDetectionTimer = 0;
  window.clearTimeout(trzszWatchdogTimer);
  trzszWatchdogTimer = 0;
  window.clearTimeout(trzszOverlayTimer);
  trzszOverlayTimer = 0;
  trzszFilter?.stopTransferringFiles();
  trzszProgress = initialTrzszProgressState();
  trzszSpeedSample = undefined;
  trzszPhase.value = "idle";
  trzszDirection.value = "";
  trzszFileName.value = "";
  trzszFileIndex.value = 0;
  trzszFileCount.value = 0;
  trzszPercent.value = 0;
  trzszSpeed.value = 0;
  trzszMessage.value = "";
}

const trzszStatusLabel = computed(() => {
  const name = trzszFileName.value;
  const percent = trzszPercent.value;
  switch (trzszPhase.value) {
    case "waiting":
      return t("trzszWaiting");
    case "transferring":
      return trzszDirection.value === "download" ? t("trzszDownloading", { name, percent }) : t("trzszUploading", { name, percent });
    case "success":
      return t("trzszComplete", { count: Math.max(1, trzszFileCount.value) });
    case "failed":
      return t("trzszFailed", { error: trzszMessage.value });
    default:
      return "";
  }
});

/** 右键菜单「Upload (trz)」：向 PTY 发送 trz 触发远端，announce 回来后接管。 */
function chooseTrzszUpload() {
  terminalMenu.value = undefined;
  if (!session.value || !canWrite.value || !canStartTrzszTransfer({ zmodemBusy: zmodemBusy.value, trzszBusy: trzszBusy.value })) return;
  applyTrzszEvent({ type: "waiting", direction: "upload" });
  trzszDetectionTimer = window.setTimeout(() => {
    if (trzszPhase.value === "waiting") applyTrzszEvent({ type: "failure", message: t("trzszNotAvailable") });
  }, TRZSZ_DETECTION_TIMEOUT_MS);
  sendTerminalBytes(new TextEncoder().encode("trz\r"));
  terminal?.focus();
}

/** filter 回调：浏览器 File API 多选（宿主沙箱内不可用 File System Access API）。 */
function pickTrzszUploadFiles(_directory: boolean): Promise<File[] | undefined> {
  // filter 已接管（走到选文件这一步），等待态看门狗使命完成。
  window.clearTimeout(trzszWatchdogTimer);
  trzszWatchdogTimer = 0;
  // 上一次未完成的选文件请求按取消处理，避免悬挂的 resolver。
  const previous = trzszPickResolver;
  trzszPickResolver = undefined;
  previous?.(undefined);
  // WKWebView/旧内核不派发 input 的 cancel 事件：窗口重新拿到焦点后一小段
  // 时间内 change 仍未触发（resolver 还挂着）即视为用户取消。
  const onFocus = () => {
    window.setTimeout(() => {
      if (trzszPickResolver) onTrzszPickCancel();
    }, 800);
  };
  window.addEventListener("focus", onFocus, { once: true });
  return new Promise((resolve) => {
    trzszPickResolver = resolve;
    trzszInput.value?.click();
  });
}

function onTrzszPickInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  const resolve = trzszPickResolver;
  trzszPickResolver = undefined;
  resolve?.(files.length ? files : undefined);
}

function onTrzszPickCancel() {
  const resolve = trzszPickResolver;
  trzszPickResolver = undefined;
  resolve?.(undefined);
}

/**
 * 下载落盘：优先宿主 fileTransfer API（optional 1.1 特性，逐文件 beginSave/
 * write/finish）；沙箱 iframe（fileTransfer 缺失）走 sidecar 落盘——与 GIF
 * 导出同路，支持下载目录设置与「每次询问」；web/docker（sidecar 不在本机）
 * 回退浏览器 <a download>（与 SFTP 下载链路同一兜底写法）。
 */
async function saveTrzszDownloadedFiles(files: readonly TrzszDownloadFile[]) {
  const fileTransfer = window.dbxPlugin.fileTransfer;
  const saving = files.filter((file) => !file.isDirectory && file.byteLength > 0);
  if (!saving.length) return;
  if (!fileTransfer) {
    const local = await probeLocalCapabilities();
    if (!local?.canSaveLocal) {
      for (const file of saving) saveBrowserDownload(file.chunks, file.fileName);
      return;
    }
    // 「使用默认地址」关闭时按批次只问一次，整批落同一目录；取消则整批不保存。
    let targetDir = "";
    let setDefaultAfter = false;
    if (!loadDownloadUseDefaultDir()) {
      const chosen = await askDownloadTarget(saving[0].fileName);
      if (chosen === undefined) return;
      targetDir = chosen.dir.trim();
      setDefaultAfter = chosen.setDefault;
    }
    const dir = targetDir || loadDownloadDir() || undefined;
    let lastSaved: { localPath: string; name: string } | undefined;
    for (const file of saving) {
      // 冲突策略逐文件生效：ask 撞名逐个询问，取消只跳过该文件。
      const conflict = await resolveDownloadConflictFor(dir || "", file.fileName);
      if (conflict === undefined) continue;
      const merged = new Uint8Array(file.byteLength);
      let offset = 0;
      for (const chunk of file.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      lastSaved = await window.dbxPlugin.invoke<{ localPath: string; name: string }>("local/saveFile", {
        name: file.fileName,
        dataBase64: window.dbxPlugin.encodeBase64(merged),
        targetDir: dir,
        conflict: conflict === "overwrite" ? "overwrite" : undefined,
      });
    }
    if (lastSaved) {
      const savedPath = lastSaved.localPath;
      showNotice(saving.length === 1
        ? t("downloadedTo", { name: lastSaved.name, path: savedPath })
        : t("downloadedToDir", { count: saving.length, path: dir || savedPath.replace(/[\\/][^\\/]+$/, "") }), [
        { label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) },
      ]);
    }
    if (setDefaultAfter) applyChosenDirAsDefault(targetDir);
    return;
  }
  for (const file of saving) {
    const target = await fileTransfer.beginSave({ name: file.fileName, size: file.byteLength });
    try {
      let offset = 0;
      for (const chunk of file.chunks) {
        const write = await fileTransfer.write(target.handleId, offset, chunk);
        offset = write.nextOffset;
      }
      await fileTransfer.finish(target.handleId);
    } catch (cause) {
      await fileTransfer.cancel(target.handleId).catch(() => undefined);
      throw cause;
    }
  }
}

function handleBinary(event: DbxPluginBinaryEvent) {
  const sessionId = activeTerminalSessionId || session.value?.sessionId;
  if (sessionId && event.channel === `ssh/terminal/out/${sessionId}`) {
    const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
    if (payload.length < 9) return;
    const sequence = readU64(payload, 1);
    if (sequence <= lastSequence) return;
    pendingTerminalFrames.set(sequence, { stream: payload[0], data: payload.slice(9) });
    drainTerminalFrames();
    return;
  }
  const taskId = event.channel.startsWith("sftp/download/") ? event.channel.slice("sftp/download/".length) : "";
  const waiter = downloadChunkWaiters.get(taskId);
  if (!waiter) return;
  const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
  if (payload.length < 8 || readU64(payload, 0) !== waiter.offset) return;
  window.clearTimeout(waiter.timer);
  downloadChunkWaiters.delete(taskId);
  waiter.resolve(payload.slice(8));
}

function drainTerminalFrames() {
  let frame = pendingTerminalFrames.get(lastSequence + 1);
  while (frame) {
    pendingTerminalFrames.delete(lastSequence + 1);
    lastSequence += 1;
    if (frame.stream === 2) {
      const state = new TextDecoder().decode(frame.data);
      if (state === "directory-tracking-unavailable") {
        followDirectory.value = false;
        directoryTrackingSupported.value = false;
        showNotice(t("directoryTrackingUnavailable"));
      } else {
        terminalState.value = "disconnected";
        terminalError.value = state === "ssh-transport-disconnected" ? t("transportDisconnected") : state || t("disconnected");
      }
    } else {
      try {
        if (!zmodemSentry) resetZmodemSentry();
        zmodemSentry?.consume(frame.data.slice().buffer);
      } catch (cause) {
        if (zmodemBusy.value) finishZmodemUpload(cause);
        else {
          resetZmodemSentry();
          dispatchTerminalOutput(frame.data);
        }
      }
    }
    frame = pendingTerminalFrames.get(lastSequence + 1);
  }
  persistState();
  // A stalled gap must not grow the pending map without bound: once the
  // buffer overshoots, drop it and let the replay re-deliver everything
  // after the last in-order sequence.
  if (pendingTerminalFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    pendingTerminalFrames.clear();
  }
  const firstPending = Math.min(...pendingTerminalFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > lastSequence + 1 && !replayInFlight && session.value) {
    const holeAt = lastSequence;
    replayInFlight = true;
    void window.dbxPlugin.invoke<ReplayResult>("ssh/terminal/replay", { sessionId: session.value.sessionId, afterSequence: lastSequence })
      .then((result) => {
        if (!result.complete) {
          terminalState.value = "error";
          terminalError.value = t("sessionUnrecoverable");
          return;
        }
        // The replay returned healthy but the hole below firstPending is still
        // there: those frames are gone for good (e.g. sequence numbering
        // restarted across a reconnect). Retry once more, then resync the
        // cursor past the hole — dropping the missing prefix beats spinning
        // this replay loop forever and freezing the workbench.
        if (lastSequence === holeAt) {
          replayNoProgress += 1;
          if (replayNoProgress >= 3) {
            lastSequence = firstPending - 1;
            replayNoProgress = 0;
          }
        } else {
          replayNoProgress = 0;
        }
      })
      .catch((cause) => showError(cause, "terminal"))
      .finally(() => {
        replayInFlight = false;
        drainTerminalFrames();
      });
  }
}

function handleEvent(event: DbxPluginEvent) {
  if (event.method === "ssh/batchBar/state") {
    const params = event.params as { source?: string; draft?: string; quickPickId?: string; open?: boolean };
    if (params.source && params.source !== batchBarSourceId) applyRemoteBatchBarState(params);
    return;
  }
  if (event.method === "ssh/host-key/prompt" || event.method === "connection/challenge") {
    hostKeyPrompt.value = event.params as unknown as HostKeyPrompt;
    connectLog.push("info", t("connectCard.log.hostKeyPrompt"));
    return;
  }
  if (event.method === "ssh/host-key/notice") {
    showError(String(event.params.message || "SSH host-key warning"), "terminal");
    return;
  }
  if (event.method === "ssh/session/state" && event.params.sessionId === session.value?.sessionId) {
    if (event.params.state === "disconnected") {
      // Transport dropped (network flap, server restart): auto-reconnect with
      // a bounded backoff ladder instead of parking on a dead terminal.
      if (!disposed && reconnectAttempt < TERMINAL_RECONNECT_DELAYS.length) {
        const delay = terminalReconnectDelay(reconnectAttempt++);
        terminalState.value = "connecting";
        reconnectPending.value = true;
        reconnectTimer = window.setTimeout(() => {
          if (!disposed) void openSession();
        }, delay);
        return;
      }
      terminalState.value = "disconnected";
      reconnectPending.value = false;
      terminalError.value = t("transportDisconnected");
    }
    return;
  }
  if (event.method === "ssh/agent/prompt" && event.params.sessionId === session.value?.sessionId) {
    agentPromptQueue.value = enqueueAgentPrompt(agentPromptQueue.value, event.params as unknown as AgentPromptPayload);
    return;
  }
  if (event.method === "ssh/agent/notice" && event.params.sessionId === session.value?.sessionId) {
    agentRunning.value = event.params as unknown as AgentNoticePayload;
    return;
  }
  if (event.method === "ssh/agent/finish" && event.params.sessionId === session.value?.sessionId) {
    const payload = event.params as unknown as AgentFinishPayload;
    agentRunning.value = undefined;
    showNotice(t(payload.status === "denied" ? "agentDenied" : "agentFinished"));
    return;
  }
  // Trigger engine feedback (expect-style auto interaction): the payload never
  // carries the answered content (sidecar contract), only stage/kind. Events
  // for sessions other than the open one are dropped silently.
  if (event.method === "ssh/trigger" && event.params.sessionId === session.value?.sessionId) {
    const payload = event.params as { sessionId?: string; stage?: number; kind?: string };
    const stage = Math.max(1, Number(payload.stage) || 1);
    showNotice(t(payload.kind === "timeout" ? "triggerTimeout" : "triggerAnswered", { stage }));
    return;
  }
  if (event.method === "sftp/upload/ack") {
    const taskId = String(event.params.taskId || "");
    const waiter = uploadAckWaiters.get(taskId);
    if (waiter && Number(event.params.nextOffset) === waiter.nextOffset) {
      window.clearTimeout(waiter.timer);
      uploadAckWaiters.delete(taskId);
      waiter.resolve();
    }
    return;
  }
  if (event.method === "sftp/transfer/progress") updateTransfer(event.params);
}

function updateTransfer(params: Record<string, unknown>) {
  const taskId = String(params.taskId || "");
  if (!taskId) return;
  const existing = transferTasks[taskId];
  const transferred = Number(params.transferred ?? existing?.transferred ?? 0);
  const sample = sampleTransferSpeed(transferSamples.get(taskId), transferred, performance.now());
  transferSamples.set(taskId, sample);
  transferSpeeds[taskId] = sample.speed;
  transferTasks[taskId] = {
    taskId,
    sessionId: String(params.sessionId || existing?.sessionId || ""),
    direction: params.direction === "download" ? "download" : existing?.direction || "upload",
    fileName: String(params.fileName || existing?.fileName || ""),
    size: Number(params.size ?? existing?.size ?? 0),
    transferred,
    status: normalizeTransferStatus(params.status, existing?.status),
    error: typeof params.error === "string" ? params.error : existing?.error,
  };
  if (!existing && (transferTasks[taskId].status === "queued" || transferTasks[taskId].status === "running")) openTransferPanel();
}

function normalizeTransferStatus(value: unknown, fallback: TransferTask["status"] = "running"): TransferTask["status"] {
  return ["queued", "running", "completed", "cancelled", "failed"].includes(String(value)) ? String(value) as TransferTask["status"] : fallback;
}

async function openSession(forceNew = false, bootRestore = false, isRetry = false) {
  if (!connectionId.value || !workbenchId.value) return;
  window.clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  // Boot-time tab restore can race the host's plugin activation and fail the
  // very first ssh/session/open; a bounded retry self-heals the restored
  // terminal instead of parking it on a manual reconnect button.
  // P1-1：重试计数只在"新入口"（用户动作 / 断线重连 / 初次打开）归零；
  // 重试定时器重入时必须保留计数，否则 OPEN_RETRY_MAX 永远打不满，
  // 认证失败等秒级永久错误会无限重试、错误文案永不呈现。
  if (!isRetry) openRetryAttempt = 0;
  // A session opened over a stale one must not inherit a stuck ZMODEM
  // overlay (zmodemBusy would keep swallowing terminal input).
  cancelZmodemUpload();
  // 同理不继承上一个会话的 trzsz 传输占用（在途传输一并停掉）。
  teardownTrzsz();
  // 同理不继承上一个会话的 AI 审批队列 / 执行横幅（切换会话清空全部排队挑战）。
  clearAgentPrompts();
  agentRunning.value = undefined;
  terminalState.value = "connecting";
  terminalError.value = "";
  reconnectPending.value = false;
  resetCommandMarker();
  connectCancelled.value = false;
  connectSucceeded.value = false;
  connectLog.push("info", t("connectCard.log.attempt", { attempt: openRetryAttempt + 1 }));
  if (forceNew && session.value) await closeSession(false);
  createTerminal();
  // A retry is only worth it for fast failures (boot-restore races with
  // plugin activation). A real dial failure takes tens of seconds — retrying
  // those just turns one error into minutes of spinner.
  const attemptStarted = Date.now();
  const attemptTimeoutMs = openRetryAttempt === 0 ? 120_000 : 30_000;
  try {
    const info = await window.dbxPlugin.invoke<SessionInfo>("ssh/session/open", {
      connectionId: connectionId.value,
      workbenchId: workbenchId.value,
      cols: terminal?.cols || 120,
      rows: terminal?.rows || 32,
    }, { timeoutMs: attemptTimeoutMs });
    // 用户取消后在途 open 仍可能成功（invoke 无法中止）：立即关闭这个孤儿
    // 会话并提前返回——不置 connected、不补发 replay，卡片停在已取消态。
    if (connectCancelled.value) {
      void window.dbxPlugin.invoke("ssh/session/close", { sessionId: info.sessionId }).catch(() => undefined);
      connectLog.push("warn", t("connectCard.log.orphanClosed"));
      return;
    }
    activeTerminalSessionId = info.sessionId;
    session.value = info;
    lastSequence = 0;
    // A fresh session restarts sequence numbering: buffered frames from the
    // dead session belong to a different stream and must not poison the
    // in-order drain (a stale higher sequence would fake a permanent hole).
    pendingTerminalFrames.clear();
    replayNoProgress = 0;
    directoryTrackingSupported.value = info.directoryTrackingSupported ?? true;
    // 成功过渡（Termius 式）：先切 success 卡片——进度线填满到顶、终端图标变
    // 对号；replay 在动画期间并行拉取，hold 播完才置 connected 进终端，避免
    // 连接成功瞬间生硬跳变。reduced-motion 下不 hold，立即进终端。
    connectSucceeded.value = true;
    const successShownAt = Date.now();
    connectLog.push("info", t("connectCard.log.connected", { seconds: ((Date.now() - attemptStarted) / 1000).toFixed(1) }));
    const replay = await window.dbxPlugin.invoke<ReplayResult>("ssh/terminal/replay", {
      sessionId: info.sessionId,
      afterSequence: 0,
    });
    if (!replay.complete) throw new Error(t("sessionUnrecoverable"));
    const holdMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : CONNECT_SUCCESS_HOLD_MS;
    const remainMs = holdMs - (Date.now() - successShownAt);
    if (remainMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainMs));
    connectSucceeded.value = false;
    terminalState.value = "connected";
    await afterSessionConnected();
  } catch (cause) {
    if (disposed) return;
    connectSucceeded.value = false;
    // 用户已取消：不重试、不呈现错误，卡片停在已取消态等 Connect 重新发起。
    if (connectCancelled.value) return;
    const attemptMs = Date.now() - attemptStarted;
    // "Connection is not active"：sidecar 连接注册表还没有该连接。boot 恢复
    // 场景（宿主启动时为恢复的插件 tab 重放 connect 生命周期）这是暂时态，
    // 与其它快失败一起在窗口内重试即可自愈；非 boot 路径（手动重连等）重试
    // 仍不可能成功，保持立即失败并指引从左侧连接重新打开。认证 / host-key
    // 拒绝是秒级永久错误，重试不可能自愈——跳过重试直接进 error 态，
    // 呈现 friendly 文案 + Reconnect 出口（P1-1）。决策细节见 connectRetry.ts。
    const inactive = isConnectionInactiveError(cause);
    const decision = decideConnectRetry({
      cause,
      attempt: openRetryAttempt,
      maxAttempts: OPEN_RETRY_MAX,
      attemptMs,
      inactive,
      bootRestore,
    });
    if (decision.kind === "retry") {
      openRetryAttempt = decision.attempt;
      terminalState.value = "connecting";
      connectLog.push("warn", t("connectCard.log.retry", { seconds: decision.delayMs / 1000 }));
      reconnectTimer = window.setTimeout(() => {
        if (!disposed) void openSession(false, bootRestore, true);
      }, decision.delayMs);
      return;
    }
    terminalState.value = "error";
    activeTerminalSessionId = "";
    // 日志记录分类后的友好原因（与卡片错误行同源），未分类时保留原始错误串。
    const rawReason = cause instanceof Error ? cause.message : String(cause ?? "");
    const reasonKind = classifyConnectError(rawReason);
    connectLog.push("error", t("connectCard.log.failed", { reason: inactive ? t("connectionInactive") : reasonKind ? t(connectErrorKey(reasonKind)) : rawReason }));
    showError(inactive ? new Error(t("connectionInactive")) : cause, "terminal");
  }
}

async function attachSession(sessionId: string, retryReference: string = initialState().sessionId || "") {
  terminalState.value = "connecting";
  connectCancelled.value = false;
  // attach（tab 恢复）不播成功过渡动画，直接进终端。
  connectSucceeded.value = false;
  activeTerminalSessionId = sessionId;
  try {
    const info = await window.dbxPlugin.invoke<SessionInfo>("ssh/session/attach", {
      connectionId: connectionId.value,
      workbenchId: workbenchId.value,
      afterSequence: lastSequence,
    }, { timeoutMs: 15_000 });
    if (info.sessionId !== sessionId) throw new Error(t("errors.sessionChanged"));
    session.value = info;
    terminalState.value = "connected";
    reconnectPending.value = false;
    if (info.replay && !info.replay.complete) {
      terminalState.value = "error";
      terminalError.value = t("sessionUnrecoverable");
      return;
    }
    reconnectAttempt = 0;
    await afterSessionConnected();
  } catch (cause) {
    if (!shouldReattachTerminal({ disposed, state: terminalState.value, expectedSessionId: sessionId, currentSessionId: retryReference })) {
      terminalState.value = "error";
      reconnectPending.value = false;
      activeTerminalSessionId = "";
      showError(cause, "terminal");
      return;
    }
    const delay = terminalReconnectDelay(reconnectAttempt++);
    // Once the backoff ladder is exhausted, the stored session is gone for
    // good (e.g. the app was killed while the tab was open): re-attaching a
    // dead session id can never succeed, so fall back to a fresh open.
    if (reconnectAttempt > TERMINAL_RECONNECT_DELAYS.length) {
      reconnectAttempt = 0;
      reconnectPending.value = false;
      reconnectTimer = window.setTimeout(() => void openSession(true), delay);
      terminalError.value = t("reattachingTerminal");
      return;
    }
    reconnectNextAt = Date.now() + delay;
    reconnectDelayMs = delay;
    reconnectPending.value = true;
    reconnectTimer = window.setTimeout(() => void attachSession(sessionId), delay);
    terminalError.value = t("reattachingTerminal");
  }
}

async function afterSessionConnected() {
  terminalError.value = "";
  terminal?.focus();
  scheduleFit();
  await writeWorkbenchState();
  if (followDirectory.value) await setDirectoryTracking(true);
  void refreshSftpHomePath();
  await Promise.all([loadDirectory(currentPath.value), restoreTransfers()]);
  // 侧栏 tree tab 可见时补拉根节点（首连/重连后缓存仍为空的场景）。
  ensureSideTreeRoot();
  // After an auto-reconnect succeeds, tell the user the session is back and
  // which working directory context it resumed with (pure-function chosen).
  if (reconnectWasPending) {
    reconnectWasPending = false;
    const restored = describeReconnectRestoredNotice({ wasReconnecting: true, path: currentPath.value });
    if (restored) showNotice(t(restored.key, restored.values));
  }
}

async function closeSession(updateStatus = true) {
  const sessionId = session.value?.sessionId;
  session.value = undefined;
  activeTerminalSessionId = "";
  clearAgentPrompts();
  agentRunning.value = undefined;
  // Closing mid-ZMODEM aborts the transfer silently instead of leaving the
  // busy overlay and the dead sentry attached to the workbench.
  cancelZmodemUpload();
  // trzsz 在途传输同样静默停止（死会话上的 sendToServer 会因无 sessionId 空转）。
  teardownTrzsz();
  pendingTerminalFrames.clear();
  lastSequence = 0;
  terminalInputQueue.reset();
  reconnectPending.value = false;
  resetCommandMarker();
  if (sessionId) await window.dbxPlugin.invoke("ssh/session/close", { sessionId }).catch(() => undefined);
  if (updateStatus) {
    terminalState.value = "disconnected";
    terminalError.value = t("disconnected");
  }
  persistState();
}

async function reconnect() {
  terminal?.clear();
  await closeSession(false);
  await openSession();
}

/**
 * 连接卡片 Cancel：在途 ssh/session/open 无法中止，仅清掉待触发的重试定时器
 * 并把卡片切到已取消态；promise 落地后由 openSession 内的 connectCancelled
 * 分支负责回收孤儿会话 / 跳过重试与错误呈现。
 */
function cancelConnect() {
  window.clearTimeout(reconnectTimer);
  connectCancelled.value = true;
  connectLog.push("warn", t("connectCard.log.cancelled"));
}

/** 已取消态的 Connect 出口：重新走完整 openSession 流程（入口会重置取消标记）。 */
function startConnect() {
  connectCancelled.value = false;
  void openSession();
}

/**
 * Manual "reconnect now" entry: while the auto-reconnect backoff ladder is
 * pending, cancel the scheduled retry and reconnect immediately instead of
 * waiting out the current delay; otherwise behave like the plain reconnect.
 */
async function reconnectNow() {
  if (!reconnectPending.value) {
    await reconnect();
    return;
  }
  window.clearTimeout(reconnectTimer);
  reconnectPending.value = false;
  reconnectAttempt = 0;
  await openSession();
}

async function restoreTransfers() {
  if (!session.value) return;
  const result = await window.dbxPlugin.invoke<{ tasks: TransferTask[] }>("sftp/transfer/list", { sessionId: session.value.sessionId }).catch(() => ({ tasks: [] }));
  for (const task of result.tasks) transferTasks[task.taskId] = task;
}

// ---------------------------------------------------------------------------
// 传输历史（sftp/transfer/history，落盘+内存合并视图，只读）
// ---------------------------------------------------------------------------

async function refreshTransferHistory() {
  transferHistoryLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ tasks: unknown }>("sftp/transfer/history", { limit: TRANSFER_HISTORY_LIMIT });
    transferHistory.value = sanitizeTransferHistoryTasks(result?.tasks);
    transferHistoryFailed.value = false;
  } catch {
    // 历史是 best-effort UX 数据：后端未升级/读取失败仅提示加载失败，
    // 保留上一次快照——一次瞬时错误不能把用户可见的记录清空。
    transferHistoryFailed.value = true;
  } finally {
    transferHistoryLoading.value = false;
  }
}

/**
 * 面板打开时对账活跃任务：逐个向后端查询 `sftp/transfer/status`，后端已不
 * 认识的任务（sidecar 重启、页面重载后错过终态事件的“僵尸行”）标记为失败，
 * 终态以服务端为准。查询失败视为任务已死——存活任务的状态查询总会成功。
 * 不在每次历史刷新时做：新任务可能在快照之后才登记，避免误判。
 */
async function reconcileActiveTransfers() {
  for (const task of Object.values(transferTasks)) {
    if (task.status !== "queued" && task.status !== "running") continue;
    try {
      const status = await window.dbxPlugin.invoke<{ transferred?: number; status: string }>("sftp/transfer/status", { taskId: task.taskId });
      const normalized = normalizeTransferStatus(status.status, "running");
      // task.status 此处必为 queued/running（上方守卫），终态即差异。
      if (normalized !== "queued" && normalized !== "running") {
        task.status = normalized;
        if (status.transferred) task.transferred = status.transferred;
      }
    } catch {
      task.status = "failed";
      task.error = t("transfersHistory.interrupted");
    }
  }
}

/** 收敛 sftp/transfer/history 响应：丢畸形行，方向/状态收敛到已知枚举（镜像 normalizeTransferStatus）。 */
function sanitizeTransferHistoryTasks(raw: unknown): TransferHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TransferHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const taskId = typeof record.taskId === "string" ? record.taskId : "";
    if (!taskId) continue;
    // 历史枚举无 queued；异常遗留 queued 行按 running 展示（保守降级，不丢条目）。
    const status = normalizeTransferStatus(record.status, "completed");
    out.push({
      taskId,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      connectionId: typeof record.connectionId === "string" ? record.connectionId : undefined,
      direction: record.direction === "download" ? "download" : "upload",
      fileName: typeof record.fileName === "string" ? record.fileName : "",
      size: Number(record.size ?? 0) || 0,
      transferred: Number(record.transferred ?? 0) || 0,
      status: status === "queued" ? "running" : status,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
      finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
      error: typeof record.error === "string" && record.error ? record.error : undefined,
      localPath: typeof record.localPath === "string" && record.localPath ? record.localPath : undefined,
    });
  }
  return out;
}

async function clearTransferHistory() {
  if (!window.confirm(t("transfersHistory.clearConfirm"))) return;
  try {
    await window.dbxPlugin.invoke("sftp/transfer/history/clear", {});
    transferHistory.value = [];
    transferHistoryFailed.value = false;
    showNotice(t("transfersHistory.cleared"));
  } catch (cause) {
    showError(cause);
  }
}

/** Refresh every data source rendered by the transfer popover. */
async function refreshTransferPanel() {
  await Promise.all([
    refreshTransferHistory(),
    refreshResumableUploads(),
    restoreTransfers(),
  ]);
  await reconcileActiveTransfers();
}

// 打开传输面板或最后一个活动任务结束时拉取历史：历史区常驻展示，活跃任务只影响列表而不遮挡快照。
// 打开面板的同时对账活跃任务，防止错过终态事件的行永远卡在 running。
watch(transferPanelOpen, (open) => {
  if (open) {
    void refreshTransferPanel();
  }
});
watch(activeTransfers, (count, previous) => {
  if (count === 0 && previous > 0 && transferPanelOpen.value) void refreshTransferHistory();
});

async function refreshResumableUploads() {
  resumableLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ tasks: ResumableUploadTask[] }>("sftp/transfer/resumable", {});
    resumableTasks.value = (result.tasks ?? []).filter(canResumeUpload);
  } catch {
    resumableTasks.value = [];
  } finally {
    resumableLoading.value = false;
  }
}

function beginResumeUpload(task: ResumableUploadTask) {
  resumeTargetTaskId.value = task.taskId;
  resumeInput.value?.click();
}

async function onResumeFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const task = resumableTasks.value.find((item) => item.taskId === resumeTargetTaskId.value);
  resumeTargetTaskId.value = "";
  if (!file || !task) return;
  if (!matchResumableUpload(task, [{ name: file.name, size: file.size }])) {
    showError(new Error(t("resumableMismatch")));
    return;
  }
  try {
    await uploadSource(file.name, file.size, async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), { taskId: task.taskId, remotePath: task.remotePath });
    await loadDirectory();
    showNotice(t("resumableResumed", { name: file.name }));
    void refreshTransferHistory();
    void refreshResumableUploads();
  } catch (cause) {
    showError(cause);
  }
}

async function resolveHostKey(accept: boolean) {
  const prompt = hostKeyPrompt.value;
  if (!prompt) return;
  hostKeyPrompt.value = undefined;
  try {
    await window.dbxPlugin.invoke("connection/challenge/resolve", {
      challengeId: prompt.challengeId,
      operationId: prompt.operationId,
      accept,
      remember: accept && rememberHostKey.value,
    });
    connectLog.push("info", t("connectCard.log.hostKeyResolved"));
  } catch (cause) {
    showError(cause, "terminal");
  }
}

// ---------------------------------------------------------------------------
// AI 终端同步执行（agent terminal mode）：审批挑战 + 执行横幅
// ---------------------------------------------------------------------------

// 审批队列：弹窗只渲染队首；队首变化（入队到空队列、出队露出下一个）时经 watch
// 重置可编辑命令与 250ms tick 倒计时。倒计时基于队首 requestedAt + timeoutSecs
// 绝对期限，到 0 仅出队队首并标记 expired（后端超时同样拒绝）；排队中已到期的
// 挑战会在露出为队首的首次 tick 即被跳过出队。
const agentPromptHead = computed(() => agentPromptQueue.value[0]);

watch(agentPromptHead, (head) => {
  stopAgentPromptTimer();
  if (!head) {
    agentPromptCommand.value = "";
    agentPromptRemaining.value = 0;
    return;
  }
  agentPromptCommand.value = head.command;
  agentPromptExpired.value = false;
  agentPromptRemember.value = false;
  const tick = () => {
    const current = agentPromptHead.value;
    if (!current) return;
    agentPromptRemaining.value = approvalRemainingSecs(current, Date.now());
    if (agentPromptRemaining.value <= 0) {
      agentPromptExpired.value = true;
      dismissAgentPrompt();
    }
  };
  tick();
  agentPromptTimer = window.setInterval(tick, 250);
});

function stopAgentPromptTimer() {
  if (agentPromptTimer) {
    window.clearInterval(agentPromptTimer);
    agentPromptTimer = 0;
  }
}

// 出队队首（超时 / 审批后调用）：队列自动露出下一个，watch 重启其倒计时。
function dismissAgentPrompt() {
  const head = agentPromptHead.value;
  if (!head) return;
  agentPromptQueue.value = dropAgentPrompt(agentPromptQueue.value, head.challengeId);
}

// 清空整个审批队列（会话切换 / 关闭时不继承旧会话的排队挑战）。
function clearAgentPrompts() {
  stopAgentPromptTimer();
  agentPromptQueue.value = [];
  agentPromptCommand.value = "";
  agentPromptRemaining.value = 0;
}

// 审批语义对齐 host-key 挑战：先出队再 resolve（挑战一次性，重复 resolve 报错）；
// 批准时提交编辑后的命令（所见即所执行）；勾选「记住」时携带 remember 标记。
async function resolveAgentPrompt(decision: "approve" | "deny") {
  const prompt = agentPromptHead.value;
  if (!prompt) return;
  const command = agentPromptCommand.value;
  const remember = agentPromptRemember.value;
  dismissAgentPrompt();
  try {
    const payload = buildAgentResolveBody({ challengeId: prompt.challengeId, decision, command, remember });
    await window.dbxPlugin.invoke("ssh/agent/resolve", payload);
  } catch (cause) {
    showError(cause, "terminal");
  }
}

// 中断 AI 正在终端执行的命令：复用 PTY 输入通道发送 Ctrl+C（0x03，对齐快速命令写入语义）。
function interruptAgentRun() {
  sendTerminalBytes(new Uint8Array([3]));
}

// ---------------------------------------------------------------------------
// 告警排查（IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT §2.4）：粘贴异构告警 → 后端
// ssh/alert/triage 分诊（结构化 + 分类 + 只读命令清单）；建议命令一键发送到
// 当前终端（复用 PTY 键盘写入链路），分诊本身不需要活动连接。
const alertTriageOpen = ref(false);
const alertTriageBusy = ref(false);
const alertTriageError = ref("");
const alertTriagePayload = ref("");
const alertTriageResult = ref<TriageResult>();

watch(alertTriagePayload, () => {
  alertTriageResult.value = undefined;
  alertTriageError.value = "";
});

function openAlertTriage() {
  alertTriageOpen.value = true;
  alertTriageError.value = "";
}

async function runAlertTriage() {
  if (alertTriageBusy.value) return;
  const payload = sanitizeTriagePayload(alertTriagePayload.value);
  if (!payload) {
    alertTriageError.value = t("alertTriage.invalidPayload");
    return;
  }
  alertTriageBusy.value = true;
  alertTriageError.value = "";
  alertTriageResult.value = undefined;
  try {
    alertTriageResult.value = await window.dbxPlugin.invoke<TriageResult>("ssh/alert/triage", { payload });
  } catch (cause) {
    alertTriageError.value = t("alertTriageLoadFailed", { error: settingsErrorOf(cause) });
  } finally {
    alertTriageBusy.value = false;
  }
}

function sendSuggestionToTerminal(command: string) {
  if (!session.value) return;
  trackPendingInput(`${command}\r`);
  sendTerminalBytes(new TextEncoder().encode(`${command}\r`));
  terminal?.focus();
}

async function copySuggestions() {
  const result = alertTriageResult.value;
  if (!result?.suggestions?.length) return;
  try {
    await writeClipboardText(result.suggestions.map((item) => item.command).join("\n"), clipboardDeps());
    showNotice(t("terminalCopied"));
  } catch (cause) {
    showError(cause);
  }
}

// ---------------------------------------------------------------------------
// 关键词高亮（IMPL_PLAN_NETCATTY_PARITY §3-B1）：规则管理 + xterm decorations。
// 数据面走 ssh/highlightRules/*（后端不可用静默空表）；渲染面用 onRender 触发
// rAF 节流（≤30fps）视口行扫描，per-row Map 维护 decoration，全局上限 400。
// ---------------------------------------------------------------------------
const highlightRules = ref<HighlightRuleView[]>([]);
const highlightMenuOpen = ref(false);
const highlightSaving = ref(false);
const highlightDraftError = ref("");
const highlightDraft = reactive({ id: undefined as string | undefined, pattern: "", color: HIGHLIGHT_COLOR_DEFAULT, isRegex: false, caseSensitive: false });
const compiledHighlightRules = computed(() => compileRules(highlightRules.value));

function loadHighlightEnabled(): boolean {
  try {
    return window.localStorage.getItem(HIGHLIGHT_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

// 总开关：关闭时摘掉 onRender 挂子并全量清理 decoration（零挂钩子语义）。
const highlightEnabled = ref(loadHighlightEnabled());

function toggleHighlightEnabled() {
  highlightEnabled.value = !highlightEnabled.value;
  try {
    window.localStorage.setItem(HIGHLIGHT_ENABLED_KEY, highlightEnabled.value ? "true" : "false");
  } catch {
    // 存储不可用时仅当前会话生效。
  }
  if (highlightEnabled.value) {
    attachHighlightRender();
    rescanHighlightViewport();
  } else {
    detachHighlightRender();
  }
}

async function hydrateHighlightRules() {
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/list", {});
    highlightRules.value = normalizeHighlightRules(response.rules);
  } catch {
    // 后端不可用（如旧版 sidecar）：静默降级空表，高亮功能整体退场。
    highlightRules.value = [];
  }
}

function resetHighlightDraft() {
  highlightDraft.id = undefined;
  highlightDraft.pattern = "";
  highlightDraft.color = HIGHLIGHT_COLOR_DEFAULT;
  highlightDraft.isRegex = false;
  highlightDraft.caseSensitive = false;
  highlightDraftError.value = "";
}

async function saveHighlightRule() {
  if (highlightSaving.value) return;
  const sanitized = sanitizeHighlightRuleInput({ pattern: highlightDraft.pattern, color: highlightDraft.color, isRegex: highlightDraft.isRegex, caseSensitive: highlightDraft.caseSensitive });
  if (sanitized.error || !sanitized.value) {
    highlightDraftError.value = t(sanitized.error ?? "highlightRules.invalidPattern");
    return;
  }
  if (!highlightDraft.id && highlightRules.value.length >= HIGHLIGHT_RULES_LIMIT) return;
  highlightSaving.value = true;
  highlightDraftError.value = "";
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/save", {
      id: highlightDraft.id ?? "",
      pattern: sanitized.value.pattern,
      isRegex: sanitized.value.isRegex,
      color: sanitized.value.color,
      caseSensitive: sanitized.value.caseSensitive,
    });
    highlightRules.value = normalizeHighlightRules(response.rules);
    resetHighlightDraft();
  } catch (cause) {
    highlightDraftError.value = settingsErrorOf(cause);
  } finally {
    highlightSaving.value = false;
  }
}

function editHighlightRule(item: HighlightRuleView) {
  highlightDraft.id = item.id;
  highlightDraft.pattern = item.pattern;
  highlightDraft.color = item.color;
  highlightDraft.isRegex = item.isRegex;
  highlightDraft.caseSensitive = item.caseSensitive;
  highlightDraftError.value = "";
}

async function toggleHighlightRule(item: HighlightRuleView) {
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/save", {
      id: item.id,
      pattern: item.pattern,
      isRegex: item.isRegex,
      color: item.color,
      caseSensitive: item.caseSensitive,
      enabled: !item.enabled,
    });
    highlightRules.value = normalizeHighlightRules(response.rules);
  } catch (cause) {
    showError(cause, "terminal");
  }
}

async function deleteHighlightRule(id: string) {
  try {
    const response = await window.dbxPlugin.invoke<{ rules: unknown }>("ssh/highlightRules/delete", { id });
    highlightRules.value = normalizeHighlightRules(response.rules);
    if (highlightDraft.id === id) resetHighlightDraft();
  } catch (cause) {
    showError(cause, "terminal");
  }
}

// 规则弹层开关（互斥族统一走 closeToolbarPopovers 收口）。
function toggleHighlightMenu() {
  const next = !highlightMenuOpen.value;
  closeToolbarPopovers();
  highlightMenuOpen.value = next;
  if (next) resetHighlightDraft();
}

// ---- decoration 引擎 ----
// onRender({start,end}) 只给重渲染的视口行区间：合并进 pending 区间，经
// setTimeout 节流（≤30fps）后统一扫描。alt buffer 与 normal buffer 走同一
// 路径（buffer.active 直接扫描）。
let highlightRenderDisposable: { dispose(): void } | undefined;
// 每行一个组（marker + decorations）；行滚出视口整组 dispose。
const highlightDecorationsByRow = new Map<number, { dispose(): void }>();
let highlightDecorationCount = 0;
let highlightScanScheduled = false;
let highlightLastScanAt = 0;
let highlightPendingRange: { start: number; end: number } | undefined;

function clearHighlightDecorations() {
  for (const entry of highlightDecorationsByRow.values()) entry.dispose();
  highlightDecorationsByRow.clear();
  highlightDecorationCount = 0;
}

function attachHighlightRender() {
  if (!terminal || highlightRenderDisposable || !highlightEnabled.value) return;
  highlightRenderDisposable = terminal.onRender(({ start, end }) => scheduleHighlightScan(start, end));
  rescanHighlightViewport();
}

function detachHighlightRender() {
  highlightRenderDisposable?.dispose();
  highlightRenderDisposable = undefined;
  clearHighlightDecorations();
}

function rescanHighlightViewport() {
  if (!terminal || !highlightEnabled.value) return;
  scheduleHighlightScan(0, terminal.rows - 1);
}

function scheduleHighlightScan(start: number, end: number) {
  if (!terminal || !highlightEnabled.value || !compiledHighlightRules.value.length) return;
  highlightPendingRange = highlightPendingRange
    ? { start: Math.min(highlightPendingRange.start, start), end: Math.max(highlightPendingRange.end, end) }
    : { start, end };
  if (highlightScanScheduled) return;
  highlightScanScheduled = true;
  const wait = Math.max(0, HIGHLIGHT_SCAN_MIN_INTERVAL_MS - (performance.now() - highlightLastScanAt));
  window.setTimeout(runHighlightScan, wait);
}

function runHighlightScan() {
  highlightScanScheduled = false;
  highlightLastScanAt = performance.now();
  const range = highlightPendingRange;
  highlightPendingRange = undefined;
  if (!range || !terminal || !highlightEnabled.value) return;
  scanHighlightRange(range.start, range.end);
}

function scanHighlightRange(start: number, end: number) {
  const term = terminal;
  if (!term) return;
  const buffer = term.buffer.active;
  const from = Math.max(0, Math.min(start, buffer.length - 1));
  const to = Math.max(from, Math.min(end, buffer.length - 1));
  // 行滚出本帧视口：整组 dispose（Map 不同步收缩会拖着全局上限走）。
  for (const [row, entry] of highlightDecorationsByRow) {
    if (row < from || row > to) {
      entry.dispose();
      highlightDecorationsByRow.delete(row);
    }
  }
  const compiled = compiledHighlightRules.value;
  if (!compiled.length) return;
  // registerMarker 的 offset 相对光标绝对行（baseY + cursorY）；marker dispose 时
  // xterm 会连带 dispose 挂在其上的 decoration。
  const base = buffer.baseY + buffer.cursorY;
  for (let row = from; row <= to; row++) {
    if (highlightDecorationsByRow.has(row)) continue;
    if (highlightDecorationCount >= HIGHLIGHT_DECORATION_LIMIT) return;
    const lineText = buffer.getLine(row)?.translateToString(true) ?? "";
    if (!lineText) continue;
    const matches = matchesInLine(lineText, compiled);
    if (!matches.length) continue;
    const marker = term.registerMarker(row - base);
    if (!marker) continue;
    const disposables: Array<{ dispose(): void }> = [marker];
    const entry = {
      dispose() {
        for (const disposable of disposables.splice(0)) disposable.dispose();
      },
    };
    for (const match of matches) {
      if (highlightDecorationCount >= HIGHLIGHT_DECORATION_LIMIT) break;
      const decoration = term.registerDecoration({ marker, x: match.start, width: match.end - match.start });
      if (decoration) {
        // xterm 5 的 DOM renderer 不应用 registerDecoration 的 backgroundColor
        // 选项（与 @xterm/addon-search 同因），着色走 onRender 自绘元素样式。
        // 装饰层在文字层上方，必须用半透明填充——纯色会把字形整个盖住。
        decoration.onRender((element) => {
          element.style.backgroundColor = highlightFillStyle(match.color);
        });
        disposables.push(decoration);
        highlightDecorationCount++;
      }
    }
    highlightDecorationsByRow.set(row, entry);
  }
}

// 规则/开关变化：全量清理后重扫当前视口（即时生效语义）。
watch(compiledHighlightRules, () => {
  clearHighlightDecorations();
  rescanHighlightViewport();
});

// ---------------------------------------------------------------------------
// metrics sparkline + 发行版徽标（IMPL_PLAN_NETCATTY_PARITY §3-B2）
// ---------------------------------------------------------------------------

// 每方向环形采样（60 帧 × 5s 轮询 ≈ 5 分钟）；跨重连（新 session）清空。
// F2：cpu/mem 环形同样 60 帧，打开指标卡时用落盘历史回填（跨重启可见趋势）。
const metricSamples = reactive({ rx: [] as number[], tx: [] as number[], cpu: [] as number[], mem: [] as number[] });

function recordMetricSamples() {
  let rx = 0;
  let tx = 0;
  for (const net of metrics.value?.network ?? []) {
    rx += Math.max(0, net.rxRate || 0);
    tx += Math.max(0, net.txRate || 0);
  }
  metricSamples.rx = pushSample(metricSamples.rx, rx, METRICS_SAMPLE_CAPACITY);
  metricSamples.tx = pushSample(metricSamples.tx, tx, METRICS_SAMPLE_CAPACITY);
  const cpuPercent = metrics.value?.cpu?.percent;
  if (cpuPercent != null) metricSamples.cpu = pushSample(metricSamples.cpu, cpuPercent, METRICS_SAMPLE_CAPACITY);
  const totalBytes = metrics.value?.memory?.totalBytes ?? 0;
  if (totalBytes > 0) metricSamples.mem = pushSample(metricSamples.mem, ((metrics.value?.memory?.usedBytes ?? 0) / totalBytes) * 100, METRICS_SAMPLE_CAPACITY);
}

const metricsRxSparkline = computed(() => sparklinePath(metricSamples.rx, 60, 18));
const metricsTxSparkline = computed(() => sparklinePath(metricSamples.tx, 60, 18));
const metricsCpuSparkline = computed(() => sparklinePath(metricSamples.cpu, 120, 18));
const metricsMemSparkline = computed(() => sparklinePath(metricSamples.mem, 120, 18));
// 视图层去噪：伪文件系统/overlay 重复挂载/零流量虚拟网卡不进渲染（纯函数在 lib/metricsView）。
const visibleDiskMounts = computed(() => filterDiskMounts(metrics.value?.disks));
const visibleNetworkInterfaces = computed(() => filterNetworkInterfaces(metrics.value?.network));
// 旧 sidecar 无 osId/osPretty 时整体缺徽标（optional 降级，§6.6）。
const metricsDistroBadge = computed<DistroBadge | null>(() => (metrics.value ? distroBadge(metrics.value.osId, metrics.value.osPretty) : null));

watch(() => session.value?.sessionId, (next, previous) => {
  if (next !== previous) {
    metricSamples.rx = [];
    metricSamples.tx = [];
    metricSamples.cpu = [];
    metricSamples.mem = [];
    // 录制挂在具体 session 上：换会话后本端标记复位（后端随旧会话自动收尾）。
    recordingActive.value = false;
    cancelRecordCountdown();
    stopRecordingClock();
  }
});

// ---------------------------------------------------------------------------
// 审计日志查看（IMPL_PLAN_NETCATTY_PARITY §3-B4）：独立工具栏入口，
// 只读最近 200 条；打开/过滤变化/刷新时拉取，失败静默空态。
// ---------------------------------------------------------------------------
const auditEntries = ref<AuditEntry[]>([]);
const auditLoading = ref(false);
const auditLoadFailed = ref(false);
const auditTruncated = ref(false);
const auditKindFilter = ref("");

async function loadAuditEntries() {
  auditLoading.value = true;
  try {
    // kind 过滤在客户端做（sanitizeAuditEntries 统一 newest-first；后端可能
    // 不认 `kind` 参数，见 lib/auditLog.ts 双形状容忍说明）。
    const result = await window.dbxPlugin.invoke<{ entries: unknown; truncated?: boolean }>("ssh/audit/list", { limit: 200 });
    auditEntries.value = sanitizeAuditEntries(result.entries, 200);
    auditTruncated.value = result.truncated === true;
    auditLoadFailed.value = false;
  } catch {
    // 失败不打断设置弹窗（§3-B4-T1），但与"确无记录"区分开：显示加载失败
    // 提示 + 重试入口（与其他设置 section 的 error+refresh 一致）。
    auditEntries.value = [];
    auditTruncated.value = false;
    auditLoadFailed.value = true;
  } finally {
    auditLoading.value = false;
  }
}

function openAuditLog() {
  auditOpen.value = true;
  auditKindFilter.value = "";
  void loadAuditEntries();
}

const visibleAuditEntries = computed(() => {
  if (!auditKindFilter.value) return auditEntries.value;
  return auditEntries.value.filter((entry) => entry.kind === auditKindFilter.value);
});

async function clearAuditLog() {
  if (!window.confirm(t("auditLog.clearConfirm"))) return;
  try {
    await window.dbxPlugin.invoke("ssh/audit/clear", {});
  } catch {
    // 清空失败静默：保留现列表，用户可再次尝试或刷新。
  }
  await loadAuditEntries();
}

function auditTime(ts: number) {
  if (!ts) return "";
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "short", timeStyle: "medium" }).format(new Date(ts * 1000));
}

function auditRowKindClass(kind: string) {
  return `k-${kind.replace(/\./g, "-")}`;
}

async function loadHome() {
  if (!session.value) return;
  const result = await window.dbxPlugin.invoke<{ path: string }>("sftp/home", { sessionId: session.value.sessionId });
  sftpHomePath.value = normalizeRemotePath(result.path);
  await loadDirectory(result.path);
}

/** 会话接通后探测一次主目录：quick tab 置顶项（失败静默隐藏，不阻塞浏览）。 */
async function refreshSftpHomePath() {
  if (!session.value) return;
  try {
    const result = await window.dbxPlugin.invoke<{ path: string }>("sftp/home", { sessionId: session.value.sessionId });
    sftpHomePath.value = normalizeRemotePath(result.path);
  } catch {
    // 旧 sidecar 缺 sftp/home 或探测失败：quick tab 只展示静态快捷路径。
  }
}

// ---- SFTP 侧栏（tree/quick 双 tab）--------------------------------------------

/** quick tab 条目：home 探测结果置顶 + SFTP_QUICK_PATHS 静态列表（去重）。 */
const sideQuickPaths = computed<SftpSideQuickPath[]>(() => {
  const list: SftpSideQuickPath[] = [];
  if (sftpHomePath.value) list.push({ path: sftpHomePath.value, label: t("home"), home: true });
  for (const path of SFTP_QUICK_PATHS) {
    if (!list.some((item) => item.path === path)) list.push({ path, label: path });
  }
  return list;
});

/** 侧栏树懒加载：collapse 只翻标记保留缓存；未加载时拉 sftp/list 挂子节点。 */
async function expandSideTreeNode(node: DirTreeNode) {
  if (node.expanded) {
    node.expanded = false;
    return;
  }
  if (!node.loaded) {
    if (!session.value) return;
    node.loading = true;
    try {
      const result = await window.dbxPlugin.invoke<{ entries: SftpEntry[] }>(sudoMode.value ? "sudo/listDir" : "sftp/list", {
        sessionId: session.value.sessionId,
        path: node.path,
      });
      applyTreeChildren(sftpTree.value, node.path, result.entries.map((entry) => ({ path: pathFromUri(entry.uri), name: entry.name, kind: entry.kind })));
    } catch (cause) {
      showError(cause); // 树展开失败要有反馈，不能静默（对标 files 插件 P-FILES 反馈）
    } finally {
      node.loading = false;
    }
    return;
  }
  node.expanded = true;
}

/** tree tab 可见时确保根已展开（未连接时跳过，接通后由 afterSessionConnected 触发）。 */
function ensureSideTreeRoot() {
  if (sftpSideTab.value !== "tree" || !session.value) return;
  const root = sftpTree.value;
  if (!root.loaded && !root.loading) void expandSideTreeNode(root);
}

/** 侧栏刷新按钮：整树标记重拉后重展开根。 */
function refreshSideTree() {
  const root = sftpTree.value;
  markTreeStale(root);
  root.expanded = false;
  void expandSideTreeNode(root);
}

/** 侧栏（目录树/快捷路径）行右键：打开 / 复制路径 / 复制文件名 / 压缩。 */
function openSideMenu(payload: { path: string; x: number; y: number }) {
  terminalMenu.value = undefined;
  fileMenu.value = undefined;
  blankMenu.value = undefined;
  sideMenu.value = { x: Math.min(payload.x, window.innerWidth - 190), y: Math.min(payload.y, window.innerHeight - 220), path: payload.path };
}

function sideMenuAction(action: "open" | "copyPath" | "copyName" | "archive") {
  const menu = sideMenu.value;
  sideMenu.value = undefined;
  if (!menu) return;
  if (action === "open") {
    goToPath(menu.path);
    return;
  }
  if (action === "archive") {
    void archiveSidePath(menu.path);
    return;
  }
  const value = action === "copyPath" ? menu.path : remoteBasename(menu.path) || "/";
  copyTextToClipboard(value, action === "copyPath" ? "sftpCopy.copiedPath" : "sftpCopy.copiedName");
}

/** 侧栏目录压缩：归档落在该目录自身所在父目录（与行内 archiveEntry 语义一致）。 */
async function archiveSidePath(path: string) {
  const sessionId = session.value?.sessionId;
  if (!sessionId || archiveBusy.value) return;
  archiveBusy.value = true;
  const archiveName = `${remoteBasename(path) || "root"}.tar.gz`;
  try {
    await window.dbxPlugin.invoke("sftp/archive", {
      sessionId,
      sourcePaths: [path],
      archivePath: joinRemote(parentPath(path), archiveName),
    }, { timeoutMs: 30 * 60 * 1000 });
    showNotice(t("archive.done", { name: archiveName }));
    // 父目录内容已变化：树缓存标记重拉；当前目录正是父目录时同步刷新列表。
    const parentNode = findTreeNode(sftpTree.value, parentPath(path));
    if (parentNode) parentNode.loaded = false;
    if (currentPath.value === parentPath(path)) await loadDirectory();
  } catch (cause) {
    showError(cause);
  } finally {
    archiveBusy.value = false;
  }
}

/** 空白处右键：新建文件夹 / 新建文件 / 刷新（三菜单互斥，弹前先关其它）。 */
function openBlankMenu(payload: { x: number; y: number }) {
  terminalMenu.value = undefined;
  fileMenu.value = undefined;
  sideMenu.value = undefined;
  blankMenu.value = { x: Math.min(payload.x, window.innerWidth - 190), y: Math.min(payload.y, window.innerHeight - 160) };
}

function blankMenuAction(action: "mkdir" | "newFile" | "refresh") {
  const menu = blankMenu.value;
  blankMenu.value = undefined;
  if (!menu) return;
  if (action === "refresh") {
    void loadDirectory();
    return;
  }
  if (action === "mkdir") {
    operationDraft.value = "";
    operationDialog.value = "mkdir";
  } else {
    openNewFileDialog();
  }
}

/** 通用剪贴板写入 + 已复制提示（行菜单/侧栏菜单共用；失败走 sftp 错误条）。 */
function copyTextToClipboard(value: string, noticeKey: string, values?: Record<string, string | number>) {
  void writeClipboardText(value, clipboardDeps())
    .then(() => showNotice(t(noticeKey, values)))
    .catch((cause) => showError(cause instanceof Error ? cause : new Error(String(cause))));
}

// R3-P1-3：目录列表加载的单调请求序号。慢链路下"先发 A 后发 B、A 晚到"
// 会把列表/路径/历史整体回跳；只有最新请求允许落地，过期响应整体丢弃。
const listEpoch = createRequestEpoch();

async function loadDirectory(path = currentPath.value, fromTerminal = false) {
  if (!session.value) return;
  const normalized = normalizeRemotePath(path);
  const epochId = listEpoch.next();
  loadingFiles.value = true;
  if (!fromTerminal) sftpError.value = "";
  try {
    const result = await window.dbxPlugin.invoke<{ entries: SftpEntry[] }>(sudoMode.value ? "sudo/listDir" : "sftp/list", {
      sessionId: session.value.sessionId,
      path: normalized,
    });
    if (!listEpoch.isCurrent(epochId)) return;
    // R3-P2-3：响应容错——非数组/畸形行走 sanitize（null entries → 空数组、
    // 缺 kind 的行降级为 file），单行坏数据不再让列表僵死或抛 pageerror。
    entries.value = sanitizeSftpEntries(result.entries);
    currentPath.value = normalized;
    selectedPath.value = "";
    clearRowSelection();
    rememberPathHistory(normalized);
    persistState();
    void refreshDiskUsage();
  } catch (cause) {
    if (!listEpoch.isCurrent(epochId)) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (fromTerminal) showNotice(t("followDirectoryFailed", { path: normalized, error: message }));
    else sftpError.value = message;
  } finally {
    if (listEpoch.isCurrent(epochId)) loadingFiles.value = false;
  }
}

function toggleSudoMode() {
  if (!connected.value || !canWrite.value || loadingFiles.value) return;
  sudoMode.value = !sudoMode.value;
  persistState();
  void loadDirectory();
}

function goParent() {
  void loadDirectory(parentPath(currentPath.value));
}

async function setDirectoryTracking(enabled: boolean) {
  if (!session.value) return;
  if (enabled && directoryTrackingSupported.value === false) {
    showNotice(t("directoryTrackingUnsupported"));
    followDirectory.value = false;
    return;
  }
  if (pendingTerminalInput) {
    showNotice(t("followDirectoryInputPending"));
    return;
  }
  try {
    await window.dbxPlugin.invoke("ssh/terminal/directoryTracking", { sessionId: session.value.sessionId, enabled });
    followDirectory.value = enabled;
    directoryParser.reset();
    persistState();
  } catch (cause) {
    showError(cause, "terminal");
  }
}

function togglePaneOrder() {
  paneOrder.value = paneOrder.value === "terminal-left" ? "sftp-left" : "terminal-left";
  persistState();
  void nextTick(scheduleFit);
}

function toggleSftpPane() {
  sftpPaneOpen.value = !sftpPaneOpen.value;
  persistState();
  void nextTick(scheduleFit);
}

// 全局偏好只影响新工作台的初始面板状态；当前工作台不被连带切换。
function toggleSftpPaneDefaultOpen() {
  sftpPaneDefaultOpen.value = !sftpPaneDefaultOpen.value;
  try {
    window.localStorage.setItem(SFTP_PANE_OPEN_KEY, sftpPaneDefaultOpen.value ? "true" : "false");
  } catch {
    // localStorage 不可用时偏好仅对当前会话生效。
  }
}

function loadSftpPaneDefaultOpen(): boolean {
  try {
    return sanitizeSftpPaneDefaultOpen(window.localStorage.getItem(SFTP_PANE_OPEN_KEY));
  } catch {
    return false;
  }
}

// 下载偏好（保存目录 + 每次询问）：权威存储在 sidecar preferences.json——
// 工作台 iframe 是 sandbox="allow-scripts"（opaque origin），localStorage
// 直接抛 SecurityError；localStorage 仅作 web 浏览器直连场景的同步缓存。
let downloadPrefsHydrated = false;

function loadDownloadDir(): string {
  return downloadDirState.value;
}

function persistDownloadDir(value: string) {
  downloadDirState.value = value.trim();
  void syncDownloadPrefs();
}

function loadDownloadUseDefaultDir(): boolean {
  return downloadUseDefaultState.value;
}

function persistDownloadUseDefaultDir(value: boolean) {
  downloadUseDefaultState.value = value;
  void syncDownloadPrefs();
}

function loadDownloadConflictPolicy(): DownloadConflictPolicy {
  return downloadConflictState.value;
}

function persistDownloadConflictPolicy(value: DownloadConflictPolicy) {
  downloadConflictState.value = sanitizeConflictPolicy(value);
  void syncDownloadPrefs();
}

function cacheDownloadPrefs() {
  try {
    if (downloadDirState.value) window.localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDirState.value);
    else window.localStorage.removeItem(DOWNLOAD_DIR_KEY);
    // 默认开：只在关闭时落键（"0"），未来默认策略变化时老用户不被钉死。
    if (!downloadUseDefaultState.value) window.localStorage.setItem(DOWNLOAD_USE_DEFAULT_KEY, "0");
    else window.localStorage.removeItem(DOWNLOAD_USE_DEFAULT_KEY);
    if (downloadConflictState.value !== "rename") window.localStorage.setItem(DOWNLOAD_CONFLICT_KEY, downloadConflictState.value);
    else window.localStorage.removeItem(DOWNLOAD_CONFLICT_KEY);
  } catch {
    // opaque origin：缓存跳过，内存态仍支撑本次会话。
  }
}

async function syncDownloadPrefs() {
  cacheDownloadPrefs();
  try {
    await window.dbxPlugin.invoke("local/preferences/set", {
      downloadDir: downloadDirState.value,
      downloadUseDefaultDir: downloadUseDefaultState.value,
      downloadConflictPolicy: downloadConflictState.value,
    });
  } catch {
    // 旧 sidecar 无此方法：本次会话内存态兜底。
  }
}

async function hydrateDownloadPrefs() {
  if (downloadPrefsHydrated) return;
  downloadPrefsHydrated = true;
  try {
    downloadDirState.value = window.localStorage.getItem(DOWNLOAD_DIR_KEY)?.trim() || "";
    downloadUseDefaultState.value = window.localStorage.getItem(DOWNLOAD_USE_DEFAULT_KEY) !== "0";
    downloadConflictState.value = sanitizeConflictPolicy(window.localStorage.getItem(DOWNLOAD_CONFLICT_KEY));
  } catch {
    // 同上：等待 sidecar 权威值。
  }
  try {
    const prefs = await window.dbxPlugin.invoke<{ downloadDir?: unknown; downloadUseDefaultDir?: unknown; downloadConflictPolicy?: unknown }>("local/preferences/get", {});
    if (typeof prefs.downloadDir === "string") downloadDirState.value = prefs.downloadDir.trim();
    if (typeof prefs.downloadUseDefaultDir === "boolean") downloadUseDefaultState.value = prefs.downloadUseDefaultDir;
    if (prefs.downloadConflictPolicy !== undefined) downloadConflictState.value = sanitizeConflictPolicy(prefs.downloadConflictPolicy);
    cacheDownloadPrefs();
  } catch {
    // 旧 sidecar：保留 localStorage 种子或默认。
  }
}

// 「使用默认地址」关闭时，下载/导出前弹出目录选择小窗。resolve 语义：
// { dir, setDefault } = 用户确认（dir 空串 = 默认下载目录；setDefault =
// 勾选了「将此次目录设为默认地址」）；undefined = 取消本次下载。
interface DownloadPrompt {
  fileName: string;
  dir: string;
  setDefault: boolean;
  resolve: (result: { dir: string; setDefault: boolean } | undefined) => void;
}
const downloadPrompt = ref<DownloadPrompt | null>(null);

function askDownloadTarget(fileName: string): Promise<{ dir: string; setDefault: boolean } | undefined> {
  return new Promise((resolve) => {
    downloadPrompt.value = {
      fileName,
      dir: loadDownloadDir() || localDownloadDir.value,
      setDefault: false,
      resolve,
    };
  });
}

function resolveDownloadPrompt(result?: { dir: string; setDefault: boolean }) {
  downloadPrompt.value?.resolve(result);
  downloadPrompt.value = null;
}

// 勾选「设为默认地址」后的闭环回写：目录成为新默认 + 自动打开
// 「使用默认地址」开关（设置页草稿同步，弹窗开着也能立即看到）。
function applyChosenDirAsDefault(dir: string) {
  const normalized = dir.trim();
  if (normalized) {
    persistDownloadDir(normalized);
    downloadDirDraft.value = normalized;
  }
  persistDownloadUseDefaultDir(true);
  downloadUseDefaultDraft.value = true;
}

// 「浏览」按钮打开应用内目录选择器（FolderPickerDialog，sidecar 列本机
// 目录）：沙箱 iframe 没有目录选择 API，原生系统对话框有窗口层级问题。
// target 记录选中值回填到哪——下载询问弹窗还是设置页草稿。
const folderPickerTarget = ref<"prompt" | "settings" | null>(null);

function onFolderPicked(path: string) {
  if (folderPickerTarget.value === "prompt" && downloadPrompt.value) {
    downloadPrompt.value.dir = path;
  } else if (folderPickerTarget.value === "settings") {
    downloadDirDraft.value = path;
  }
  folderPickerTarget.value = null;
}

// 「询问我」冲突策略：目标目录已有同名文件时弹确认（自动重命名/覆盖/取消）。
interface DownloadConflictPrompt {
  fileName: string;
  path: string;
  resolve: (choice: "rename" | "overwrite" | undefined) => void;
}
const downloadConflictPrompt = ref<DownloadConflictPrompt | null>(null);

function askDownloadConflict(fileName: string, path: string) {
  return new Promise<"rename" | "overwrite" | undefined>((resolve) => {
    downloadConflictPrompt.value = { fileName, path, resolve };
  });
}

function resolveDownloadConflict(choice: "rename" | "overwrite" | undefined) {
  downloadConflictPrompt.value?.resolve(choice);
  downloadConflictPrompt.value = null;
}

// 落盘前的冲突解析：返回传给后端的冲突模式，undefined = 用户取消。
// rename/overwrite 策略直接放行；ask 仅在确实撞名时打断，预检失败不阻断。
async function resolveDownloadConflictFor(dir: string, fileName: string): Promise<"rename" | "overwrite" | undefined> {
  const policy = loadDownloadConflictPolicy();
  if (policy !== "ask") return policy;
  const targetDir = dir || loadDownloadDir() || localDownloadDir.value;
  if (!targetDir) return "rename";
  try {
    const probe = await window.dbxPlugin.invoke<{ exists: boolean; path: string }>("local/fs/exists", { dir: targetDir, name: fileName });
    if (!probe.exists) return "rename";
    return await askDownloadConflict(fileName, probe.path);
  } catch {
    return "rename";
  }
}

function loadSelectCopyEnabled(): boolean {
  try {
    return sanitizeSelectCopyEnabled(window.localStorage.getItem(SELECT_COPY_KEY));
  } catch {
    return true;
  }
}

// 侧栏形态偏好：localStorage 全局持久化（不可用时仅当前会话生效，默认 tree/展开）。
function loadSftpSideTab(): "tree" | "quick" {
  try {
    return window.localStorage.getItem(SFTP_SIDE_TAB_KEY) === "quick" ? "quick" : "tree";
  } catch {
    return "tree";
  }
}

function loadSftpSideCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SFTP_SIDE_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSftpSideShape() {
  try {
    window.localStorage.setItem(SFTP_SIDE_TAB_KEY, sftpSideTab.value);
    window.localStorage.setItem(SFTP_SIDE_COLLAPSED_KEY, sftpSideCollapsed.value ? "true" : "false");
  } catch {
    // localStorage 不可用时偏好仅对当前会话生效。
  }
}

function setSftpSideTab(tab: "tree" | "quick") {
  sftpSideTab.value = tab;
  persistSftpSideShape();
  if (tab === "tree") ensureSideTreeRoot();
}

function setSftpSideCollapsed(collapsed: boolean) {
  sftpSideCollapsed.value = collapsed;
  persistSftpSideShape();
}

// 切换即生效并持久化（纯前端行为，不进连接级 ssh/settings）。
function toggleSelectCopy() {
  termSelectCopy.value = !termSelectCopy.value;
  try {
    window.localStorage.setItem(SELECT_COPY_KEY, termSelectCopy.value ? "true" : "false");
  } catch {
    // localStorage 不可用时偏好仅对当前会话生效。
  }
  showNotice(t(termSelectCopy.value ? "terminalSelectCopy.enabledNotice" : "terminalSelectCopy.disabledNotice"));
}

function startDividerDrag(event: PointerEvent) {
  const container = paneContainer.value;
  if (!container) return;
  const pointerId = event.pointerId;
  const move = (next: PointerEvent) => {
    const bounds = container.getBoundingClientRect();
    const fromLeft = ((next.clientX - bounds.left) / bounds.width) * 100;
    const terminalPercent = paneOrder.value === "terminal-left" ? fromLeft : 100 - fromLeft;
    splitRatio.value = Math.max(35, Math.min(80, terminalPercent));
    scheduleFit();
  };
  const stop = () => {
    container.releasePointerCapture(pointerId);
    container.removeEventListener("pointermove", move);
    container.removeEventListener("pointerup", stop);
    container.removeEventListener("pointercancel", stop);
    persistState();
  };
  container.setPointerCapture(pointerId);
  container.addEventListener("pointermove", move);
  container.addEventListener("pointerup", stop);
  container.addEventListener("pointercancel", stop);
}

function toggleColumn(column: SftpColumn) {
  visibleColumns.value = visibleColumns.value.includes(column) ? visibleColumns.value.filter((value) => value !== column) : [...visibleColumns.value, column];
  persistState();
}

function toggleSort(column: SftpSortColumn) {
  sort.value = sort.value.column === column ? { column, direction: sort.value.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" };
}

function sortIcon(column: SftpSortColumn) {
  if (sort.value.column !== column) return ArrowUpDown;
  return sort.value.direction === "asc" ? ArrowUp : ArrowDown;
}

async function openEntry(entry: SftpEntry) {
  if (previewOpen.value && previewDirty.value && !window.confirm(t("editSave.closeConfirm"))) return;
  if (entry.kind === "directory") {
    await loadDirectory(pathFromUri(entry.uri));
    return;
  }
  if (entry.kind !== "file") return;
  if (isImagePreviewable(entry)) {
    await openImagePreview(entry, IMAGE_MIME_BY_EXTENSION[imagePreviewExtension(entry.name)]);
    return;
  }
  const size = entry.size || 0;
  // 已知二进制扩展名：不打开，直接提示（无需先读内容）。
  if (size > 0 && hasBinaryExtension(entry.name)) {
    showNotice(t("binaryFile.notOpen", { name: entry.name }));
    return;
  }
  // 大文件先询问：确认后仍预览，但只加载头部且只读。
  if (size > MAX_INLINE_PREVIEW_BYTES && !window.confirm(t("previewDialog.tooLargeConfirm", { name: entry.name, size: formatBytes(size), limit: formatBytes(MAX_INLINE_PREVIEW_BYTES) }))) return;
  // 内容嗅探兜底：无后缀或改名的二进制文件在打开前拦下。
  if (size > 0 && (await remoteFileLooksBinary(entry))) {
    showNotice(t("binaryFile.notOpen", { name: entry.name }));
    return;
  }
  previewMode.value = "text";
  previewImageUrl.value = "";
  previewImageZoomed.value = false;
  previewTruncated.value = false;
  previewOpen.value = true;
  previewLoading.value = true;
  previewTitle.value = entry.name;
  previewText.value = "";
  previewPath.value = pathFromUri(entry.uri);
  previewSize.value = entry.size || 0;
  previewEditable.value = false;
  previewDraft.value = "";
  previewBaseline.value = "";
  try {
    // sudo 模式下文本文件改走 sudo/readFile，避免无权限文件预览失败。
    const result = sudoMode.value
      ? await window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sudo/readFile", {
          sessionId: session.value?.sessionId,
          path: pathFromUri(entry.uri),
          offset: 0,
          length: MAX_INLINE_PREVIEW_BYTES,
        })
      : await window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sftp/read", {
          sessionId: session.value?.sessionId,
          path: pathFromUri(entry.uri),
          maxBytes: MAX_INLINE_PREVIEW_BYTES,
        });
    // 截断 = 只展示了文件头部：保持只读（保存会整文件覆写，丢掉未加载部分）。
    previewTruncated.value = result.truncated;
    previewText.value = new TextDecoder("utf-8", { fatal: false }).decode(window.dbxPlugin.decodeBase64(result.dataBase64));
    previewBaseline.value = previewText.value;
  } catch (cause) {
    previewText.value = cause instanceof Error ? cause.message : String(cause);
    previewBaseline.value = previewText.value;
  } finally {
    previewLoading.value = false;
  }
}

// 预览前的二进制嗅探：读头部 SNIFF_CHUNK_BYTES 字节交给 looksBinary 判定。
// 嗅探失败不拦预览，交给正式读取报错。
async function remoteFileLooksBinary(entry: SftpEntry) {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return false;
  try {
    const result = sudoMode.value
      ? await window.dbxPlugin.invoke<{ dataBase64: string }>("sudo/readFile", {
          sessionId,
          path: pathFromUri(entry.uri),
          offset: 0,
          length: SNIFF_CHUNK_BYTES,
        })
      : await window.dbxPlugin.invoke<{ dataBase64: string }>("sftp/read", {
          sessionId,
          path: pathFromUri(entry.uri),
          maxBytes: SNIFF_CHUNK_BYTES,
        });
    return looksBinary(window.dbxPlugin.decodeBase64(result.dataBase64));
  } catch {
    return false;
  }
}

async function openImagePreview(entry: SftpEntry, mime: string) {
  previewMode.value = "image";
  previewTruncated.value = false;
  previewImageUrl.value = "";
  previewImageZoomed.value = false;
  previewOpen.value = true;
  previewLoading.value = true;
  previewTitle.value = entry.name;
  previewText.value = "";
  previewPath.value = pathFromUri(entry.uri);
  previewSize.value = entry.size || 0;
  previewEditable.value = false;
  previewDraft.value = "";
  previewBaseline.value = "";
  try {
    const result = await window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sftp/read", {
      sessionId: session.value?.sessionId,
      path: pathFromUri(entry.uri),
      maxBytes: MAX_IMAGE_PREVIEW_BYTES,
    });
    if (result.truncated) {
      previewOpen.value = false;
      await downloadEntry(entry);
      return;
    }
    previewImageUrl.value = `data:image/${mime};base64,${result.dataBase64}`;
  } catch (cause) {
    previewOpen.value = false;
    showError(cause);
  } finally {
    previewLoading.value = false;
  }
}

function fileExtension(name: string) {
  return name.includes(".") ? name.split(".").pop()?.toLowerCase() || "" : "";
}

function imagePreviewExtension(name: string) {
  const extension = fileExtension(name);
  return extension in IMAGE_MIME_BY_EXTENSION ? extension : "";
}

function isImagePreviewable(entry: SftpEntry) {
  const size = entry.size || 0;
  return !!imagePreviewExtension(entry.name) && size > 0 && size <= MAX_IMAGE_PREVIEW_BYTES;
}

function hasBinaryExtension(name: string) {
  return BINARY_PREVIEW_EXTENSIONS.has(fileExtension(name));
}

function confirmDiscardPreviewEdits() {
  return !previewDirty.value || window.confirm(t("editSave.closeConfirm"));
}

function closePreview() {
  if (!confirmDiscardPreviewEdits()) return;
  previewOpen.value = false;
  previewEditable.value = false;
  previewDraft.value = "";
  previewImageUrl.value = "";
  previewImageZoomed.value = false;
}

function beginPreviewEdit() {
  if (!previewEditableAllowed.value) return;
  previewDraft.value = previewText.value;
  previewEditable.value = true;
}

function cancelPreviewEdit() {
  if (!confirmDiscardPreviewEdits()) return;
  previewEditable.value = false;
  previewDraft.value = "";
}

async function savePreview() {
  const sessionId = session.value?.sessionId;
  if (!sessionId || previewSaving.value || !previewPath.value) return;
  previewSaving.value = true;
  try {
    const bytes = new TextEncoder().encode(previewDraft.value);
    if (bytes.byteLength > MAX_DIRECT_WRITE_BYTES) {
      showError(new Error(t("sftpAttrs.sizeLimit")));
      return;
    }
    const dataBase64 = window.dbxPlugin.encodeBase64(bytes);
    if (sudoMode.value) {
      await window.dbxPlugin.invoke("sudo/writeFile", {
        sessionId,
        path: previewPath.value,
        dataBase64,
      });
    } else {
      await window.dbxPlugin.invoke("sftp/write", {
        sessionId,
        remotePath: previewPath.value,
        dataBase64,
      });
    }
    previewText.value = previewDraft.value;
    previewSize.value = bytes.byteLength;
    previewBaseline.value = previewText.value;
    previewEditable.value = false;
    previewDraft.value = "";
    showNotice(t("editSave.saved", { name: previewTitle.value }));
    await loadDirectory();
  } catch (cause) {
    showError(cause);
  } finally {
    previewSaving.value = false;
  }
}

function isArchiveName(name: string) {
  return /\.(tar\.gz|tgz|tar)$/i.test(name);
}

function archiveDirectoryName(name: string) {
  if (/\.(tar\.gz|tgz)$/i.test(name)) return name.replace(/\.(tar\.gz|tgz)$/i, "");
  return name.replace(/\.tar$/i, "");
}

async function archiveEntry(entry: SftpEntry) {
  const sessionId = session.value?.sessionId;
  // 目录与单文件都可压缩（sftp/archive 支持任意路径列表）。
  if (!sessionId || archiveBusy.value) return;
  fileMenu.value = undefined;
  archiveBusy.value = true;
  const archiveName = `${entry.name}.tar.gz`;
  try {
    await window.dbxPlugin.invoke("sftp/archive", {
      sessionId,
      sourcePaths: [pathFromUri(entry.uri)],
      archivePath: joinRemote(currentPath.value, archiveName),
    }, { timeoutMs: 30 * 60 * 1000 });
    showNotice(t("archive.done", { name: archiveName }));
    await loadDirectory();
  } catch (cause) {
    showError(cause);
  } finally {
    archiveBusy.value = false;
  }
}

async function extractEntry(entry: SftpEntry) {
  const sessionId = session.value?.sessionId;
  if (!sessionId || archiveBusy.value) return;
  fileMenu.value = undefined;
  archiveBusy.value = true;
  const directoryName = archiveDirectoryName(entry.name);
  try {
    await window.dbxPlugin.invoke("sftp/extract", {
      sessionId,
      archivePath: pathFromUri(entry.uri),
      destinationPath: joinRemote(currentPath.value, directoryName),
      overwrite: false,
    }, { timeoutMs: 30 * 60 * 1000 });
    showNotice(t("extract.done", { name: directoryName }));
    await loadDirectory();
  } catch (cause) {
    showError(cause);
  } finally {
    archiveBusy.value = false;
  }
}

function beginRename(entry: SftpEntry) {
  if (!canWrite.value) return;
  selectedPath.value = entry.uri;
  renamingPath.value = entry.uri;
  renameDraft.value = entry.name;
  void nextTick(() => document.querySelector<HTMLInputElement>(".rename-input")?.select());
}

async function commitRename(entry: SftpEntry) {
  // R3-P1-2 / R3-P2-1：blur 是"卸载/失焦"兜底提交入口。Esc 取消会先清
  // renamingPath 再卸载输入框，Enter 提交成功后也会清空——两种场景下
  // editingPath 已不指向本行，blur 到达时被 shouldCommitRename 短路，
  // 取消语义不再以草稿名逃逸提交、Enter 也不再双发。
  if (!shouldCommitRename({ editingPath: renamingPath.value, entryUri: entry.uri, submitting: renameSubmitting.value })) return;
  const name = renameDraft.value.trim();
  if (!session.value || !name || name === entry.name) {
    renamingPath.value = "";
    return;
  }
  const sourcePath = pathFromUri(entry.uri);
  const targetPath = joinRemote(currentPath.value, name);
  renameSubmitting.value = true;
  try {
    // R3-P2-2：与粘贴对齐的目标存在性预检。OpenSSH rename 撞名语义依
    // posix-rename 扩展而异，前端先给出明确的覆盖确认；预检失败不阻断，
    // 交由后端执行时报错。
    let targetExists = false;
    try {
      const probe = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", {
        sessionId: session.value.sessionId,
        path: targetPath,
      });
      targetExists = probe.exists === true;
    } catch {
      // 预检不可用时保持原语义直接下发。
    }
    if (targetExists && !window.confirm(t("sftpRename.overwriteConfirm", { name }))) {
      renamingPath.value = "";
      return;
    }
    if (sudoMode.value) {
      await window.dbxPlugin.invoke("sudo/rename", { sessionId: session.value.sessionId, sourcePath, targetPath });
    } else {
      await window.dbxPlugin.invoke("sftp/rename", { sessionId: session.value.sessionId, sourcePath, targetPath });
    }
    renamingPath.value = "";
    await loadDirectory();
  } catch (cause) {
    // R3-P2-2：失败路径收敛——关闭行内编辑态并刷新列表，不再滞留打开态。
    renamingPath.value = "";
    showError(cause);
    await loadDirectory();
  } finally {
    renameSubmitting.value = false;
  }
}

async function createDirectory() {
  const name = operationDraft.value.trim();
  if (!session.value || !name) return;
  const path = joinRemote(currentPath.value, name);
  try {
    if (sudoMode.value) {
      await window.dbxPlugin.invoke("sudo/mkdir", { sessionId: session.value.sessionId, path });
    } else {
      await window.dbxPlugin.invoke("sftp/createDirectory", { sessionId: session.value.sessionId, path });
    }
    operationDialog.value = null;
    await loadDirectory();
  } catch (cause) {
    showError(cause);
  }
}

async function confirmDelete() {
  if (!session.value || !deleteTarget.value) return;
  deleteSubmitting.value = true;
  try {
    const path = pathFromUri(deleteTarget.value.uri);
    if (sudoMode.value) {
      await window.dbxPlugin.invoke(deleteTarget.value.kind === "directory" ? "sudo/removeAll" : "sudo/remove", {
        sessionId: session.value.sessionId,
        path,
      });
    } else {
      await window.dbxPlugin.invoke("sftp/delete", {
        sessionId: session.value.sessionId,
        path,
        recursive: deleteTarget.value.kind === "directory",
      });
    }
    deleteTarget.value = undefined;
    await loadDirectory();
    showNotice(t("deleted"));
  } catch (cause) {
    showError(cause);
  } finally {
    deleteSubmitting.value = false;
  }
}

// ---------------------------------------------------------------------------
// SFTP 面板：搜索/多选/批量/新建文件/属性/路径历史/复制粘贴
// ---------------------------------------------------------------------------

function loadPathHistories(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(SFTP_PATH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return sanitizePathHistories(parsed, SFTP_PATH_HISTORY_LIMIT);
  } catch {
    return {};
  }
}

function persistPathHistories() {
  try {
    window.localStorage.setItem(SFTP_PATH_HISTORY_KEY, JSON.stringify(pathHistories));
  } catch {
    // localStorage 不可用时路径历史仅保留在内存中。
  }
}

function rememberPathHistory(path: string) {
  const key = connectionId.value;
  if (!key || !path) return;
  const next = pushPathHistory(pathHistories, key, path, SFTP_PATH_HISTORY_LIMIT);
  for (const connection of Object.keys(next)) pathHistories[connection] = next[connection];
  persistPathHistories();
}

// ---------------------------------------------------------------------------
// SFTP 路径书签（全局清单）：星标收藏 + 路径弹层跳转/删除（sftp/bookmarks/*）
// ---------------------------------------------------------------------------

async function refreshBookmarks() {
  try {
    sftpBookmarks.value = sortBookmarksByLabel(await listBookmarks());
  } catch {
    // 后端未升级/读取失败时保留既有列表（optional 特性静默降级，不阻塞路径栏）。
  }
}

function toggleBookmarkSave() {
  if (!connected.value) return;
  if (bookmarkSaveOpen.value) {
    bookmarkSaveOpen.value = false;
    return;
  }
  closeToolbarPopovers();
  bookmarkLabelDraft.value = defaultBookmarkLabel(currentPath.value);
  bookmarkSaveOpen.value = true;
}

async function confirmBookmarkSave() {
  if (!connected.value || bookmarkSaving.value) return;
  const input = { label: bookmarkLabelDraft.value, path: currentPath.value };
  // 前端先行校验（与后端同规则）：label 空/超长/重复、path 空/超长、超上限。
  const localError = validateBookmarkInput(input, sftpBookmarks.value);
  if (localError) {
    showNotice(t(`sftpBookmark.error.${localError}`, localError === "limitReached" ? { limit: SFTP_BOOKMARKS_LIMIT } : {}));
    return;
  }
  bookmarkSaving.value = true;
  try {
    const result = await saveBookmark(input);
    sftpBookmarks.value = sortBookmarksByLabel([
      ...sftpBookmarks.value.filter((item) => item.id !== result.bookmark.id),
      result.bookmark,
    ]);
    bookmarkSaveOpen.value = false;
    showNotice(t("sftpBookmark.saved", { label: result.bookmark.label }));
  } catch (cause) {
    showError(cause);
  } finally {
    bookmarkSaving.value = false;
  }
}

async function removeBookmark(bookmark: SftpBookmark) {
  try {
    await deleteBookmark(bookmark.id);
    sftpBookmarks.value = sftpBookmarks.value.filter((item) => item.id !== bookmark.id);
    showNotice(t("sftpBookmark.deleted"));
  } catch (cause) {
    showError(cause);
  }
}

// 连接建立后拉取书签（全局共享，不随会话清空）；打开路径弹层时刷新兜底。
watch(connected, (value) => {
  if (value) void refreshBookmarks();
});
watch(pathHistoryOpen, (open) => {
  if (open) void refreshBookmarks();
});

function clearRowSelection() {
  selectedUris.value = [];
  lastClickedUri.value = "";
}

function selectFile(entry: SftpEntry, event?: MouseEvent) {
  selectedPath.value = entry.uri;
  if (event?.shiftKey && lastClickedUri.value) {
    const expanded = expandSelection(selectedUris.value, lastClickedUri.value, entry.uri, visibleEntries.value.map((item) => item.uri));
    if (expanded.length > selectedUris.value.length || selectedUris.value.includes(entry.uri)) {
      selectedUris.value = expanded;
      return;
    }
  }
  if (event?.ctrlKey || event?.metaKey) {
    selectedUris.value = selectedUris.value.includes(entry.uri)
      ? selectedUris.value.filter((uri) => uri !== entry.uri)
      : [...selectedUris.value, entry.uri];
  } else {
    selectedUris.value = [entry.uri];
  }
  lastClickedUri.value = entry.uri;
}

async function confirmBatchDelete() {
  const sessionId = session.value?.sessionId;
  const targets = selectedEntries.value;
  if (!sessionId || !targets.length || batchDeleteSubmitting.value) return;
  batchDeleteSubmitting.value = true;
  let progress = createBatchProgress(targets.length);
  batchProgress.value = progress;
  try {
    for (const entry of targets) {
      const path = pathFromUri(entry.uri);
      try {
        if (sudoMode.value) {
          await window.dbxPlugin.invoke(entry.kind === "directory" ? "sudo/removeAll" : "sudo/remove", { sessionId, path });
        } else {
          await window.dbxPlugin.invoke("sftp/delete", { sessionId, path, recursive: entry.kind === "directory" });
        }
        progress = advanceBatchProgress(progress, { name: entry.name, ok: true });
      } catch (cause) {
        progress = advanceBatchProgress(progress, { name: entry.name, ok: false });
        throw cause;
      }
      batchProgress.value = progress;
    }
    batchDeleteOpen.value = false;
    clearRowSelection();
    await loadDirectory();
    showNotice(t("deleted"));
  } catch (cause) {
    showError(cause);
    await loadDirectory();
  } finally {
    batchDeleteSubmitting.value = false;
    batchProgress.value = null;
  }
}

async function batchArchive() {
  const sessionId = session.value?.sessionId;
  const targets = selectedEntries.value;
  if (!sessionId || !targets.length || archiveBusy.value) return;
  archiveBusy.value = true;
  let progress = createBatchProgress(targets.length);
  batchProgress.value = progress;
  try {
    let done = 0;
    for (const entry of targets) {
      const archiveName = `${entry.name}.tar.gz`;
      try {
        await window.dbxPlugin.invoke("sftp/archive", {
          sessionId,
          sourcePaths: [pathFromUri(entry.uri)],
          archivePath: joinRemote(currentPath.value, archiveName),
        }, { timeoutMs: 30 * 60 * 1000 });
        progress = advanceBatchProgress(progress, { name: archiveName, ok: true });
      } catch (cause) {
        progress = advanceBatchProgress(progress, { name: archiveName, ok: false });
        throw cause;
      }
      batchProgress.value = progress;
      done += 1;
    }
    showNotice(t("sftpBatch.archiveDone", { count: done }));
    await loadDirectory();
  } catch (cause) {
    showError(cause);
    await loadDirectory();
  } finally {
    archiveBusy.value = false;
    batchProgress.value = null;
  }
}

function openNewFileDialog() {
  if (!connected.value || !canWrite.value) return;
  newFileDraft.value = "";
  newFileDialog.value = true;
}

async function createNewFile() {
  const sessionId = session.value?.sessionId;
  const name = newFileDraft.value.trim();
  if (!sessionId || !name || newFileSubmitting.value) return;
  newFileSubmitting.value = true;
  try {
    await window.dbxPlugin.invoke(sudoMode.value ? "sudo/touch" : "sftp/touch", {
      sessionId,
      path: joinRemote(currentPath.value, name),
    });
    newFileDialog.value = false;
    showNotice(t("sftpNewFile.done", { name }));
    await loadDirectory();
  } catch (cause) {
    showError(cause);
  } finally {
    newFileSubmitting.value = false;
  }
}

async function openAttributes(entry: SftpEntry) {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  fileMenu.value = undefined;
  attrsTarget.value = entry;
  attrsInfo.value = undefined;
  attrsMode.value = entry.permissions || "";
  attrsLoading.value = true;
  try {
    attrsInfo.value = await window.dbxPlugin.invoke<SftpStatInfo>(sudoMode.value ? "sudo/stat" : "sftp/stat", {
      sessionId,
      path: pathFromUri(entry.uri),
    });
    if (attrsInfo.value?.mode) attrsMode.value = attrsInfo.value.mode;
  } catch (cause) {
    showError(cause);
  } finally {
    attrsLoading.value = false;
  }
}

function closeAttributes() {
  attrsTarget.value = undefined;
  attrsInfo.value = undefined;
}

async function saveAttributesPermissions() {
  const sessionId = session.value?.sessionId;
  const entry = attrsTarget.value;
  const mode = attrsMode.value.trim();
  if (!sessionId || !entry || !mode || attrsSubmitting.value) return;
  attrsSubmitting.value = true;
  try {
    await window.dbxPlugin.invoke(sudoMode.value ? "sudo/chmod" : "sftp/chmod", {
      sessionId,
      path: pathFromUri(entry.uri),
      mode,
    });
    showNotice(t("permissionsUpdated"));
    if (attrsInfo.value) attrsInfo.value = { ...attrsInfo.value, mode };
    await loadDirectory();
  } catch (cause) {
    showError(cause);
  } finally {
    attrsSubmitting.value = false;
  }
}

function remoteBasename(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function copySelectedEntries(mode: "copy" | "cut") {
  const entry = fileMenu.value?.entry;
  if (!entry) return;
  const uris = selectedUris.value.includes(entry.uri) && selectedUris.value.length > 1 ? selectedUris.value : [entry.uri];
  sftpClipboard.value = { mode, paths: uris.map((uri) => pathFromUri(uri)), connectionId: connectionId.value };
  fileMenu.value = undefined;
  showNotice(t("sftpCopy.done", { count: sftpClipboard.value.paths.length }));
}

async function pasteClipboard() {
  const clip = sftpClipboard.value;
  const sessionId = session.value?.sessionId;
  if (!sessionId || pasteBusy.value) return;
  if (!clip || clip.connectionId !== connectionId.value || !clip.paths.length) {
    showNotice(t("sftpPaste.empty"));
    return;
  }
  if (!canWrite.value) return;
  // 粘贴前逐项检测目标是否已存在；存在则弹覆盖确认。
  const conflicting: string[] = [];
  for (const from of clip.paths) {
    try {
      const result = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", {
        sessionId,
        path: joinRemote(currentPath.value, remoteBasename(from)),
      });
      if (result.exists) conflicting.push(remoteBasename(from));
    } catch {
      // 存在性检测失败不阻断粘贴，交由后端执行时报错。
    }
  }
  let overwrite = false;
  if (conflicting.length) {
    if (!window.confirm(t("sftpPaste.overwriteConfirm", { count: conflicting.length, names: conflicting.slice(0, 5).join(", ") }))) return;
    overwrite = true;
  }
  pasteBusy.value = true;
  try {
    await window.dbxPlugin.invoke<{ success: boolean; results: Array<{ from: string; to: string; ok: boolean; error?: string }> }>(
      clip.mode === "cut" ? "sftp/move" : "sftp/copy",
      {
        connectionId: connectionId.value,
        from: clip.paths,
        toDir: currentPath.value,
        overwrite,
      },
      { timeoutMs: 30 * 60 * 1000 },
    );
    if (clip.mode === "cut") sftpClipboard.value = undefined;
    showNotice(t("sftpPaste.done", { count: clip.paths.length }));
    await loadDirectory();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/method not found/i.test(message)) showNotice(t("sftpPaste.backendMissing"));
    else showError(cause);
  } finally {
    pasteBusy.value = false;
  }
}

function goToPath(path: string) {
  pathHistoryOpen.value = false;
  void loadDirectory(path);
}

// R3-P2-4：路径栏提交统一入口——`~`（home 已探测时）展开、`.`/`..` 段消解
// 及基础归一，下游 joinRemote/exists 拼接与路径历史不再携带未规范路径。
function submitPathInput() {
  if (!connected.value) return;
  const target = resolveRemotePath(currentPath.value, sftpHomePath.value || undefined);
  currentPath.value = target;
  void loadDirectory(target);
}

// R3-P2-5：文件行键盘语义——Enter 打开（目录进入/文件预览）、F2 重命名、
// Delete 删除，对齐主流文件管理器；动作决策走 fileRowKeydown 纯模块（有
// 单测），重命名输入框内的按键已自带 .stop。
function onFileRowKeydown(event: KeyboardEvent, entry: SftpEntry) {
  const action = decideFileRowAction(event.key, canWrite.value);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "open") void openEntry(entry);
  else if (action === "rename") beginRename(entry);
  else deleteTarget.value = entry;
}

async function chooseUpload() {
  if (!connected.value || !canWrite.value) return;
  openTransferPanel();
  if (!window.dbxPlugin.fileTransfer) {
    uploadInput.value?.click();
    return;
  }
  try {
    const selection = await window.dbxPlugin.fileTransfer.pick({ multiple: true });
    await uploadHandleFiles(selection.files);
    await loadDirectory();
    if (selection.files.length) showNotice(t("uploaded", { count: selection.files.length }));
  } catch (cause) {
    showError(cause);
  }
}

async function uploadHandleFiles(files: Array<{ handleId: string; name: string; size: number }>) {
  if (!window.dbxPlugin.fileTransfer || !files.length) return;
  await runWithConcurrency(files, 3, async (file) => {
      try {
        await uploadSource(file.name, file.size, async (offset, length) => {
          const result = await window.dbxPlugin.fileTransfer!.read(file.handleId, offset, length);
          return window.dbxPlugin.decodeBase64(result.dataBase64);
        });
      } finally {
        await window.dbxPlugin.fileTransfer!.cancel(file.handleId).catch(() => undefined);
      }
  });
}

async function uploadLocalFiles(files: readonly File[], targetDir?: string) {
  openTransferPanel();
  await runWithConcurrency([...files], 3, (file) => uploadSource(file.name, file.size, async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), undefined, targetDir));
  await loadDirectory();
  if (files.length) showNotice(t("uploaded", { count: files.length }));
}

async function uploadSource(name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string) {
  if (!session.value) return;
  // resume 携带原 taskId/remotePath：后端校验 spool meta 后从已传前缀续接。
  // targetDir 仅新上传生效（终端拖入的自定义目标目录）；缺省仍是 SFTP 当前目录。
  const info = await window.dbxPlugin.invoke<{ taskId: string; chunkSize: number; resumeOffset?: number }>("sftp/upload/start", resume
    ? { sessionId: session.value.sessionId, remotePath: resume.remotePath, size, resumeTaskId: resume.taskId }
    : { sessionId: session.value.sessionId, remotePath: joinRemote(targetDir ?? currentPath.value, name), size });
  const startOffset = info.resumeOffset ?? 0;
  transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "upload", fileName: name, size, transferred: startOffset, status: startOffset > 0 ? "running" : "queued" };
  try {
    let offset = startOffset;
    while (offset < size) {
      await waitWhilePaused(info.taskId);
      const chunk = await readChunk(offset, info.chunkSize);
      if (!chunk.byteLength) throw new Error(t("errors.localFileShortRead"));
      const payload = new Uint8Array(8 + chunk.byteLength);
      writeU64(payload, 0, offset);
      payload.set(chunk, 8);
      const nextOffset = offset + chunk.byteLength;
      const ack = waitForUploadAck(info.taskId, nextOffset);
      await window.dbxPlugin.sendBinary(`sftp/upload/${info.taskId}`, payload);
      await ack;
      offset = nextOffset;
    }
    await window.dbxPlugin.invoke("sftp/upload/finish", { taskId: info.taskId }, { timeoutMs: 30 * 60 * 1000 });
  } catch (cause) {
    await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
    throw cause;
  }
}

function waitForUploadAck(taskId: string, nextOffset: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(async () => {
      uploadAckWaiters.delete(taskId);
      try {
        const status = await window.dbxPlugin.invoke<{ transferred: number; status: string }>("sftp/transfer/status", { taskId });
        if (status.transferred >= nextOffset && status.status === "running") resolve();
        else reject(new Error(t("errors.uploadAckTimeout")));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }, 30_000);
    uploadAckWaiters.set(taskId, { nextOffset, resolve, reject, timer });
  });
}

// 本机落盘能力探测（sidecar local/capabilities）：宿主缺 fileTransfer API 时，
// 桌面端 sidecar 可直接把下载写进本机下载目录；web/docker 模式探测失败或
// canSaveLocal=false 时回退浏览器 <a download>。结果按工作台生命周期缓存。
let localCapabilities: Promise<{ canSaveLocal: boolean; downloadsDir: string } | undefined> | undefined;
const localDownloadDir = ref("");
const localCanSave = ref(false);
function probeLocalCapabilities() {
  localCapabilities ??= window.dbxPlugin
    .invoke<{ canSaveLocal: boolean; downloadsDir: string }>("local/capabilities")
    .then((result) => {
      localDownloadDir.value = result.downloadsDir || "";
      localCanSave.value = result.canSaveLocal;
      return result;
    })
    .catch(() => undefined);
  return localCapabilities;
}

async function downloadEntry(entry: SftpEntry) {
  fileMenu.value = undefined;
  openTransferPanel();
  if (!session.value || entry.kind !== "file") return;
  // Prefer the sidecar local sink on desktop so completed downloads retain a
  // validated localPath for the reveal/open actions in the transfer panel and
  // persisted history. Fall back to the host file-transfer bridge when a
  // local filesystem is unavailable (web/docker).
  const local = await probeLocalCapabilities();
  const saveToLocal = !!local?.canSaveLocal;
  // 「使用默认地址」关闭时先选保存目录；取消则整次下载不发生。
  // 仅本地落盘可指定目录——web/docker 浏览器下载由浏览器决定位置。
  let dirOverride = "";
  let setDefaultAfter = false;
  if (saveToLocal && !loadDownloadUseDefaultDir()) {
    const chosen = await askDownloadTarget(entry.name);
    if (chosen === undefined) return;
    dirOverride = chosen.dir.trim();
    setDefaultAfter = chosen.setDefault;
  }
  // 冲突策略：ask 且确实撞名时先问，取消则整次下载不发生（仅本地落盘可查本机目录）。
  const conflict = saveToLocal ? await resolveDownloadConflictFor(dirOverride, entry.name) : undefined;
  if (saveToLocal && conflict === undefined) return;
  const fileTransfer = saveToLocal ? undefined : window.dbxPlugin.fileTransfer;
  // Web/Docker mode has no local sink and no host save dialog; the whole file
  // is buffered in browser memory before saving, so warn before large ones.
  if (!fileTransfer && !saveToLocal && (entry.size || 0) > WEB_DOWNLOAD_WARNING_BYTES && !window.confirm(t("webDownload.largeWarning", { name: entry.name, size: formatBytes(entry.size || 0) }))) return;
  let info: DownloadInfo | undefined;
  let target: { handleId: string; chunkBytes: number } | undefined;
  const chunks = fileTransfer || saveToLocal ? undefined : ([] as Uint8Array[]);
  try {
    info = await window.dbxPlugin.invoke<DownloadInfo>("sftp/download/start", {
      sessionId: session.value.sessionId,
      remotePath: pathFromUri(entry.uri),
      saveToLocal,
      downloadDir: dirOverride || loadDownloadDir() || undefined,
      conflict: conflict === "overwrite" ? "overwrite" : undefined,
    });
    transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "download", fileName: info.fileName, size: info.size, transferred: 0, status: "queued" };
    target = fileTransfer ? await fileTransfer.beginSave({ name: info.fileName, size: info.size }) : undefined;
    let offset = 0;
    while (offset < info.size) {
      await waitWhilePaused(info.taskId);
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // Cancellation interrupts via the chunk waiter; swallow the rejection of the
      // in-flight request so it cannot surface as an unhandled promise rejection.
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      const chunk = await chunkPromise;
      if (chunk.byteLength !== result.length) throw new Error(t("errors.downloadChunkLength"));
      if (!result.eof && result.length === 0) throw new Error(t("errors.downloadEmptyChunk"));
      if (chunks) {
        chunks.push(chunk);
        offset += chunk.byteLength;
        const task = transferTasks[info.taskId];
        if (task) {
          task.status = "running";
          task.transferred = offset;
        }
      } else if (fileTransfer && target) {
        const write = await fileTransfer.write(target.handleId, offset, chunk);
        offset = write.nextOffset;
      } else {
        // saveToLocal：字节已在 sidecar 侧写入暂存文件，这里只跟进进度。
        offset += chunk.byteLength;
        const task = transferTasks[info.taskId];
        if (task) {
          task.status = "running";
          task.transferred = offset;
        }
      }
      if (result.eof) break;
    }
    let localPath: string | undefined;
    if (target) {
      await fileTransfer!.finish(target.handleId);
      target = undefined;
    } else if (chunks) {
      saveBrowserDownload(chunks, info.fileName);
    }
    const finishResult = await window.dbxPlugin.invoke<{ localPath?: string }>("sftp/download/finish", { taskId: info.taskId });
    localPath = finishResult?.localPath;
    cancelledTransferTasks.delete(info.taskId);
    const task = transferTasks[info.taskId];
    if (task) {
      task.status = "completed";
      task.transferred = info.size;
      if (localPath) task.localPath = localPath;
    }
    // 完成闭环：本机落盘的下载给出「打开文件 / 打开目录」动作。
    if (localPath) {
      const savedPath = localPath;
      showNotice(t("downloadedTo", { name: info.fileName, path: savedPath }), [
        { label: t("openDownloadedFile"), run: () => void openTransferTarget(savedPath) },
        { label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) },
      ]);
    } else {
      showNotice(t("downloaded", { name: info.fileName }));
    }
    if (setDefaultAfter) applyChosenDirAsDefault(dirOverride);
  } catch (cause) {
    if (info) {
      const waiter = downloadChunkWaiters.get(info.taskId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        downloadChunkWaiters.delete(info.taskId);
      }
    }
    if (target && fileTransfer) await fileTransfer.cancel(target.handleId).catch(() => undefined);
    if (info) await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
    if (info && cancelledTransferTasks.delete(info.taskId)) {
      const task = transferTasks[info.taskId];
      if (task) task.status = "cancelled";
      showNotice(t("transferStatus.cancelled"));
    } else {
      // 失败闭环：横幅带「重试」，按原入口完整重跑（含询问/冲突流程）。
      showError(cause, "sftp", () => void downloadEntry(entry));
    }
  }
}

function saveBrowserDownload(chunks: Uint8Array[], fileName: string) {
  // Runtime chunks always come from decodeBase64 (ArrayBuffer-backed); the
  // ArrayBufferLike generic just doesn't fit BlobPart's stricter view typing.
  const blob = new Blob(chunks as unknown as BlobPart[]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to start the download before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function waitForDownloadChunk(taskId: string, offset: number) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      downloadChunkWaiters.delete(taskId);
      reject(new Error(t("errors.downloadChunkTimeout")));
    }, 30_000);
    downloadChunkWaiters.set(taskId, { offset, resolve, reject, timer });
  });
}

// 在文件管理器中定位本机落盘的下载（sidecar 校验过该路径确为本插件记录）。
async function revealTransferTarget(path: string) {
  try {
    await window.dbxPlugin.invoke("local/reveal", { path });
  } catch (cause) {
    showError(cause);
  }
}

// 在系统默认应用中打开已完成的下载；sidecar 会校验路径必须来自本插件
// 的完成历史，避免把这个按钮变成任意本机路径打开入口。
async function openTransferTarget(path: string) {
  try {
    await window.dbxPlugin.invoke("local/open", { path });
  } catch (cause) {
    showError(cause);
  }
}

// —— 断点续传：暂停/恢复 + 可续传上传 ———

// 分片循环在每个分片之间调用；暂停时挂起，恢复后继续。
function waitWhilePaused(taskId: string): Promise<void> | undefined {
  if (!pausedTaskIds.has(taskId)) return undefined;
  return new Promise((resolve) => {
    const waiters = pauseWaiters.get(taskId) ?? [];
    waiters.push(resolve);
    pauseWaiters.set(taskId, waiters);
  });
}

function releasePause(taskId: string) {
  if (pausedTaskIds.delete(taskId)) {
    for (const waiter of pauseWaiters.get(taskId) ?? []) waiter();
  }
  pauseWaiters.delete(taskId);
}

function toggleTransferPause(task: TransferTask) {
  if (!transferPausable(task.status)) return;
  if (pausedTaskIds.has(task.taskId)) releasePause(task.taskId);
  else pausedTaskIds.add(task.taskId);
}

async function cancelTransfer(task: TransferTask) {
  releasePause(task.taskId);
  if (task.direction === "download") {
    // Reject the pending chunk waiter so the download loop exits immediately
    // instead of waiting for its 30s timeout; the backend cancel follows below.
    const waiter = downloadChunkWaiters.get(task.taskId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      downloadChunkWaiters.delete(task.taskId);
      waiter.reject(new Error(t("transferStatus.cancelled")));
    }
    cancelledTransferTasks.add(task.taskId);
  }
  await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: task.taskId }).catch((cause) => showError(cause));
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) await worker(item);
    }
  }));
}

function onUploadInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (files.length) void uploadLocalFiles(files).catch(showError);
}

/**
 * Focus the SFTP workbench itself when the user clicks its blank area. This
 * gives Ctrl/Cmd+V a stable native paste target without stealing focus from
 * path/search inputs or toolbar controls.
 */
function focusSftpPaneOnPointerDown(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest("button, input, select, textarea, a, [contenteditable='true']")) return;
  sftpPane.value?.focus({ preventScroll: true });
}

/**
 * Native file paste is the browser-compatible bridge for Finder/Explorer
 * clipboard files. Text paste is deliberately left untouched so path/search
 * inputs and the remote SFTP clipboard keep their existing behavior.
 */
function onSftpClipboardPaste(event: ClipboardEvent) {
  if (!connected.value || !canWrite.value) return;
  const files = filesFromClipboard(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  void uploadLocalFiles(files).catch(showError);
}

function onDrop(event: DragEvent) {
  dragActive.value = false;
  if (!canWrite.value) return;
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) void uploadLocalFiles(files).catch(showError);
}

function onTerminalDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value })) return;
  terminalDragActive.value = true;
}

function onTerminalDrop(event: DragEvent) {
  terminalDragActive.value = false;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value })) return;
  // Files dropped on the terminal ask for a landing directory first: the
  // shell's cwd (SFTP directory tracking) or any absolute directory typed in
  // the prompt — silence would make a wrong-guess overwrite too easy.
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  void runTerminalDropUpload(files);
}

async function runTerminalDropUpload(files: File[]) {
  const choice = await askDropUploadTarget(files);
  terminal?.focus();
  if (choice === "cancel") return;
  try {
    await uploadLocalFiles(files, choice === "cwd" ? undefined : choice.dir);
  } catch (cause) {
    showError(cause);
  }
}

function askDropUploadTarget(files: File[]): Promise<"cancel" | "cwd" | { dir: string }> {
  dropUploadTarget.value = "cwd";
  dropUploadPathInput.value = "";
  return new Promise((resolve) => {
    dropUploadResolver = resolve;
    dropUploadPrompt.value = { files };
  });
}

// 选中“指定目录”即聚焦路径输入框（禁用态拿不到焦点，所以不在打开时聚焦）：
// 键盘流为拖入 → Tab/方向键切到自定义 → 直接输入 → Enter 提交。
watch(dropUploadTarget, async (target) => {
  if (target !== "custom") return;
  await nextTick();
  dropUploadPathInputEl.value?.focus();
});

function confirmDropUpload() {
  if (!dropUploadPrompt.value) return;
  if (dropUploadTarget.value === "custom") {
    const dir = normalizeDropTargetDir(dropUploadPathInput.value);
    if (!dir) return;
    resolveDropUpload({ dir });
    return;
  }
  resolveDropUpload("cwd");
}

function resolveDropUpload(choice: "cancel" | "cwd" | { dir: string }) {
  dropUploadPrompt.value = undefined;
  const resolve = dropUploadResolver;
  dropUploadResolver = undefined;
  resolve?.(choice);
}

// 沙箱 iframe 的剪贴板依赖注入：宿主桥是 optional 且现网宿主未提供，
// 缺失/拒绝时由 clipboardBridge 逐级降级（见 lib/clipboardBridge.ts）。
function clipboardDeps(): ClipboardDeps {
  return {
    bridge: window.dbxPlugin.clipboard ?? null,
    nativeClipboard: typeof navigator !== "undefined" ? (navigator as Navigator & { clipboard?: ClipboardDeps["nativeClipboard"] }).clipboard ?? null : null,
  };
}

async function copyTerminalSelection() {
  const text = terminal?.getSelection() || "";
  if (!text) return;
  try {
    await writeClipboardText(text, clipboardDeps());
    showNotice(t("terminalCopied"));
  } catch {
    showError(new Error(t("terminalCopyUnavailable")), "terminal");
  }
  terminalMenu.value = undefined;
  terminal?.focus();
}

async function pasteTerminal() {
  terminalMenu.value = undefined;
  try {
    const text = await readClipboardText(clipboardDeps());
    await sendConfirmedPaste(text || "");
  } catch {
    // 读剪贴板全链失败（宿主桥缺失 + 沙箱拒绝）：引导走原生 paste 快捷键。
    showError(new Error(t("terminalPasteUseShortcut")), "terminal");
    terminal?.focus();
  }
}

function interceptTerminalPaste(event: ClipboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  const text = event.clipboardData?.getData("text/plain") || "";
  if (!text) return;
  void sendConfirmedPaste(text);
}

async function sendConfirmedPaste(text: string) {
  if (!text) return;
  const accepted = await confirmRiskyPaste(text);
  if (!accepted) {
    terminal?.focus();
    return;
  }
  if (!session.value || terminalTransferBusy.value) return;
  trackPendingInput(text);
  sendTerminalBytes(new TextEncoder().encode(text));
  terminal?.focus();
}

function confirmRiskyPaste(text: string): Promise<boolean> {
  const confirmation = buildPasteConfirmation(text);
  if (!confirmation.required) return Promise.resolve(true);
  return new Promise((resolve) => {
    pasteConfirmResolver = resolve;
    pasteConfirm.value = confirmation;
  });
}

function resolvePasteConfirm(accepted: boolean) {
  pasteConfirm.value = undefined;
  const resolve = pasteConfirmResolver;
  pasteConfirmResolver = undefined;
  resolve?.(accepted);
}

function selectAllTerminal() {
  terminal?.selectAll();
  terminalMenu.value = undefined;
  terminal?.focus();
}

function clearTerminal() {
  terminal?.clear();
  terminalMenu.value = undefined;
  terminal?.focus();
}

function chooseZmodem() {
  terminalMenu.value = undefined;
  zmodemInput.value?.click();
}

function openCommandDialog() {
  commandOpen.value = true;
  commandError.value = "";
  commandHistoryIndex.value = -1;
  commandHistoryBackup.value = "";
}

function loadCommandHistory(): string[] {
  try {
    return sanitizeCommandHistory(JSON.parse(window.localStorage.getItem(COMMAND_HISTORY_KEY) || "null"));
  } catch {
    return [];
  }
}

function persistCommandHistory() {
  try {
    // 疑似内嵌凭据 / 超长 / 多行的命令只留在内存，不写 localStorage。
    window.localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory.value.filter(isPersistableCommand)));
  } catch {
    // localStorage 不可用时命令历史仅保留在内存中。
  }
}

// ↑↓ 在命令输入框中浏览历史；进入浏览态前备份当前草稿，回到最新一条之下时恢复。
function browseCommandHistoryUp() {
  commandHistoryBackup.value = commandHistoryIndex.value === -1 ? commandDraft.value : commandHistoryBackup.value;
  const step = browseCommandHistory(commandHistory.value, commandHistoryIndex.value, "up", commandHistoryBackup.value);
  commandHistoryIndex.value = step.index;
  commandDraft.value = step.draft;
}

function browseCommandHistoryDown() {
  const step = browseCommandHistory(commandHistory.value, commandHistoryIndex.value, "down", commandHistoryBackup.value);
  commandHistoryIndex.value = step.index;
  commandDraft.value = step.draft;
}

function handleCommandInputKeydown(event: KeyboardEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLTextAreaElement)) return;
  const action = commandInputAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    selectionStart: target.selectionStart,
    selectionEnd: target.selectionEnd,
    valueLength: target.value.length,
  });
  if (action === "run") {
    event.preventDefault();
    void runCommand();
  } else if (action === "history-up") {
    event.preventDefault();
    browseCommandHistoryUp();
  } else if (action === "history-down") {
    event.preventDefault();
    browseCommandHistoryDown();
  }
}

// 一键重发：把历史条目回填输入框并立即执行。
function rerunHistoryCommand(command: string) {
  if (commandRunning.value) return;
  commandDraft.value = command;
  commandHistoryIndex.value = -1;
  void runCommand();
}

function clearCommandHistory() {
  commandHistory.value = [];
  commandHistoryIndex.value = -1;
  persistCommandHistory();
}

async function runCommand() {
  const sessionId = session.value?.sessionId;
  const command = commandDraft.value.trim();
  if (!sessionId || !command || commandRunning.value) return;
  commandRunning.value = true;
  commandError.value = "";
  commandResult.value = undefined;
  const execId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `exec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  commandExecId.value = execId;
  try {
    commandResult.value = await window.dbxPlugin.invoke<ExecResult>("ssh/exec", {
      sessionId,
      execId,
      command,
      sudo: commandUseSudo.value,
    }, { timeoutMs: 120_000 });
    // 执行成功提交即入历史（不论退出码），与输入框 ↑↓、一键重发共用同一份。
    commandHistory.value = pushCommandHistory(commandHistory.value, command);
    persistCommandHistory();
    commandHistoryIndex.value = -1;
    commandHistoryBackup.value = "";
  } catch (cause) {
    commandError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    commandRunning.value = false;
    commandExecId.value = "";
  }
}

async function cancelCommand() {
  const execId = commandExecId.value;
  if (!execId || !commandRunning.value) return;
  await window.dbxPlugin.invoke("ssh/exec/cancel", { execId }).catch((cause) => showError(cause));
}

// ---------------------------------------------------------------------------
// 快速命令栏：全局存储（sidecar 数据目录）CRUD + PTY 一键发送
// ---------------------------------------------------------------------------

// localStorage 旧键仅作为一次性迁移种子：宿主 webview 存储按工作台分区，
// 旧数据表现为"和连接绑定"，迁移到 sidecar 后才真正全局共享。
function loadQuickCommands(): QuickCommand[] {
  try {
    return normalizeQuickCommands(JSON.parse(window.localStorage.getItem(QUICK_COMMANDS_KEY) || "null"));
  } catch {
    return [];
  }
}

// 挂载时从后端拉取全局清单；后端为空且本工作台有旧 localStorage 数据时一次性
// 迁移（逐条 save 后清除本地键）。后端不可用时保留本地/内存值兜底。
async function hydrateQuickCommands() {
  try {
    let response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/list");
    let commands = normalizeQuickCommands(response.commands);
    if (!commands.length) {
      const legacy = loadQuickCommands();
      for (const item of legacy) {
        await window.dbxPlugin.invoke("ssh/quickCommands/save", { id: "", name: item.name, command: item.command }).catch(() => undefined);
      }
      if (legacy.length) {
        response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/list");
        commands = normalizeQuickCommands(response.commands);
        try {
          window.localStorage.removeItem(QUICK_COMMANDS_KEY);
        } catch {
          // 清理失败只影响下次空跑迁移，不影响功能。
        }
      }
    }
    quickCommands.value = commands;
  } catch {
    // 后端不可用（如旧版 sidecar）：保留 localStorage/内存值，行为回到旧语义。
  }
}

async function addQuickCommand() {
  const command = quickDraft.command.trim();
  if (!command || quickSaving.value) return;
  if (!quickDraft.id && quickCommands.value.length >= 20) return;
  quickSaving.value = true;
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/save", {
      id: quickDraft.id ?? "",
      name: quickDraft.name.trim(),
      command,
    });
    quickCommands.value = normalizeQuickCommands(response.commands);
    closeQuickEditor();
  } catch (cause) {
    showError(cause, "terminal");
  } finally {
    quickSaving.value = false;
  }
}

// 点击卡片的编辑按钮：编辑器子视图载入草稿（携带 id 即更新语义）。
function editQuickCommand(item: QuickCommand) {
  openQuickEditor(item);
}

async function deleteQuickCommand(id: string) {
  const target = quickCommands.value.find((item) => item.id === id);
  // 删除是不可逆操作：先确认（与重命名覆盖/强杀进程同一 confirm 语义）。
  if (target && !window.confirm(t("quickCommandDeleteConfirm", { name: target.name || target.command }))) return;
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/delete", { id });
    quickCommands.value = normalizeQuickCommands(response.commands);
  } catch (cause) {
    showError(cause, "terminal");
  }
}

// 发送语义：快速命令是"在当前交互 shell 中执行"的片段（对齐 tiny-rdm），
// 必须走 PTY 写入——输出直接回显在终端里、cd/env 等状态留在当前 shell；
// ssh/exec 是独立非交互通道，不回显也不共享 shell 状态，不符合语义。
// 命令原文按键盘输入写入（用户可见可中断），不经过任何 shell 拼接转义。
// Run = 写入并回车执行；Paste = 只粘贴到命令行（不执行，可继续编辑）。
// 两种模式都不关弹窗（对齐 Termius：连续挑多条命令是高频操作，关窗会
// 打断流程）；手动 Esc/外点/再点工具栏按钮关闭。
function writeQuickCommand(item: QuickCommand, execute: boolean) {
  if (!session.value || terminalTransferBusy.value || commandRunning.value) return;
  const text = quickCommandText(item.command);
  if (!text) return;
  const payload = execute ? `${text}\r` : text;
  if (execute) trackPendingInput(payload);
  sendTerminalBytes(new TextEncoder().encode(payload));
  terminal?.focus();
}
function sendQuickCommand(item: QuickCommand) {
  writeQuickCommand(item, true);
}
function pasteQuickCommand(item: QuickCommand) {
  writeQuickCommand(item, false);
}

// 一键 sudo -v：向当前交互终端按键盘语义写入 `sudo -v` + 回车（等价手敲执行），
// 立即刷新远端 sudo 凭据缓存；输出回显在终端，密码提示由用户/Quick Sudo 应答。
function sendSudoRefresh() {
  if (!session.value || terminalTransferBusy.value) return;
  trackPendingInput("sudo -v\r");
  sendTerminalBytes(new TextEncoder().encode("sudo -v\r"));
  terminal?.focus();
}

// ---------------------------------------------------------------------------
// 批量发送：跨连接把命令写入多个已打开会话的交互终端（tiny-rdm batch send）
// ---------------------------------------------------------------------------

/** 命令条开关：持久化（localStorage），打开时顺带刷新目标列表。 */
function toggleBatchBar() {
  batchBarOpen.value = !batchBarOpen.value;
  try {
    window.localStorage.setItem(BATCH_BAR_OPEN_KEY, batchBarOpen.value ? "1" : "0");
  } catch {
    // 存储不可用时仅失去记忆，功能不受影响。
  }
  if (batchBarOpen.value) {
    void refreshBatchTargets();
  } else {
    batchTargetsOpen.value = false;
    batchSaveMode.value = false;
  }
  broadcastBatchBarState(true);
}

/** 本地命令条状态广播（输入去抖 150ms，开关/清空等离散动作立即发）。 */
function broadcastBatchBarState(immediate = false) {
  if (batchBroadcastTimer !== undefined) window.clearTimeout(batchBroadcastTimer);
  const send = () => {
    batchBroadcastTimer = undefined;
    void window.dbxPlugin
      .notify("ssh/batchBar/state", {
        source: batchBarSourceId,
        draft: batchDraft.value,
        quickPickId: batchQuickPickId.value,
        open: batchBarOpen.value,
      })
      .catch(() => undefined);
  };
  if (immediate) {
    send();
  } else {
    batchBroadcastTimer = window.setTimeout(send, 150);
  }
}

/** 应用其他工作台广播来的命令条状态（不含保存态/弹出层，不打断本端输入焦点）。 */
function applyRemoteBatchBarState(params: { draft?: unknown; quickPickId?: unknown; open?: unknown }) {
  if (typeof params.draft === "string") batchDraft.value = params.draft;
  if (typeof params.quickPickId === "string") batchQuickPickId.value = params.quickPickId;
  batchHistoryIndex.value = -1;
  if (typeof params.open === "boolean" && params.open !== batchBarOpen.value) {
    batchBarOpen.value = params.open;
    try {
      window.localStorage.setItem(BATCH_BAR_OPEN_KEY, batchBarOpen.value ? "1" : "0");
    } catch {
      // 同 toggleBatchBar：存储不可用只失去记忆。
    }
    if (params.open && !batchTargets.value.length) void refreshBatchTargets();
  }
}

async function refreshBatchTargets() {
  batchLoading.value = true;
  batchError.value = "";
  try {
    const response = await window.dbxPlugin.invoke<{ sessions: unknown }>("ssh/sessions/list");
    batchTargets.value = normalizeBatchTargets(response.sessions);
    // 剔除已关闭会话；选择为空时默认只预选当前会话（批量写入影响所有被选主机，宁缺毋滥）。
    const known = new Set(batchTargets.value.map((target) => target.sessionId));
    batchSelected.value = batchSelected.value.filter((id) => known.has(id));
    if (!batchSelected.value.length) {
      batchSelected.value = session.value?.sessionId && known.has(session.value.sessionId) ? [session.value.sessionId] : [];
    }
  } catch (cause) {
    batchTargets.value = [];
    batchSelected.value = [];
    batchError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    batchLoading.value = false;
  }
}

function toggleBatchTargetsPopover() {
  batchTargetsOpen.value = !batchTargetsOpen.value;
  if (batchTargetsOpen.value) void refreshBatchTargets();
}

function toggleBatchTargetId(sessionId: string) {
  batchSelected.value = toggleBatchTarget(batchSelected.value, sessionId);
}

function pickBatchTargets(mode: "all" | "connected") {
  batchSelected.value = selectBatchTargets(batchTargets.value, mode);
}

// 下拉切换命令：回填输入框（Electerm 语义），发送仍由回车/发送按钮触发。
function applyBatchQuickPick() {
  const command = quickPickCommandById(quickCommands.value, batchQuickPickId.value);
  if (command) {
    batchDraft.value = command;
    batchHistoryIndex.value = -1;
    broadcastBatchBarState(true);
  }
}

// 命令条 ↑↓ 浏览历史（与命令弹窗同一份 commandHistory，弹窗/命令条互相可见）。
function browseBatchHistoryUp() {
  batchHistoryBackup.value = batchHistoryIndex.value === -1 ? batchDraft.value : batchHistoryBackup.value;
  const step = browseCommandHistory(commandHistory.value, batchHistoryIndex.value, "up", batchHistoryBackup.value);
  batchHistoryIndex.value = step.index;
  batchDraft.value = step.draft;
}

function browseBatchHistoryDown() {
  const step = browseCommandHistory(commandHistory.value, batchHistoryIndex.value, "down", batchHistoryBackup.value);
  batchHistoryIndex.value = step.index;
  batchDraft.value = step.draft;
}

function batchSessionLabel(sessionId: string): string {
  const target = batchTargets.value.find((item) => item.sessionId === sessionId);
  return target ? batchTargetLabel(target) : sessionId.slice(0, 8);
}

async function sendBatchCommand() {
  const command = batchDraft.value.trim();
  if (!command || !batchSelected.value.length || batchSending.value) return;
  // 危险/超长命令复用粘贴红色确认弹窗（同一套 dangerousCommands 规则）。
  const confirmed = await confirmRiskyPaste(command);
  if (!confirmed) return;
  batchSending.value = true;
  batchError.value = "";
  batchSummary.value = undefined;
  try {
    const response = await window.dbxPlugin.invoke<{ results: unknown }>("ssh/terminal/batchInput", {
      sessionIds: batchSelected.value,
      command,
    });
    batchSummary.value = summarizeBatchResults(response.results);
    if (batchSummary.value.sent) {
      // 发送成功即清空输入与下拉选中（对齐原弹窗语义），命令入历史供 ↑↓ 回选。
      commandHistory.value = pushCommandHistory(commandHistory.value, command);
      persistCommandHistory();
      batchDraft.value = "";
      batchQuickPickId.value = "";
      batchHistoryIndex.value = -1;
      batchHistoryBackup.value = "";
      broadcastBatchBarState(true);
    }
  } catch (cause) {
    batchError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    batchSending.value = false;
  }
}

function dismissBatchResult() {
  batchSummary.value = undefined;
  batchError.value = "";
}

// ---- 命令条内联保存为快速命令（与工具栏 Zap 弹层同一后端，全局共享）----

function openBatchBarSave() {
  const command = batchDraft.value.trim();
  if (!command || quickCommands.value.length >= QUICK_COMMANDS_LIMIT) return;
  batchSaveMode.value = true;
  batchSaveName.value = deriveBatchCommandName(command);
}

async function confirmBatchBarSave() {
  const command = batchDraft.value.trim();
  if (!command || batchSaving.value || quickCommands.value.length >= QUICK_COMMANDS_LIMIT) return;
  batchSaving.value = true;
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/save", {
      id: "",
      name: batchSaveName.value.trim(),
      command,
    });
    quickCommands.value = normalizeQuickCommands(response.commands);
    batchSaveMode.value = false;
    batchSaveName.value = "";
    batchQuickPickId.value = quickCommands.value.find((item) => item.command === command)?.id ?? "";
  } catch (cause) {
    showError(cause, "terminal");
  } finally {
    batchSaving.value = false;
  }
}

function cancelBatchBarSave() {
  batchSaveMode.value = false;
  batchSaveName.value = "";
}

// 连接建立后刷新目标计数；断开时收起命令条的弹出层/保存态。
watch(connected, (value) => {
  if (value && batchBarOpen.value) {
    void refreshBatchTargets();
  } else if (!value) {
    batchTargetsOpen.value = false;
    batchSaveMode.value = false;
  }
  if (value) {
    void refreshAgentMode();
  } else {
    agentModeOpen.value = false;
  }
});

// ---------------------------------------------------------------------------
// 连接信息面板（只读）
// ---------------------------------------------------------------------------

function toggleQuickMenu() {
  const next = !quickMenuOpen.value;
  closeToolbarPopovers();
  quickMenuOpen.value = next;
  if (next) {
    // 每次打开回到列表态：清空搜索/展开/编辑器子视图。
    quickSearch.value = "";
    quickExpandedId.value = null;
    quickEditorOpen.value = false;
  }
}

function toggleConnectionInfo() {
  const next = !connectionInfoOpen.value;
  closeToolbarPopovers();
  connectionInfoOpen.value = next;
  if (next) {
    void measureLatency();
    void refreshConnectionAuthMethod();
    // 发行版徽标数据源是 metrics 快照：未拉过时补拉一次（一次 exec，约 0.4s），
    // 否则从未开过指标浮层的会话在连接信息里永远看不到徽标。
    if (!metrics.value) void refreshMetrics();
  }
}

function toggleAgentModeMenu() {
  const next = !agentModeOpen.value;
  closeToolbarPopovers();
  agentModeOpen.value = next;
  if (next) void refreshAgentMode();
}

// ---- 模板内联互斥清单收敛为具名 toggle（round2），与五个函数 toggle 同族 ----

function toggleColumnsMenu() {
  const next = !columnsOpen.value;
  closeToolbarPopovers();
  columnsOpen.value = next;
}

function toggleTransferPanel() {
  const next = !transferPanelOpen.value;
  closeToolbarPopovers();
  transferPanelOpen.value = next;
}

function togglePathHistoryMenu() {
  const next = !pathHistoryOpen.value;
  closeToolbarPopovers();
  pathHistoryOpen.value = next;
}

/// 读取当前连接的 agentTerminalMode（与设置弹窗同一 ssh/settings/get 视图）；
/// 失败保留上次已知值，仅影响按钮态不影响终端。
async function refreshAgentMode() {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  try {
    const meta = await window.dbxPlugin.invoke<{ agentTerminalMode?: string }>("ssh/settings/get", { sessionId });
    const mode = meta.agentTerminalMode;
    agentMode.value = mode && (AGENT_MODES as readonly string[]).includes(mode) ? (mode as AgentTerminalMode) : "off";
  } catch {
    // 静默降级：读不到就保持现状（默认 off），不打断终端使用。
  }
}

/// 切换即生效（ssh/settings/set），成功后本地同步并收起弹出层。
async function applyAgentMode(mode: AgentTerminalMode) {
  const sessionId = session.value?.sessionId;
  if (!sessionId || agentModeBusy.value) return;
  agentModeBusy.value = true;
  try {
    await window.dbxPlugin.invoke("ssh/settings/set", { sessionId, agentTerminalMode: mode });
    agentMode.value = mode;
    agentModeOpen.value = false;
  } catch (cause) {
    showError(cause, "terminal");
  } finally {
    agentModeBusy.value = false;
  }
}

// 认证方式：读取 ssh/sessions/list 当前会话行的 authMethod（只读方法名，
// 不含任何凭据材料）。失败时面板显示占位符，不影响其他信息。
async function refreshConnectionAuthMethod() {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  try {
    const result = await window.dbxPlugin.invoke<{ sessions: Array<{ sessionId?: string; authMethod?: string; readOnly?: boolean }> }>(
      "ssh/sessions/list",
      {},
      { timeoutMs: 15_000 },
    );
    const mine = result.sessions?.find((row) => row.sessionId === sessionId);
    connectionAuthMethod.value = typeof mine?.authMethod === "string" && mine.authMethod ? mine.authMethod : "";
    connectionReadOnly.value = mine?.readOnly === true;
  } catch {
    connectionAuthMethod.value = "";
  }
}

// 延迟测量：复用既有 ssh/exec 跑一条 echo 只读命令，计时整个 RPC 往返
// （含通道建立），无需新增后端方法。测量值仅用于展示，不参与任何逻辑。
async function measureLatency() {
  const sessionId = session.value?.sessionId;
  if (!sessionId || connectionLatencyBusy.value) return;
  connectionLatencyBusy.value = true;
  connectionLatencyFailed.value = false;
  const startedAt = performance.now();
  try {
    const result = await window.dbxPlugin.invoke<ExecResult>("ssh/exec", {
      sessionId,
      command: "echo dbx-rtt-probe",
      timeoutSecs: 8,
    }, { timeoutMs: 15_000 });
    if (!result.output.includes("dbx-rtt-probe")) throw new Error(t("errors.probeOutput"));
    connectionLatency.value = performance.now() - startedAt;
  } catch {
    connectionLatency.value = null;
    connectionLatencyFailed.value = true;
  } finally {
    connectionLatencyBusy.value = false;
  }
}

let metricsTimer = 0;

async function refreshMetrics() {
  if (!session.value) return;
  metricsLoading.value = true;
  try {
    metrics.value = await window.dbxPlugin.invoke<ServerMetrics>("ssh/metrics", { sessionId: session.value.sessionId }, { timeoutMs: 30_000 });
    metricsError.value = "";
    recordMetricSamples();
  } catch (cause) {
    metricsError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    metricsLoading.value = false;
  }
}

// 悬浮指标卡：打开即刷新并启动 5s 轮询；不阻塞终端/SFTP 操作，随时开关。
function toggleMetrics() {
  if (metricsOpen.value) {
    closeMetrics();
    return;
  }
  metricsOpen.value = true;
  void backfillMetricsHistory();
  void refreshMetrics();
  window.clearInterval(metricsTimer);
  metricsTimer = window.setInterval(() => {
    if (metricsOpen.value && !metricsLoading.value) void refreshMetrics();
  }, 5000);
}

function closeMetrics() {
  metricsOpen.value = false;
  window.clearInterval(metricsTimer);
}

// Peak rate across every interface normalizes the per-interface bars; the
// network/process sections only render when the sidecar reports the fields,
// so older backends simply hide them.
const metricsRatePeak = computed(() => {
  let peak = 0;
  for (const net of metrics.value?.network ?? []) peak = Math.max(peak, net.rxRate, net.txRate);
  return peak > 0 ? peak : 1;
});

function networkRateShare(net: { rxRate: number; txRate: number }) {
  return Math.min(100, Math.round((Math.max(net.rxRate, net.txRate) / metricsRatePeak.value) * 100));
}

const metricsProcGridStyle = { gridTemplateColumns: "48px 64px 48px 52px minmax(0, 1fr)" };
const procGridStyle = { gridTemplateColumns: "48px 60px 48px 52px 76px minmax(0, 1fr) 132px" };

// —— F2：指标历史回填 + 进程管理 ———

// 打开指标卡时拉一次落盘历史（connectionId 维度，跨重启可见趋势）；
// 旧 sidecar 无该方法时静默降级。
async function backfillMetricsHistory() {
  if (!session.value) return;
  try {
    const result = await window.dbxPlugin.invoke<{ samples: Array<{ cpuPercent?: number; memoryPercent?: number; rxRate?: number; txRate?: number }> }>("ssh/metrics/history", { sessionId: session.value.sessionId, limit: METRICS_SAMPLE_CAPACITY });
    for (const sample of result.samples ?? []) {
      if (sample.cpuPercent != null) metricSamples.cpu = pushSample(metricSamples.cpu, sample.cpuPercent, METRICS_SAMPLE_CAPACITY);
      if (sample.memoryPercent != null) metricSamples.mem = pushSample(metricSamples.mem, sample.memoryPercent, METRICS_SAMPLE_CAPACITY);
      metricSamples.rx = pushSample(metricSamples.rx, Math.max(0, sample.rxRate ?? 0), METRICS_SAMPLE_CAPACITY);
      metricSamples.tx = pushSample(metricSamples.tx, Math.max(0, sample.txRate ?? 0), METRICS_SAMPLE_CAPACITY);
    }
  } catch {
    // optional 降级：无历史则趋势从本次打开开始累计。
  }
}

async function toggleProcessPanel() {
  processesOpen.value = !processesOpen.value;
  if (processesOpen.value) await refreshProcessList();
}

async function refreshProcessList() {
  if (!session.value) return;
  processLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ processes: ProcessRow[] }>("ssh/processes/list", { sessionId: session.value.sessionId }, { timeoutMs: 20_000 });
    processRows.value = result.processes ?? [];
  } catch (cause) {
    showError(cause);
  } finally {
    processLoading.value = false;
  }
}

const sortedProcessRows = computed(() => sortProcessRows(processRows.value, processSortKey.value));
const PROCESS_VISIBLE_LIMIT = 100;
const visibleProcessRows = computed(() => sortedProcessRows.value.slice(0, PROCESS_VISIBLE_LIMIT));

async function killProcessRow(row: ProcessRow, signal: 15 | 9) {
  if (!session.value || !canKillProcess(row.pid)) return;
  const confirmKey = signal === 9 ? "procKillForceConfirm" : "procKillConfirm";
  if (!window.confirm(t(confirmKey, { pid: row.pid, command: row.command }))) return;
  try {
    await window.dbxPlugin.invoke("ssh/processes/kill", { sessionId: session.value.sessionId, pid: row.pid, signal });
    showNotice(t("procKilled", { pid: row.pid }));
    await refreshProcessList();
  } catch (cause) {
    showError(cause);
  }
}

// —— F3：终端录制 + 回放（asciicast v2）———

// 录制开始倒计时（录制软件惯例）：点击后 3→2→1 动画，归零才真正
// recording/start；Esc/点击遮罩取消。录制中工具栏按钮变红，终端区底部
// 浮出控制条（呼吸点 + 时长 + 停止）。
const recordCountdown = ref<number | null>(null);
const recordingStartedAt = ref<number | null>(null);
const recordingElapsedSec = ref(0);
let recordCountdownTimer = 0;
let recordingElapsedTimer = 0;

function beginRecordCountdown() {
  if (!session.value || recordCountdown.value !== null) return;
  recordCountdown.value = RECORD_COUNTDOWN_START;
  window.clearInterval(recordCountdownTimer);
  recordCountdownTimer = window.setInterval(() => {
    const next = nextCountdownValue(recordCountdown.value);
    recordCountdown.value = next;
    if (next === null) {
      window.clearInterval(recordCountdownTimer);
      void startRecordingNow();
    }
  }, 1000);
}

function cancelRecordCountdown() {
  window.clearInterval(recordCountdownTimer);
  recordCountdown.value = null;
}

function startRecordingClock() {
  recordingStartedAt.value = Date.now();
  recordingElapsedSec.value = 0;
  window.clearInterval(recordingElapsedTimer);
  recordingElapsedTimer = window.setInterval(() => {
    recordingElapsedSec.value = recordingStartedAt.value
      ? Math.floor((Date.now() - recordingStartedAt.value) / 1000)
      : 0;
  }, 1000);
}

function stopRecordingClock() {
  window.clearInterval(recordingElapsedTimer);
  recordingStartedAt.value = null;
  recordingElapsedSec.value = 0;
}

async function startRecordingNow() {
  if (!session.value || recordingActive.value) return;
  try {
    await window.dbxPlugin.invoke("ssh/recording/start", { sessionId: session.value.sessionId });
    recordingActive.value = true;
    startRecordingClock();
    showNotice(t("recordingStarted"));
  } catch (cause) {
    showError(cause);
  }
}

async function toggleRecording() {
  if (!session.value) return;
  if (!recordingActive.value) {
    beginRecordCountdown();
    return;
  }
  try {
    await window.dbxPlugin.invoke("ssh/recording/stop", { sessionId: session.value.sessionId });
    recordingActive.value = false;
    stopRecordingClock();
    showNotice(t("recordingStopped"));
    if (recordingsOpen.value) await loadRecordings();
  } catch (cause) {
    showError(cause);
  }
}

async function loadRecordings() {
  recordingsLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ recordings: RecordingSummary[] }>("ssh/recording/list", {});
    recordings.value = result.recordings ?? [];
  } catch {
    recordings.value = [];
  } finally {
    recordingsLoading.value = false;
  }
}

function toggleRecordings() {
  recordingsOpen.value = !recordingsOpen.value;
  if (recordingsOpen.value) {
    void probeLocalCapabilities();
    void loadRecordings();
  }
}

// 打开录制文件所在目录：仅在桌面端（sidecar 在本机）有意义，
// web/docker 的录制文件在远端服务器上。
async function revealRecording(item: RecordingSummary) {
  try {
    await window.dbxPlugin.invoke("ssh/recording/reveal", { recordingId: item.recordingId });
  } catch (cause) {
    showError(cause);
  }
}

function deleteRecording(item: RecordingSummary) {
  recordingDeleteTarget.value = item;
}

async function confirmRecordingDelete() {
  const item = recordingDeleteTarget.value;
  if (!item || recordingDeleteSubmitting.value) return;
  recordingDeleteSubmitting.value = true;
  try {
    await window.dbxPlugin.invoke("ssh/recording/delete", { recordingId: item.recordingId });
    recordingDeleteTarget.value = null;
    await loadRecordings();
  } catch (cause) {
    showError(cause);
  } finally {
    recordingDeleteSubmitting.value = false;
  }
}

// 一键清空：应用内确认弹窗（沙箱 iframe confirm 恒 false），确认后
// ssh/recording/clear 全删 .cast，重载列表并提示删除数量。
const recordingClearAllOpen = ref(false);
const recordingClearAllSubmitting = ref(false);

async function confirmRecordingClearAll() {
  if (recordingClearAllSubmitting.value) return;
  recordingClearAllSubmitting.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ deleted?: number }>("ssh/recording/clear", {});
    recordingClearAllOpen.value = false;
    await loadRecordings();
    showNotice(t("recordingsCleared", { count: result.deleted ?? 0 }));
  } catch (cause) {
    showError(cause);
  } finally {
    recordingClearAllSubmitting.value = false;
  }
}

// 回放：事件一次性拉全（分页合并，封顶 2 万事件），rAF 按时间轴推进。
const REPLAY_EVENT_CAP = 20000;
let replayTerminal: Terminal | null = null;
let replayTimeline: number[] = [];
let replayWriteIndex = 0;
let replayRaf = 0;
let replayStartWall = 0;
let replayStartPlayhead = 0;
const replayDurationMs = computed(() => (replayState.value ? replayDuration(replayState.value.events) * 1000 : 0));

async function loadReplayEvents(recordingId: string): Promise<ReplayEvent[]> {
  const pages: ReplayEventPage[] = [];
  let offset = 0;
  for (;;) {
    const page = await window.dbxPlugin.invoke<ReplayEventPage>("ssh/recording/get", { recordingId, offset, limit: 500 });
    pages.push(page);
    offset += page.events.length;
    if (!page.hasMore || offset >= page.total || offset >= REPLAY_EVENT_CAP) break;
  }
  return mergeEventPages(pages);
}

async function openReplay(item: RecordingSummary) {
  try {
    const events = await loadReplayEvents(item.recordingId);
    closeReplay();
    replayState.value = { summary: item, events };
    replayTimeline = buildTimeline(events, 1);
    replayWriteIndex = 0;
    replayPlayheadMs.value = 0;
    replayPlaying.value = false;
    await nextTick();
    if (replayHost.value) {
      // 回放终端跟随宿主外观（主题色/字体/字号），不再是默认纯黑 xterm。
      replayTerminal = new Terminal({
        cols: 100,
        rows: 26,
        convertEol: false,
        theme: terminalTheme(),
        fontFamily: appearance.value.terminal.fontFamily,
        fontSize: appearance.value.terminal.fontSize,
      });
      replayTerminal.open(replayHost.value);
    }
  } catch (cause) {
    showError(cause);
  }
}

function closeReplay() {
  cancelAnimationFrame(replayRaf);
  replayPlaying.value = false;
  replayTerminal?.dispose();
  replayTerminal = null;
  replayState.value = null;
}

function stopReplayLoop() {
  cancelAnimationFrame(replayRaf);
  replayPlaying.value = false;
}

function replayFrame() {
  const state = replayState.value;
  if (!state || !replayPlaying.value) return;
  const elapsed = (performance.now() - replayStartWall) * replaySpeed.value;
  replayPlayheadMs.value = Math.min(replayDurationMs.value, replayStartPlayhead + elapsed);
  const target = eventIndexAtTime(replayTimeline, replayPlayheadMs.value);
  while (replayWriteIndex < target) {
    replayTerminal?.write(state.events[replayWriteIndex]!.data);
    replayWriteIndex += 1;
  }
  if (replayPlayheadMs.value >= replayDurationMs.value) {
    stopReplayLoop();
    return;
  }
  replayRaf = requestAnimationFrame(replayFrame);
}

function toggleReplayPlay() {
  if (!replayState.value) return;
  if (replayPlaying.value) {
    stopReplayLoop();
    return;
  }
  replayStartWall = performance.now();
  replayStartPlayhead = replayPlayheadMs.value;
  replayPlaying.value = true;
  replayRaf = requestAnimationFrame(replayFrame);
}

function onReplaySeek(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || !replayState.value) return;
  cancelAnimationFrame(replayRaf);
  replayPlaying.value = false;
  replayPlayheadMs.value = value;
  replayStartPlayhead = value;
  replayStartWall = performance.now();
  replayWriteIndex = eventIndexAtTime(replayTimeline, value);
  replayTerminal?.reset();
  for (let index = 0; index < replayWriteIndex; index += 1) {
    replayTerminal?.write(replayState.value.events[index]!.data);
  }
}

// GIF 导出管线：离屏 xterm 逐事件重放，按 500ms 事件时间抽帧（封顶 120 帧），
// 每帧从 xterm 画布取像素 → encodeGif。纯前端，无新依赖。回放弹窗与录制
// 列表行内按钮共用；调用方负责 replayExporting 状态与错误呈现。
async function exportRecordingGif(summary: RecordingSummary, events: readonly ReplayEvent[]) {
  const COLS = 80;
  const ROWS = 24;
  const FRAME_INTERVAL_MS = 500;
  const MAX_FRAMES = 120;
  const fileName = `${summary.recordingId || "session"}.gif`;
  // Open the native save picker before the first await so browsers that require
  // a user gesture keep the permission to choose both directory and filename.
  // DBX hosts without File System Access continue through fileTransfer below.
  let nativeSave: DbxGifSaveFileHandle | undefined;
  if (window.showSaveFilePicker) {
    try {
      nativeSave = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: "GIF image", accept: { "image/gif": [".gif"] } }],
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      throw cause;
    }
  }
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;";
  document.body.appendChild(host);
  let term: Terminal | null = null;
  try {
    term = new Terminal({ cols: COLS, rows: ROWS });
    term.open(host);
    // xterm 默认 DOM 渲染器不产生 canvas，逐帧取像素必须挂 WebGL renderer
    // （addon 内部 preserveDrawingBuffer，drawImage 出来的帧才稳定）。渲染器
    // 随终端 dispose，不长期占用浏览器有限的 WebGL context；WebGL 不可用
    // （GPU 被禁/context 耗尽）时回退 Canvas 渲染器（同样产出真实 canvas），
    // 两者都挂不上才走 !screen 分支给出明确错误，而不是永远空帧。
    const webgl = attachWebglRenderer(term, () => new WebglAddon());
    if (!webgl) {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        // 最终由下方 !screen 分支报 replayExportFailed。
      }
    }
    const screen = host.querySelector("canvas") as HTMLCanvasElement | null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!screen || !context) throw new Error(t("replayExportFailed"));
    canvas.width = screen.width;
    canvas.height = screen.height;
    const timeline = buildTimeline(events, 1);
    const plan = gifFramePlan(timeline, FRAME_INTERVAL_MS, MAX_FRAMES);
    const frames: Array<{ rgba: Uint8Array; delayMs: number }> = [];
    let written = 0;
    for (const boundary of plan) {
      while (written < boundary) {
        term.write(events[written]!.data);
        written += 1;
      }
      // 等两帧渲染再取像素：正常窗口双 rAF 精确等待；标签页被隐藏等场景
      // rAF 永不回调，用 250ms 定时兜底，导出流程永不悬挂在 Encoding…。
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        requestAnimationFrame(() => requestAnimationFrame(settle));
        window.setTimeout(settle, 250);
      });
      context.drawImage(screen, 0, 0);
      frames.push({ rgba: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data), delayMs: FRAME_INTERVAL_MS });
    }
    term.dispose();
    term = null;
    const gif = encodeGif(canvas.width, canvas.height, frames);
    if (nativeSave) {
      const writable = await nativeSave.createWritable();
      await writable.write(gif);
      await writable.close();
    } else if (window.dbxPlugin.fileTransfer) {
      // DBX hosts own the native save dialog here, so the user can choose the
      // destination instead of silently losing the file in an unknown folder.
      const fileTransfer = window.dbxPlugin.fileTransfer;
      const target = await fileTransfer.beginSave({ name: fileName, contentType: "image/gif", size: gif.byteLength });
      try {
        await fileTransfer.write(target.handleId, 0, gif);
        await fileTransfer.finish(target.handleId);
      } catch (cause) {
        await fileTransfer.cancel(target.handleId).catch(() => undefined);
        throw cause;
      }
      showNotice(t("replayExported"));
    } else {
      // 沙箱 iframe（宿主 fileTransfer 缺失）下的可靠路径：sidecar 落盘到
      // 下载目录（或「每次询问」选择的目录），完成后提示完整路径。
      // web/docker（sidecar 不在本机）仍回退浏览器 <a download>。
      const local = await probeLocalCapabilities();
      if (!local?.canSaveLocal) {
        saveBrowserDownload([gif], fileName);
        showNotice(t("replayExported"));
        return;
      }
      let targetDir = "";
      let setDefaultAfter = false;
      if (!loadDownloadUseDefaultDir()) {
        const chosen = await askDownloadTarget(fileName);
        if (chosen === undefined) return;
        targetDir = chosen.dir.trim();
        setDefaultAfter = chosen.setDefault;
      }
      const conflict = await resolveDownloadConflictFor(targetDir, fileName);
      if (conflict === undefined) return;
      const saved = await window.dbxPlugin.invoke<{ localPath: string; name: string }>("local/saveFile", {
        name: fileName,
        dataBase64: window.dbxPlugin.encodeBase64(gif),
        targetDir: targetDir || loadDownloadDir() || undefined,
        conflict: conflict === "overwrite" ? "overwrite" : undefined,
      });
      const savedPath = saved.localPath;
      showNotice(t("downloadedTo", { name: saved.name, path: savedPath }), [
        { label: t("openDownloadedFile"), run: () => void openTransferTarget(savedPath) },
        { label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) },
      ]);
      if (setDefaultAfter) applyChosenDirAsDefault(targetDir);
      return;
    }
    showNotice(t("replayExported"));
  } finally {
    term?.dispose();
    host.remove();
  }
}

async function exportReplayGif() {
  const state = replayState.value;
  if (!state || replayExporting.value || !state.events.length) return;
  replayExporting.value = true;
  try {
    await exportRecordingGif(state.summary, state.events);
  } catch (cause) {
    showError(cause);
  } finally {
    replayExporting.value = false;
  }
}

// 列表行内导出：按需拉取事件（回放窗不必先打开），再走同一导出管线。
async function exportRecordingFromList(item: RecordingSummary) {
  if (replayExporting.value) return;
  replayExporting.value = true;
  recordingExportingId.value = item.recordingId;
  try {
    const events = await loadReplayEvents(item.recordingId);
    if (!events.length) throw new Error(t("replayExportFailed"));
    await exportRecordingGif(item, events);
  } catch (cause) {
    showError(cause);
  } finally {
    recordingExportingId.value = null;
    replayExporting.value = false;
  }
}

function formatDuration(secs: number) {
  const total = Math.max(0, Math.round(secs));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function formatRecordedAt(startedAt?: number) {
  if (!startedAt) return "";
  return new Date(startedAt * 1000).toLocaleString();
}

onBeforeUnmount(() => {
  cancelAnimationFrame(replayRaf);
  replayTerminal?.dispose();
  replayTerminal = null;
});

async function refreshDiskUsage() {
  if (!session.value) return;
  diskUsage.value = await window.dbxPlugin
    .invoke<DiskUsage>("sftp/diskUsage", { sessionId: session.value.sessionId, path: currentPath.value }, { timeoutMs: 30_000 })
    .catch(() => undefined);
}

// 权限矩阵（所有者/属组/其他人 × 读/写/执行）与八进制草稿双向换算：
// 草稿非法或为空时以 0 为基准，setuid/setgid/sticky 高位原样保留。
const PERM_ROLES = [
  { who: 6, key: "permOwner" },
  { who: 3, key: "permGroup" },
  { who: 0, key: "permOthers" },
] as const;
const PERM_COLUMNS = [
  { bit: 4, key: "permRead" },
  { bit: 2, key: "permWrite" },
  { bit: 1, key: "permExec" },
] as const;

function draftModeBits(raw: string): number {
  const text = raw.trim();
  return /^[0-7]{3,4}$/.test(text) ? parseInt(text, 8) : 0;
}

function permBit(raw: string, who: number, bit: number): boolean {
  return Boolean(draftModeBits(raw) & (bit << who));
}

function applyPermBit(raw: string, who: number, bit: number, on: boolean): string {
  const bits = draftModeBits(raw);
  const mode = on ? bits | (bit << who) : bits & ~(bit << who);
  return `0${mode.toString(8)}`;
}

function toggleChmodPerm(who: number, bit: number, event: Event) {
  const input = event.target;
  if (input instanceof HTMLInputElement) chmodDraft.value = applyPermBit(chmodDraft.value, who, bit, input.checked);
}

function toggleAttrsPerm(who: number, bit: number, event: Event) {
  const input = event.target;
  if (input instanceof HTMLInputElement) attrsMode.value = applyPermBit(attrsMode.value, who, bit, input.checked);
}

function beginChmod(entry: SftpEntry) {
  if (!canWrite.value) return;
  chmodTarget.value = entry;
  chmodDraft.value = entry.permissions || "";
  fileMenu.value = undefined;
}

async function openSettings() {
  settingsOpen.value = true;
  await hydrateDownloadPrefs();
  downloadDirDraft.value = loadDownloadDir();
  downloadUseDefaultDraft.value = loadDownloadUseDefaultDir();
  downloadConflictDraft.value = loadDownloadConflictPolicy();
  void probeLocalCapabilities();
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
  try {
    // revealSecrets: 预填已存原值（原始凭据串），避免只能看到"已配置"占位。
    const meta = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/get", { sessionId: session.value?.sessionId, revealSecrets: true });
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

function openProfilesManager() {
  profilesOpen.value = true;
  profileEditing.value = false;
  resetProfileDraft();
  void loadSudoProfiles();
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
    showNotice(t("profilesSaved"));
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
    showNotice(t("profilesDeleted"));
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
  if (!settingsOpen.value || !session.value) return;
  try {
    settingsMeta.value = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/get", { sessionId: session.value.sessionId });
  } catch {
    // 摘要刷新失败不打断主流程；重新打开设置时会再次加载。
  }
}

function settingsErrorOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
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
    showNotice(t("knownHosts.removed", { host: `${entry.host}:${entry.port}` }));
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

function mibField(bytes?: number) {
  return typeof bytes === "number" && bytes > 0 ? String(Math.round(bytes / MIB)) : "";
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
    showNotice(t("mcpLimits.saved"));
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
  if (!session.value || settingsSaving.value || settingsLoading.value || settingsLoadFailed.value || !settingsMeta.value) return;
  settingsSaving.value = true;
  try {
    persistDownloadDir(downloadDirDraft.value);
    persistDownloadUseDefaultDir(downloadUseDefaultDraft.value);
    persistDownloadConflictPolicy(downloadConflictDraft.value);
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
    const meta = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/set", { sessionId: session.value.sessionId, ...updates });
    settingsMeta.value = meta;
    settingsDraft.sudoPassword = "";
    settingsDraft.totpSecret = "";
    await saveMcpSettings();
    showNotice(t("settingsSaved"));
  } catch (cause) {
    showError(cause);
  } finally {
    settingsSaving.value = false;
  }
}

async function clearStoredSecrets() {
  if (!session.value || settingsSaving.value || settingsLoading.value || settingsLoadFailed.value || !settingsMeta.value) return;
  try {
    const meta = await window.dbxPlugin.invoke<SshSettings>("ssh/settings/set", {
      sessionId: session.value.sessionId,
      sudoPassword: "",
      totpSecret: "",
    });
    settingsMeta.value = meta;
    showNotice(t("settingsSecretsCleared"));
  } catch (cause) {
    showError(cause);
  }
}

async function confirmChmod() {
  const entry = chmodTarget.value;
  const mode = chmodDraft.value.trim();
  if (!session.value || !entry || !mode) return;
  chmodSubmitting.value = true;
  try {
    if (sudoMode.value) {
      await window.dbxPlugin.invoke("sudo/chmod", {
        sessionId: session.value.sessionId,
        path: pathFromUri(entry.uri),
        mode,
      });
    } else {
      await window.dbxPlugin.invoke("sftp/chmod", {
        sessionId: session.value.sessionId,
        path: pathFromUri(entry.uri),
        mode,
      });
    }
    chmodTarget.value = undefined;
    await loadDirectory();
    showNotice(t("permissionsUpdated"));
  } catch (cause) {
    showError(cause);
  } finally {
    chmodSubmitting.value = false;
  }
}

function onZmodemInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || !connected.value) return;
  pendingZmodemFiles = files;
  zmodemState.value = "waiting";
  zmodemFileName.value = files[0]?.name || "";
  zmodemTransferred.value = 0;
  zmodemTotalSize.value = files.reduce((sum, file) => sum + file.size, 0);
  resetZmodemSentry();
  sendTerminalBytes(new TextEncoder().encode("rz\r"));
  zmodemDetectionTimer = window.setTimeout(() => finishZmodemUpload(new Error(t("zmodemNotAvailable"))), ZMODEM_DETECTION_TIMEOUT_MS);
}

function showTerminalMenu(event: MouseEvent) {
  event.preventDefault();
  // 选中复制模式下右键直接粘贴；Shift+右键（或关闭该模式）保留完整菜单。
  if (resolveTerminalRightClickAction({ selectCopy: termSelectCopy.value, shiftKey: event.shiftKey }) === "paste") {
    terminalMenu.value = undefined;
    fileMenu.value = undefined;
    void pasteTerminal();
    return;
  }
  terminalMenu.value = { x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 250) };
  fileMenu.value = undefined;
}

function showFileMenu(event: MouseEvent, entry: SftpEntry) {
  event.preventDefault();
  // .stop 防止冒泡到文件列表容器的空白右键菜单（空白菜单会覆盖行菜单的回归）。
  event.stopPropagation();
  selectedPath.value = entry.uri;
  fileMenu.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 290),
    entry,
    selection: [...selectedUris.value],
  };
  terminalMenu.value = undefined;
  blankMenu.value = undefined;
  sideMenu.value = undefined;
  transferHistoryMenu.value = undefined;
}

function showTransferHistoryMenu(event: MouseEvent, entry: TransferHistoryEntry) {
  event.preventDefault();
  event.stopPropagation();
  // 浏览器下载、上传及旧记录都可能没有可验证的本机路径：拦截系统菜单，
  // 但不展示无效操作。
  if (!entry.localPath) {
    transferHistoryMenu.value = undefined;
    return;
  }
  transferHistoryMenu.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 100),
    path: entry.localPath,
  };
  terminalMenu.value = undefined;
  fileMenu.value = undefined;
  blankMenu.value = undefined;
  sideMenu.value = undefined;
}

/**
 * 工具栏弹出层互斥族统一收口（round2：收敛五处 + 三处模板内联的手抄互斥清单）。
 * 打开任一同族弹出层前调用，先关掉全部兄弟弹出层与右键菜单，再由各 toggle
 * 设定自身状态。族成员 = 模板 class="popover" 的九个弹出层（quick-commands /
 * agent-mode / highlight-rules / connection-info / columns / transfer /
 * batch-targets / bookmark-save / path-history）。语义差异说明：metrics 浮层
 * （.metrics-float，closeMetrics 自带轮询清理）与批量保存态（batchSaveMode，
 * cancelBatchBarSave 带草稿清理）不属于本族，仍由 Esc 链单独收口；
 * batch-targets 弹层另有 mousedown-capture 点空白收起，此处再关一次幂等无害。
 */
function closeToolbarPopovers() {
  fileMenu.value = undefined;
  terminalMenu.value = undefined;
  transferHistoryMenu.value = undefined;
  transferPanelOpen.value = false;
  columnsOpen.value = false;
  pathHistoryOpen.value = false;
  quickMenuOpen.value = false;
  connectionInfoOpen.value = false;
  agentModeOpen.value = false;
  highlightMenuOpen.value = false;
  bookmarkSaveOpen.value = false;
  batchTargetsOpen.value = false;
}

function closeMenus() {
  terminalMenu.value = undefined;
  fileMenu.value = undefined;
  blankMenu.value = undefined;
  sideMenu.value = undefined;
  transferHistoryMenu.value = undefined;
  closeToolbarPopovers();
}

/** 多选批量：复制所选路径（换行拼接写入剪贴板）。 */
function copySelectedPaths() {
  const menu = fileMenu.value;
  fileMenu.value = undefined;
  if (!menu) return;
  const uris = menu.selection.length ? menu.selection : [menu.entry.uri];
  copyTextToClipboard(uris.map((uri) => pathFromUri(uri)).join("\n"), "sftpCopy.copiedPaths", { count: uris.length });
}

/**
 * 弹层焦点管理（P1-2）：打开时焦点进入弹层首控件、Tab 圈定在弹层内、
 * 关闭后归还触发元素。原生 autofocus 在 Vue 动态插入时不生效，改为
 * 显式驱动；决策逻辑走 modalFocus 纯函数（有单测），Esc 关闭链沿用
 * 下方 onDocumentKeydown 的分层退出。
 */
// 触发元素栈：与弹层嵌套深度同步 push/pop。右键菜单项这类"打开弹层后自身
// 随菜单卸载"的触发元素无法承接归还焦点，逐层弹出时跳过已断连元素。
const modalTriggerStack: HTMLElement[] = [];
// 弹层外最近聚焦的稳定元素：右键菜单项属瞬态控件（点击打开弹层后随菜单
// 卸载，无法承接归还焦点），归还目标回退到菜单打开前的焦点宿主；
// 弹层内聚焦不覆盖该记录。
let lastStableFocus: HTMLElement | null = null;
// 幽灵点击守卫（R3-P1-1）：焦点归还后短窗内拦截无 mousedown 前驱的合成
// click；决策逻辑走 ghostClickGuard 纯模块（有单测），真实鼠标点击放行。
const ghostClickGuard = createGhostClickGuard();
function onDocumentMouseDownCapture(event: MouseEvent) {
  ghostClickGuard.noteMouseDown();
  // 批量目标弹层点空白收起：capture 阶段先于 batch-bar 的 @mousedown.stop 生效，
  // 条内空白/终端区/工具栏任意 mousedown 都能关；popover 内部与触发按钮
  // （触发按钮自身是 toggle 语义）不处理，避免关了又开的抖动。
  if (batchTargetsOpen.value) {
    const target = event.target;
    if (target instanceof HTMLElement && !target.closest(".batch-targets-popover") && !target.closest(".batch-bar-targets")) {
      batchTargetsOpen.value = false;
    }
  }
  // 关键词高亮管理弹层点空白收起：capture 阶段先于 popover 内部处理；
  // popover 内部与触发按钮（toggle 语义）不处理，避免关了又开的抖动。
  if (highlightMenuOpen.value) {
    const target = event.target;
    if (target instanceof HTMLElement && !target.closest(".highlight-rules-popover") && !target.closest(".highlight-rules-trigger")) {
      highlightMenuOpen.value = false;
    }
  }
}
function onDocumentClickCapture(event: MouseEvent) {
  if (!ghostClickGuard.shouldSuppress()) return;
  event.preventDefault();
  event.stopPropagation();
}
function trackStableFocus(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest(".modal-backdrop") || target.closest(".context-menu")) return;
  lastStableFocus = target;
}
// 与 Esc 关闭链同源的弹层在开状态（hostKey/agent 审批属安全弹窗：
// 参与聚焦与 Tab 陷阱，但不参与 Esc 关闭）。按模板出现顺序排列，
// 计数变化驱动聚焦/归还；同层互斥由交互保证。
const modalOpenStates = computed(() => [
  folderPickerTarget.value !== null,
  previewOpen.value,
  pasteConfirm.value,
  dropUploadPrompt.value,
  downloadPrompt.value !== null,
  downloadConflictPrompt.value !== null,
  attrsTarget.value,
  deleteTarget.value,
  batchDeleteOpen.value,
  recordingDeleteTarget.value !== null,
  recordingClearAllOpen.value,
  chmodTarget.value,
  newFileDialog.value,
  operationDialog.value,
  commandOpen.value,
  profilesOpen.value,
  auditOpen.value,
  settingsOpen.value,
  alertTriageOpen.value,
  hostKeyPrompt.value,
  agentPromptHead.value,
]);
const modalOpenCount = computed(() => modalOpenStates.value.filter(Boolean).length);

/** 当前最顶层弹层容器；无弹层时返回 null（同时只开一层，取首个命中即可）。 */
function topModalContainer(): HTMLElement | null {
  if (!modalOpenCount.value) return null;
  return document.querySelector<HTMLElement>(".modal-backdrop .modal");
}

function focusTopModal() {
  pickModalFocusTarget(topModalContainer())?.focus({ preventScroll: true });
}

watch(modalOpenCount, (count, previous) => {
  if (count > previous) {
    // 打开：整组从无到有时记录触发元素供关闭归还；嵌套打开（如命令
    // 对话框上叠粘贴确认）逐层入栈。触发元素优先取"弹层外稳定焦点"，
    // 避免抓到已随右键菜单卸载的菜单项。
    for (let i = previous; i < count; i++) {
      modalTriggerStack.push(lastStableFocus ?? document.body);
    }
    void nextTick(focusTopModal);
    return;
  }
  if (!count) {
    // 全部关闭：焦点归还触发按钮；触发元素已随右键菜单等卸载时逐层回退，
    // 找不到任何在档元素则落回 BODY（无焦点宿主可还）。
    while (modalTriggerStack.length) {
      const trigger = modalTriggerStack.pop()!;
      if (trigger.isConnected) {
        // 幽灵点击守卫（R3-P1-1）：键盘 Enter 提交后归还焦点的瞬间，浏览器
        // 会在刚聚焦的按钮上派发一次无 mousedown 的合成 click 并重开弹层；
        // 短窗内拦截该 click，纯键盘流一次 Enter 即成功关闭。
        ghostClickGuard.arm();
        trigger.focus({ preventScroll: true });
        break;
      }
    }
    return;
  }
  // 内层弹层关闭、外层仍在：焦点回落外层弹层首控件。
  void nextTick(focusTopModal);
});

/**
 * Esc 关闭链（一次按键关一层）：预览 > 对话框 > 右键菜单 > 工具栏弹出层。
 * 逐层 if-return：无内容打开时按键穿透，不影响终端内 vim 等自身 Esc 语义。
 */
function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Tab") {
    // 弹层 Tab 焦点陷阱（P1-2）：仅当弹层在场时圈定，无弹层不拦截
    // （终端/shell 内 Tab 补全等语义不受影响）。
    const container = topModalContainer();
    if (!container) return;
    const focusables = focusableElements(container);
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const index = nextFocusIndex(focusables.length, currentIndex, event.shiftKey);
    if (index < 0) return;
    event.preventDefault();
    focusables[index]?.focus({ preventScroll: true });
    return;
  }
  if (event.key !== "Escape") return;
  // 录制倒计时优先取消（遮罩在终端区，不属于弹层体系）。
  if (isCountdownActive(recordCountdown.value)) {
    cancelRecordCountdown();
    return;
  }
  if (previewOpen.value) {
    closePreview();
    return;
  }
  // ---- 对话框（安全取消语义；hostKey/agent 审批等安全弹窗不在此列）----
  if (folderPickerTarget.value) {
    folderPickerTarget.value = null;
    return;
  }
  if (pasteConfirm.value) {
    resolvePasteConfirm(false);
    return;
  }
  if (dropUploadPrompt.value) {
    resolveDropUpload("cancel");
    return;
  }
  if (downloadPrompt.value) {
    resolveDownloadPrompt(undefined);
    return;
  }
  if (downloadConflictPrompt.value) {
    resolveDownloadConflict(undefined);
    return;
  }
  if (attrsTarget.value) {
    closeAttributes();
    return;
  }
  if (deleteTarget.value) {
    deleteTarget.value = undefined;
    return;
  }
  if (batchDeleteOpen.value) {
    if (!batchDeleteSubmitting.value) batchDeleteOpen.value = false;
    return;
  }
  if (recordingDeleteTarget.value) {
    if (!recordingDeleteSubmitting.value) recordingDeleteTarget.value = null;
    return;
  }
  if (recordingClearAllOpen.value) {
    if (!recordingClearAllSubmitting.value) recordingClearAllOpen.value = false;
    return;
  }
  if (chmodTarget.value) {
    chmodTarget.value = undefined;
    return;
  }
  if (newFileDialog.value) {
    newFileDialog.value = false;
    return;
  }
  if (operationDialog.value) {
    operationDialog.value = null;
    return;
  }
  if (commandOpen.value) {
    commandOpen.value = false;
    return;
  }
  if (alertTriageOpen.value) {
    alertTriageOpen.value = false;
    return;
  }
  if (profilesOpen.value) {
    profilesOpen.value = false;
    return;
  }
  if (auditOpen.value) {
    auditOpen.value = false;
    return;
  }
  if (settingsOpen.value) {
    // 内联 profile 管理（设置弹窗内）沿用 profilesOpen→settingsOpen 的逐层
    // 退出语义：先关编辑表单，再收起配置档 section，最后关弹窗。
    if (profilesInlineOpen.value && profileEditing.value) {
      cancelProfileEdit();
      return;
    }
    if (profilesInlineOpen.value) {
      profilesInlineOpen.value = false;
      return;
    }
    settingsOpen.value = false;
    return;
  }
  // ---- 右键菜单（文件/终端/侧栏/空白/传输历史互斥，一次全清）----
  if (fileMenu.value || terminalMenu.value || sideMenu.value || blankMenu.value || transferHistoryMenu.value) {
    fileMenu.value = undefined;
    terminalMenu.value = undefined;
    sideMenu.value = undefined;
    blankMenu.value = undefined;
    transferHistoryMenu.value = undefined;
    return;
  }
  // ---- 工具栏弹出层（含指标浮层，R5-P2-1：同列 popover 一并进 Esc 链；
  //      高亮规则/终端 MCP 模式为收敛后新增弹层，同列收口）----
  if (quickMenuOpen.value || pathHistoryOpen.value || columnsOpen.value || transferPanelOpen.value || connectionInfoOpen.value || metricsOpen.value || batchTargetsOpen.value || batchSaveMode.value || bookmarkSaveOpen.value || highlightMenuOpen.value || agentModeOpen.value) {
    quickMenuOpen.value = false;
    highlightMenuOpen.value = false;
    agentModeOpen.value = false;
    pathHistoryOpen.value = false;
    columnsOpen.value = false;
    transferPanelOpen.value = false;
    connectionInfoOpen.value = false;
    bookmarkSaveOpen.value = false;
    batchTargetsOpen.value = false;
    if (batchSaveMode.value) cancelBatchBarSave();
    if (metricsOpen.value) closeMetrics();
  }
}

function openTransferPanel() {
  // 右键菜单项打开：菜单项自身随后卸载，互斥族统一收口后再开面板。
  closeToolbarPopovers();
  transferPanelOpen.value = true;
}

function pathFromUri(uri: string) {
  return uri.replace(/^sftp:/, "") || "/";
}

function normalizeRemotePath(path: string) {
  let value = path.trim() || "/";
  try { value = decodeURIComponent(value); } catch {}
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  return value === "/" ? value : value.replace(/\/+$/, "");
}

function joinRemote(parent: string, name: string) {
  return `${parent === "/" ? "" : parent.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

function parentPath(path: string) {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function shortFingerprint(fingerprint: string) {
  if (fingerprint.length <= 20) return fingerprint;
  return `${fingerprint.slice(0, 17)}…`;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days >= 1) return t("uptimeDays", { count: days, hours });
  if (hours >= 1) return t("uptimeHours", { count: hours, minutes });
  return t("uptimeMinutes", { count: minutes });
}

function formatModified(value?: number) {
  if (!value) return "";
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "short", timeStyle: "short" }).format(new Date(value * 1000));
}

function transferPercent(task: TransferTask) {
  return task.size > 0 ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : task.status === "completed" ? 100 : 0;
}

function readU64(bytes: Uint8Array, offset: number) {
  return Number(new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false));
}

function writeU64(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, BigInt(value), false);
}

async function waitForHostApi(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!window.dbxPlugin && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!window.dbxPlugin) throw new Error(t("hostApiUnavailable"));
  return window.dbxPlugin;
}

async function initialize() {
  const api = await waitForHostApi();
  hostContext.value = await Promise.any([
    api.ready,
    api.request<Record<string, unknown>>("host.getContext"),
  ]);
  locale.value = api.locale || "zh-CN";
  restoreUiState();
  if (api.appearance) applyAppearance(api.appearance);
  else if (isDbxPluginTheme(api.theme)) applyAppearance(themeToAppearance(api.theme));
  unsubscribeAppearance = api.onAppearanceChange?.(applyAppearance);
  // appearance 契约缺失（当前 1.1 桥只推 theme）时订阅 env 主题推送，两套不同时挂。
  if (!unsubscribeAppearance) unsubscribeTheme = onHostThemeChange((theme) => applyAppearance(themeToAppearance(theme)));
  unsubscribeLocale = api.onLocaleChange?.((nextLocale) => (locale.value = nextLocale || "zh-CN"));
  unsubscribeContext = api.onContextChange?.((context) => {
    hostContext.value = context;
  });
  unsubscribeEvent = api.onEvent(handleEvent);
  unsubscribeBinary = api.onBinary(handleBinary);
  unsubscribeFileDrag = api.fileTransfer?.onDragState((active) => (dragActive.value = active));
  unsubscribeFileDrop = api.fileTransfer?.onDrop((files) => {
    dragActive.value = false;
    void uploadHandleFiles(files).then(() => loadDirectory()).catch(showError);
  });
  await nextTick();
  createTerminal();
  if (!connectionId.value || !workbenchId.value) throw new Error(t("errors.hostBridgeMissing"));
  const state = initialState();
  if (restored.value) {
    terminalState.value = "disconnected";
    terminalError.value = t("restartDisconnected");
    return;
  }
  if (typeof state.sessionId === "string" && state.sessionId) await attachSession(state.sessionId);
  else {
    // 宿主切 tab / 左侧菜单重开可能整体重建工作台 webview。只恢复
    // 同一 workbench 的 live session；不能按 connectionId 复用任意会话，
    // 否则打开同一连接的新 Tab 会接管已有 Tab 的 PTY。
    const reattach = await findReattachSession();
    if (reattach) await attachSession(reattach, reattach);
    // bootRestore: 宿主启动恢复 tab 时会异步重放 connect（见 queryStore
    // reconnectRestoredPluginTabs），首个 ssh/session/open 可能先于它落地，
    // inactive 错误在该路径下参与有界重试。
    else await openSession(false, true);
  }
}

/**
 * Asks the sidecar for the live session bound to this workbench and connection
 * (sidecar `ssh/sessions/list`); "" when none — caller dials a fresh session.
 * Failures degrade to a fresh open instead of blocking the workbench.
 */
async function findReattachSession(): Promise<string> {
  try {
    const result = await window.dbxPlugin.invoke<{ sessions?: SessionSummary[] }>("ssh/sessions/list", {}, { timeoutMs: 10_000 });
    return pickLiveSessionForReattach(result?.sessions, { connectionId: connectionId.value, workbenchId: workbenchId.value });
  } catch {
    return "";
  }
}

watch([splitRatio, paneOrder, sftpPaneOpen, followDirectory, sudoMode, visibleColumns], persistState, { deep: true });

onMounted(() => {
  document.addEventListener("click", closeMenus);
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("mousedown", onDocumentMouseDownCapture, true);
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("focusin", trackStableFocus);
  document.addEventListener("mouseover", onTooltipOver);
  document.addEventListener("mouseout", onTooltipOut);
  document.addEventListener("pointerdown", hideTooltip, true);
  document.addEventListener("wheel", hideTooltip, true);
  void hydrateQuickCommands();
  void hydrateHighlightRules();
  void hydrateDownloadPrefs();
  void initialize().catch((cause) => {
    terminalState.value = "error";
    showError(cause, "terminal");
  });
});

onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("mouseover", onTooltipOver);
  document.removeEventListener("mouseout", onTooltipOut);
  document.removeEventListener("pointerdown", hideTooltip, true);
  document.removeEventListener("wheel", hideTooltip, true);
  hideTooltip();
  window.clearTimeout(persistTimer);
  window.clearInterval(recordCountdownTimer);
  void writeWorkbenchState();
  window.clearTimeout(resizeTimer);
  window.clearTimeout(reconnectTimer);
  window.clearInterval(reconnectCountdownTimer);
  window.clearTimeout(noticeTimer);
  window.clearTimeout(errorTimer);
  window.clearTimeout(zmodemDetectionTimer);
  window.clearTimeout(trzszDetectionTimer);
  window.clearTimeout(trzszWatchdogTimer);
  window.clearTimeout(trzszOverlayTimer);
  trzszFilter?.stopTransferringFiles();
  trzszFilter = null;
  window.clearTimeout(zoomNoticeTimer);
  window.clearTimeout(batchBroadcastTimer);
  window.clearInterval(metricsTimer);
  stopCommandMarkerTick();
  stopAgentPromptTimer();
  resolvePasteConfirm(false);
  if (terminalHost.value) {
    if (terminalPasteHandler) terminalHost.value.removeEventListener("paste", terminalPasteHandler, true);
    if (terminalWheelHandler) terminalHost.value.removeEventListener("wheel", terminalWheelHandler, true);
    if (terminalMouseDownHandler) terminalHost.value.removeEventListener("mousedown", terminalMouseDownHandler);
    if (terminalMouseUpHandler) terminalHost.value.removeEventListener("mouseup", terminalMouseUpHandler);
  }
  document.removeEventListener("click", closeMenus);
  document.removeEventListener("click", onDocumentClickCapture, true);
  document.removeEventListener("mousedown", onDocumentMouseDownCapture, true);
  document.removeEventListener("keydown", onDocumentKeydown);
  document.removeEventListener("focusin", trackStableFocus);
  unsubscribeEvent?.();
  unsubscribeBinary?.();
  unsubscribeAppearance?.();
  unsubscribeTheme?.();
  unsubscribeLocale?.();
  unsubscribeContext?.();
  unsubscribeFileDrag?.();
  unsubscribeFileDrop?.();
  resizeObserver?.disconnect();
  disposeInput?.dispose();
  disposeSelectionCopy?.dispose();
  terminalWriteThrottle.dispose();
  detachHighlightRender();
  terminal?.dispose();
  for (const waiter of uploadAckWaiters.values()) {
    window.clearTimeout(waiter.timer);
    waiter.reject(new Error(t("errors.workbenchDetached")));
  }
  for (const waiter of downloadChunkWaiters.values()) {
    window.clearTimeout(waiter.timer);
    waiter.reject(new Error(t("errors.workbenchDetached")));
  }
});
</script>

<template>
  <main class="workbench">
    <header class="toolbar" :style="toolbarStyle">
      <!-- 连接信息入口：Info 图标按钮紧跟标识区（状态徽章右侧），弹层锚在左侧 -->
      <div class="identity-side menu-anchor">
        <div class="identity">
          <span v-if="connection.color" class="connection-color" :style="{ backgroundColor: connection.color }" />
          <strong>{{ connectionIdentity }}</strong>
          <span v-if="connection.readOnly || connectionReadOnly" class="read-only-badge">{{ t("readOnly") }}</span>
          <span class="session-pill" :class="`session-${sessionStatus}`"><span class="session-dot" aria-hidden="true" />{{ t(`sessionStatus.${sessionStatus}`) }}<span v-if="sessionStatus === 'reconnecting' && reconnectCountdown" class="session-pill-countdown mono">{{ t("sessionStatus.reconnectCountdown", { seconds: reconnectCountdown.seconds, attempt: reconnectCountdown.attempt }) }}</span></span>
        </div>
        <button type="button" class="icon-button icon-neutral" :title="t('connectionInfo')" :aria-expanded="connectionInfoOpen" @click.stop="toggleConnectionInfo"><Info /></button>
        <section v-if="connectionInfoOpen" class="popover popover-left connection-info-popover" @click.stop>
          <h3>{{ t("connectionInfo") }}</h3>
          <dl class="connection-info-grid">
            <dt>{{ t("connectionInfoHost") }}</dt><dd class="mono"><span v-if="metricsDistroBadge" class="distro-badge" :style="{ backgroundColor: metricsDistroBadge.color }" :title="metricsDistroBadge.name">{{ metricsDistroBadge.label }}</span> {{ connection.host || connection.name || "–" }}</dd>
            <dt>{{ t("connectionInfoPort") }}</dt><dd class="mono">{{ connection.port || 22 }}</dd>
            <dt>{{ t("connectionInfoUser") }}</dt><dd class="mono">{{ connection.username || "–" }}</dd>
            <dt>{{ t("connectionInfoAuth") }}</dt><dd>{{ connectionAuthMethodLabel }}</dd>
            <template v-if="connection.readOnly || connectionReadOnly"><dt>{{ t("readOnly") }}</dt><dd>{{ t("yes") }}</dd></template>
            <dt>{{ t("connectionInfoLatency") }}</dt>
            <dd>
              <span class="mono">{{ connectionLatencyBusy ? t("connectionInfoMeasuring") : formatLatency(connectionLatency) }}</span>
              <span v-if="connectionLatencyFailed && !connectionLatencyBusy" class="task-error">{{ t("connectionInfoFailed") }}</span>
              <button class="link-button" :disabled="connectionLatencyBusy || !connected" @click="measureLatency">{{ t("connectionInfoMeasure") }}</button>
            </dd>
          </dl>
        </section>
      </div>
      <div class="toolbar-actions">
        <button class="icon-button icon-neutral" :title="paneOrder === 'terminal-left' ? t('moveSftpLeft') : t('moveTerminalLeft')" @click="togglePaneOrder"><ArrowLeftRight /></button>
        <button class="icon-button icon-cyan" :class="{ 'is-active': sftpPaneOpen }" :title="sftpPaneOpen ? t('sftpPane.close') : t('sftpPane.open')" :aria-pressed="sftpPaneOpen" @click="toggleSftpPane"><FolderOpen v-if="!sftpPaneOpen" /><PanelRightClose v-else /></button>
        <button class="icon-button" :title="t('terminalFontDecrease')" @click="adjustTerminalZoom(-1)"><span class="font-step-label" aria-hidden="true">A−</span></button>
        <button class="icon-button" :title="t('terminalFontIncrease')" @click="adjustTerminalZoom(1)"><span class="font-step-label" aria-hidden="true">A+</span></button>
        <button class="icon-button icon-emerald" :title="t('reconnect')" :disabled="terminalState === 'connecting' && !reconnectPending" @click="reconnectNow"><PlugZap /></button>
        <!-- 一键 sudo -v：向当前 PTY 写入命令刷新 sudo 凭据缓存；quick sudo 自动应答
             是否启用由连接设置决定（设置弹窗），工作台不再提供开关。 -->
        <button class="icon-button icon-emerald" :title="t('sudoRefresh.title')" :disabled="!connected" @click="sendSudoRefresh"><ShieldCheck /></button>
        <button class="icon-button icon-emerald" :title="t('profilesTitle')" @click="openProfilesManager"><KeyRound /></button>
        <button class="icon-button icon-cyan" :title="t('alertTriage.title')" @click="openAlertTriage"><Siren /></button>
        <label class="follow-directory-control" :title="t('followTerminal')">
          <button class="switch-control" type="button" role="switch" :aria-checked="followDirectory" :disabled="!connected" @click="setDirectoryTracking(!followDirectory)"><span /></button>
          <span>{{ t("followTerminal") }}</span>
        </label>
        <span class="toolbar-separator" aria-hidden="true" />
        <button class="icon-button icon-neutral" :title="t('commandTitle')" :disabled="!connected" @click="openCommandDialog"><SquareTerminal /></button>
        <button class="icon-button icon-neutral" :class="{ 'is-active': batchBarOpen }" :title="t('batchSendTitle')" :aria-pressed="batchBarOpen" :disabled="!connected" @click="toggleBatchBar"><ListChecks /></button>
        <div class="menu-anchor">
          <button class="icon-button icon-amber" :title="t('quickCommands')" :disabled="!connected" @click.stop="toggleQuickMenu"><Zap /></button>
          <section v-if="quickMenuOpen" class="popover quick-commands-popover" @click.stop>
            <!-- Termius Snippets 式结构：列表态（搜索 + 卡片 + 整宽新建按钮）与
                 编辑器子视图（返回 + 名称 + 多行命令 + 保存）两个视图切换。 -->
            <template v-if="!quickEditorOpen">
              <h3>{{ t("quickCommands") }}</h3>
              <p class="quick-command-global-hint">{{ t("quickCommandsGlobalHint") }}</p>
              <div v-if="quickCommands.length" class="quick-search">
                <Search />
                <input v-model="quickSearch" :placeholder="t('quickCommandsSearch')" spellcheck="false" />
              </div>
              <div v-if="!quickCommands.length" class="empty compact">{{ t("quickCommandsEmpty") }}</div>
              <div v-else-if="!filteredQuickCommands.length" class="empty compact">{{ t("quickCommandsNoMatch") }}</div>
              <div v-for="item in filteredQuickCommands" :key="item.id" class="quick-command-row quick-card" :class="{ expanded: quickExpandedId === item.id }">
                <button class="quick-card-main" :title="item.command" @click="toggleQuickExpand(item.id)">
                  <Braces class="quick-card-icon" />
                  <span class="quick-card-text">
                    <strong>{{ item.name }}</strong>
                    <span class="mono">{{ item.command }}</span>
                  </span>
                </button>
                <div class="quick-card-actions">
                  <button class="quick-action" :disabled="!connected" @click="sendQuickCommand(item)">{{ t("quickCommandRun") }}</button>
                  <button class="quick-action" :disabled="!connected" @click="pasteQuickCommand(item)">{{ t("quickCommandPaste") }}</button>
                  <button class="icon-button compact" :title="t('quickCommandsEdit')" @click="editQuickCommand(item)"><Pencil /></button>
                  <button class="icon-button compact" :title="t('delete')" @click="deleteQuickCommand(item.id)"><Trash2 /></button>
                </div>
                <div v-if="quickExpandedId === item.id" class="quick-card-full mono">{{ item.command }}</div>
              </div>
              <footer class="quick-command-footer">
                <button class="quick-new-btn" :disabled="quickCommands.length >= 20" @click="openQuickEditor()"><Plus />{{ t("quickCommandsNew") }}</button>
                <span class="quick-command-limit">{{ t("quickCommandsLimit", { count: quickCommands.length, limit: 20 }) }}</span>
              </footer>
            </template>
            <template v-else>
              <header class="quick-editor-head">
                <button class="icon-button compact" :title="t('cancel')" @click="closeQuickEditor"><ArrowLeft /></button>
                <h3>{{ quickDraft.id ? t("quickCommandsEdit") : t("quickCommandsNew") }}</h3>
              </header>
              <footer class="quick-command-editor">
                <input v-model="quickDraft.name" :placeholder="t('quickCommandsName')" :maxlength="60" autofocus />
                <textarea v-model="quickDraft.command" class="mono" rows="4" :placeholder="t('quickCommandsCommand')" :maxlength="500" @keydown.ctrl.enter="addQuickCommand" />
                <div class="quick-command-editor-actions">
                  <button class="primary-button" :disabled="quickSaving || !quickDraft.command.trim() || (!quickDraft.id && quickCommands.length >= 20)" @click="addQuickCommand">{{ quickDraft.id ? t("save") : t("quickCommandsAdd") }}</button>
                  <button @click="closeQuickEditor">{{ t("cancel") }}</button>
                  <span class="quick-command-limit">{{ t("quickCommandsLimit", { count: quickCommands.length, limit: 20 }) }}</span>
                </div>
              </footer>
            </template>
          </section>
        </div>
        <div class="menu-anchor">
          <button class="icon-button" :class="agentMode === 'off' ? 'icon-neutral' : 'icon-emerald is-active'" :title="t('agentTerminalQuickHint')" :disabled="!connected" @click.stop="toggleAgentModeMenu"><Bot /></button>
          <section v-if="agentModeOpen" class="popover agent-mode-popover" @click.stop>
            <h3>{{ t("agentTerminalSection") }}</h3>
            <label v-for="mode in AGENT_MODES" :key="mode" class="agent-mode-option">
              <input type="radio" name="agent-mode" :checked="agentMode === mode" :disabled="agentModeBusy" @change="applyAgentMode(mode)" />
              <span>{{ t(`agentTerminal${mode === "off" ? "Off" : mode === "auto" ? "Auto" : "Strict"}`) }}</span>
            </label>
            <p class="muted agent-mode-note">{{ agentModeHint }}</p>
          </section>
        </div>
        <div class="menu-anchor">
          <button class="icon-button icon-violet highlight-rules-trigger" :class="{ 'is-active': highlightMenuOpen }" :title="t('highlightRules.title')" @click.stop="toggleHighlightMenu"><Palette /></button>
          <section v-if="highlightMenuOpen" class="popover highlight-rules-popover" @click.stop>
            <h3>{{ t("highlightRules.title") }}</h3>
            <div v-if="!highlightRules.length" class="empty compact">{{ t("highlightRules.empty") }}</div>
            <div v-else class="highlight-rule-list">
              <div v-for="item in highlightRules" :key="item.id" class="highlight-rule-row">
              <span class="highlight-color-dot" :style="{ backgroundColor: item.color }" />
              <div class="highlight-rule-main">
                <span class="highlight-rule-pattern mono" :class="{ disabled: !item.enabled }" :title="item.pattern">{{ item.pattern }}</span>
                <span class="highlight-rule-badges">
                  <span v-if="item.isRegex">regex</span>
                  <span v-if="item.caseSensitive">Aa</span>
                </span>
              </div>
              <span class="highlight-rule-actions">
                <label class="highlight-switch-control" :title="t('highlightRules.enabled')">
                  <input type="checkbox" :checked="item.enabled" @change="toggleHighlightRule(item)" />
                </label>
                <button class="icon-button" :title="t('quickCommandsEdit')" @click="editHighlightRule(item)"><Pencil /></button>
                <button class="icon-button" :title="t('delete')" @click="deleteHighlightRule(item.id)"><Trash2 /></button>
              </span>
            </div>
            </div>
            <footer class="highlight-editor">
              <div class="highlight-editor-inputs">
                <input v-model="highlightDraft.pattern" :placeholder="t('highlightRules.patternPlaceholder')" :maxlength="200" spellcheck="false" @keydown.enter="saveHighlightRule" />
                <label class="highlight-editor-flag" :title="t('highlightRules.regex')"><input v-model="highlightDraft.isRegex" type="checkbox" />.*</label>
                <label class="highlight-editor-flag" :title="t('highlightRules.caseSensitive')"><input v-model="highlightDraft.caseSensitive" type="checkbox" />Aa</label>
              </div>
              <div class="highlight-palette">
                <button v-for="swatch in HIGHLIGHT_PALETTE" :key="swatch" type="button" class="highlight-palette-swatch" :class="{ selected: highlightDraft.color.toLowerCase() === swatch }" :style="{ backgroundColor: swatch }" :aria-label="swatch" @click="highlightDraft.color = swatch" />
                <input v-model="highlightDraft.color" class="highlight-hex-input mono" :title="t('highlightRules.color')" :maxlength="7" spellcheck="false" />
              </div>
              <div class="highlight-editor-actions">
                <span class="highlight-rule-limit">{{ t("highlightRules.limit", { count: highlightRules.length, limit: HIGHLIGHT_RULES_LIMIT }) }}</span>
                <button v-if="highlightDraft.id" @click="resetHighlightDraft">{{ t("cancel") }}</button>
                <button class="primary-button" :disabled="highlightSaving || !highlightDraft.pattern.trim() || (!highlightDraft.id && highlightRules.length >= HIGHLIGHT_RULES_LIMIT)" @click="saveHighlightRule">{{ highlightDraft.id ? t("save") : t("highlightRules.add") }}</button>
              </div>
              <p v-if="highlightDraftError" class="task-error">{{ highlightDraftError }}</p>
            </footer>
          </section>
        </div>
        <button class="icon-button icon-emerald" :class="{ 'is-active': metricsOpen }" :title="t('metrics')" :disabled="!connected" @click="toggleMetrics"><Gauge /></button>
        <button class="icon-button" :class="{ 'is-recording': recordingActive }" :title="recordingActive ? t('recordingStop') : t('recordingTitle')" :disabled="!connected" @click="toggleRecording"><Disc /></button>
        <button class="icon-button" :class="{ 'is-active': recordingsOpen }" :title="t('recordingsTitle')" @click="toggleRecordings"><Film /></button>
        <button class="icon-button icon-violet" :title="t('settings')" :disabled="!connected" @click="openSettings"><Settings /></button>
        <button class="icon-button icon-amber" :title="t('auditLog.title')" @click="openAuditLog"><FileText /></button>
        <div class="menu-anchor">
          <button class="icon-button icon-violet" :title="t('customizeColumns')" @click.stop="toggleColumnsMenu"><Columns3 /></button>
          <div v-if="columnsOpen" class="popover columns-popover" @click.stop>
            <label v-for="column in (['size', 'modified', 'permissions'] as SftpColumn[])" :key="column"><input type="checkbox" :checked="visibleColumns.includes(column)" @change="toggleColumn(column)" />{{ t(column) }}</label>
            <hr class="columns-popover-separator" />
            <label :title="t('sftpPane.defaultOpenHint')"><input type="checkbox" :checked="sftpPaneDefaultOpen" @change="toggleSftpPaneDefaultOpen" />{{ t("sftpPane.defaultOpen") }}</label>
          </div>
        </div>
        <div class="menu-anchor">
          <button class="icon-button icon-blue" :title="t('transfers')" @click.stop="toggleTransferPanel"><ArrowUpDown /><span v-if="activeTransfers" class="activity-dot" /></button>
          <section v-if="transferPanelOpen" class="popover transfer-popover" @click.stop @contextmenu.prevent.stop>
            <h3>{{ t("transfers") }}</h3>
            <div v-if="!transferList.length" class="empty compact">{{ t("noTransfers") }}</div>
            <article v-for="task in transferList" :key="task.taskId" class="transfer-card">
              <div class="transfer-title"><FileUp v-if="task.direction === 'upload'" /><Download v-else /><span>{{ task.fileName || task.taskId }}</span><strong>{{ transferPercent(task) }}%</strong></div>
              <progress :value="transferPercent(task)" max="100" />
              <div class="transfer-meta"><span>{{ t(`transferStatus.${task.status}`) }}</span><span>{{ formatBytes(task.transferred) }} / {{ formatBytes(task.size) }}</span><span v-if="transferSpeeds[task.taskId]">{{ formatBytes(transferSpeeds[task.taskId]) }}/s</span></div>
              <p v-if="task.localPath" class="transfer-path mono" :title="task.localPath">{{ task.localPath }}</p>
              <div v-if="transferPausable(task.status) || task.status === 'queued' || task.status === 'running' || task.localPath" class="transfer-actions">
                <button v-if="transferPausable(task.status)" class="icon-button" :title="t(pausedTaskIds.has(task.taskId) ? 'transferResume' : 'transferPause')" :aria-label="t(pausedTaskIds.has(task.taskId) ? 'transferResume' : 'transferPause')" @click="toggleTransferPause(task)"><Play v-if="pausedTaskIds.has(task.taskId)" /><Pause v-else /></button>
                <button v-if="task.status === 'queued' || task.status === 'running'" class="icon-button" :title="t('cancel')" :aria-label="t('cancel')" @click="cancelTransfer(task)"><X /></button>
                <button v-if="task.localPath" class="icon-button" :title="t('revealInFolder')" :aria-label="t('revealInFolder')" @click="revealTransferTarget(task.localPath)"><FolderOpen /></button>
                <button v-if="task.localPath" class="icon-button" :title="t('openDownloadedFile')" :aria-label="t('openDownloadedFile')" @click="openTransferTarget(task.localPath)"><FileText /></button>
              </div>
              <p v-if="task.error" class="task-error">{{ task.error }}</p>
            </article>
            <!-- 保留上传断点续传入口；文件选择器本身始终隐藏，仅由 Resume 按钮唤起。 -->
            <template v-if="resumableTasks.length">
              <h3 class="transfer-history-title">{{ t("resumableTitle") }}</h3>
              <article v-for="task in resumableTasks" :key="task.taskId" class="transfer-card">
                <div class="transfer-title"><FileUp /><span :title="task.remotePath">{{ task.fileName }}</span></div>
                <div class="transfer-meta"><span>{{ formatBytes(task.resumableBytes) }} / {{ formatBytes(task.size) }}</span></div>
                <div class="transfer-actions"><button class="icon-button" :title="t('resumableResume')" :aria-label="t('resumableResume')" @click="beginResumeUpload(task)"><Play /></button></div>
              </article>
            </template>
            <input ref="resumeInput" type="file" class="hidden" @change="onResumeFilePicked" />
            <!-- 传输历史与活跃任务并列展示：历史是落盘快照，不应被当前传输状态遮住。 -->
            <div class="transfer-history-head">
              <h3 class="transfer-history-title">{{ t("transfersHistory.title") }}</h3>
              <span class="transfer-history-actions">
                <button type="button" class="icon-button" :title="t('refresh')" :disabled="transferHistoryLoading || resumableLoading" @click.stop="refreshTransferPanel"><RefreshCw :class="{ spinning: transferHistoryLoading || resumableLoading }" /></button>
                <button type="button" class="icon-button" :title="t('transfersHistory.clear')" :disabled="!transferHistory.length" @click.stop="clearTransferHistory"><Trash2 /></button>
              </span>
            </div>
            <div v-if="transferHistoryFailed" class="empty compact">
              <span>{{ t("transfersHistory.loadFailed") }}</span>
              <button type="button" class="link-button" @click.stop="refreshTransferPanel">{{ t("refresh") }}</button>
            </div>
            <div v-else-if="transferHistoryLoading && !transferHistory.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
            <div v-else-if="!transferHistory.length" class="empty compact">{{ t("transfersHistory.empty") }}</div>
            <article v-for="entry in transferHistory" :key="entry.taskId" class="transfer-card transfer-history-card" @contextmenu="showTransferHistoryMenu($event, entry)">
              <div class="transfer-title"><FileUp v-if="entry.direction === 'upload'" /><Download v-else /><span :title="entry.fileName">{{ entry.fileName || entry.taskId }}</span></div>
              <div class="transfer-meta"><span>{{ t(`transferStatus.${entry.status}`) }}</span><span>{{ formatBytes(entry.size) }}</span></div>
              <p v-if="entry.localPath" class="transfer-path mono" :title="entry.localPath">{{ entry.localPath }}</p>
              <p v-if="entry.error" class="task-error">{{ entry.error }}</p>
            </article>
          </section>
        </div>
      </div>
    </header>

    <div v-if="tooltip" ref="tooltipBubble" class="app-tooltip" :class="{ 'app-tooltip-above': tooltip.above }" :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px`, '--arrow-offset': `${tooltip.arrowOffset}px` }" role="tooltip">{{ tooltip.text }}</div>
    <div v-if="notice" class="notice">
      <span>{{ notice }}</span>
      <button v-for="action in noticeActions" :key="action.label" class="notice-action" @click="action.run()">{{ action.label }}</button>
    </div>
    <div v-if="sftpError" class="error-banner"><span>{{ sftpError }}</span><button v-if="sftpErrorRetry" class="notice-action" @click="sftpErrorRetry()">{{ t("retry") }}</button><button :title="t('close')" @click="sftpError = ''; sftpErrorRetry = null"><X /></button></div>

    <section ref="paneContainer" :class="orderedPaneClass">
      <section class="terminal-pane" :class="{ 'drag-active': terminalDragActive, 'batch-bar-open': connected && batchBarOpen }" :style="terminalBasis" @contextmenu="showTerminalMenu" @dragenter.prevent="onTerminalDragEnter" @dragover.prevent @dragleave.self="terminalDragActive = false" @drop.prevent="onTerminalDrop($event)">
        <div ref="terminalHost" class="terminal-host" />
        <div v-if="terminalDragActive || (dragActive && !sftpPaneOpen)" class="drop-overlay"><FileUp /><strong>{{ t("terminalDrop.hint") }}</strong></div>
        <TerminalSearchPanel
          v-if="searchOpen"
          :locale="locale"
          :initial-query="searchSeedQuery"
          :initial-options="searchSeedOptions"
          :match-state="searchMatchState"
          :result-index="searchResultIndex"
          :result-count="searchResultCount"
          @find-next="(query, options) => runTerminalSearch(query, options, 'next')"
          @find-previous="(query, options) => runTerminalSearch(query, options, 'prev')"
          @clear="clearTerminalSearch"
          @close="closeTerminalSearch"
        />
        <div v-if="reconnectPending" class="reconnect-banner" role="status">
          <Loader2 class="spinning" />
          <span class="reconnect-text">{{ t("reconnectBanner.label") }}</span>
          <span v-if="reconnectCountdown" class="reconnect-countdown mono">{{ t("sessionStatus.reconnectCountdown", { seconds: reconnectCountdown.seconds, attempt: reconnectCountdown.attempt }) }}</span>
          <span v-if="reconnectCountdown" class="reconnect-attempt">{{ t("reconnectBanner.attempt", { attempt: reconnectCountdown.attempt }) }}</span>
          <progress v-if="reconnectCountdown" :value="reconnectCountdown.percent" max="100" />
          <button class="reconnect-now" @click="reconnectNow">{{ t("reconnectNow") }}</button>
        </div>
        <!-- 录制中悬浮控制条：底部居中，红色呼吸点 + 时长 + 停止 -->
        <div v-if="recordingActive" class="recording-float" role="status">
          <Disc class="recording-float-dot" />
          <span class="recording-elapsed mono">{{ formatDuration(recordingElapsedSec) }}</span>
          <button class="recording-stop" @click="toggleRecording"><Square />{{ t("recordingStop") }}</button>
        </div>
        <!-- 录制开始倒计时遮罩：大数字 3→2→1（:key 重触发放缩动画），Esc/点击取消 -->
        <div v-if="recordCountdown !== null" class="record-countdown-overlay" role="status" @click="cancelRecordCountdown">
          <span class="record-countdown-number" :key="recordCountdown">{{ recordCountdown }}</span>
          <span class="record-countdown-hint">{{ t("recordingCountdownHint") }}</span>
        </div>
        <div v-if="terminalState !== 'connected' && !reconnectPending" class="terminal-overlay">
          <ConnectingCard
            :locale="locale"
            :name="connection.name || connectionIdentity"
            :identity="connectionIdentity"
            :state="connectCardState"
            :error-text="terminalErrorFriendly || terminalError || t('disconnected')"
            :error-detail="terminalErrorDetail"
            :logs-open="connectLogsOpen"
            :logs="connectLogEntries"
            @cancel="cancelConnect"
            @reconnect="reconnect"
            @connect="startConnect"
            @toggle-logs="connectLogsOpen = !connectLogsOpen"
          />
        </div>
        <div v-if="commandMarker.installed" class="terminal-command-marker" :class="{ active: commandMarker.active, failed: !commandMarker.active && commandMarker.exitCode !== null && commandMarker.exitCode !== 0 }" :title="commandMarkerDetails" @click="terminal?.focus()">
          <Loader2 v-if="commandMarker.active" class="spinning" />
          <TriangleAlert v-else-if="commandMarker.exitCode" />
          <Info v-else />
          <span v-if="commandMarker.active" class="marker-text">{{ t("terminalCommand.running", { command: commandMarker.command || "…" }) }}</span>
          <span v-if="commandMarker.active && commandMarkerElapsed !== null" class="marker-elapsed mono">{{ formatCommandDuration(commandMarkerElapsed) }}</span>
          <span v-else-if="commandMarker.exitCode !== null" class="marker-text">{{ t("terminalCommand.finished", { code: commandMarker.exitCode, duration: formatCommandDuration(commandMarker.durationMs) }) }}</span>
          <span v-else class="marker-text">{{ t("terminalCommand.hint") }}</span>
          <span v-if="commandMarker.cwd" class="marker-cwd mono">{{ commandMarker.cwd }}</span>
        </div>
        <div v-if="agentRunning" class="agent-run-banner">
          <Loader2 class="spinning" />
          <span class="agent-run-text">{{ t("agentRunningBanner") }}</span>
          <code class="agent-run-command mono" :title="agentRunning.command">{{ agentRunning.command }}</code>
          <button class="agent-interrupt" @click="interruptAgentRun">{{ t("agentInterrupt") }}</button>
        </div>
        <div v-if="zmodemBusy" class="zmodem-status">
          <Loader2 class="spinning" />
          <span>{{ zmodemState === "waiting" ? t("zmodemWaiting") : t("zmodemUploading", { name: zmodemFileName, percent: zmodemPercent }) }}</span>
          <span v-if="zmodemSpeed">{{ formatBytes(zmodemSpeed) }}/s</span>
        </div>
        <div v-if="trzszOverlayVisible" class="zmodem-status trzsz-status" :class="{ 'trzsz-done': trzszPhase === 'success', 'trzsz-failed': trzszPhase === 'failed' }">
          <Loader2 v-if="trzszPhase === 'waiting' || trzszPhase === 'transferring'" class="spinning" />
          <TriangleAlert v-else-if="trzszPhase === 'failed'" />
          <span class="trzsz-label">{{ trzszStatusLabel }}</span>
          <progress v-if="trzszPhase === 'transferring'" :value="trzszPercent" max="100" />
          <span v-if="trzszPhase === 'transferring' && trzszFileCount > 1" class="trzsz-count mono">{{ trzszFileIndex }}/{{ trzszFileCount }}</span>
          <span v-if="trzszPhase === 'transferring' && trzszSpeed" class="trzsz-speed">{{ formatBytes(trzszSpeed) }}/s</span>
          <button v-if="trzszBusy" class="trzsz-cancel" :title="t('cancel')" @click="cancelTrzszTransfer"><X /></button>
        </div>
        <section v-if="metricsOpen" class="metrics-float">
          <header>
            <h2>{{ t("metrics") }}<span v-if="metricsDistroBadge" class="distro-badge" :style="{ backgroundColor: metricsDistroBadge.color }" :title="metricsDistroBadge.name">{{ metricsDistroBadge.label }}</span><span v-if="metrics?.hostname" class="metrics-host" :title="metrics.hostname"> · {{ metrics.hostname }}</span></h2>
            <button :title="t('close')" class="icon-button" @click="closeMetrics"><X /></button>
          </header>
          <div class="metrics-float-body">
            <div v-if="metricsLoading && !metrics" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
            <p v-else-if="metricsError" class="task-error">{{ metricsError }} <button class="link-button" @click="refreshMetrics">{{ t("refresh") }}</button></p>
            <template v-else-if="metrics">
              <div class="metrics-grid">
                <div class="metric-card">
                  <strong>{{ metrics.cpu?.percent ?? "–" }}%</strong>
                  <span>{{ t("metricsCpu") }}</span>
                  <small v-if="metrics.cpu?.cores">{{ metrics.cpu.cores }} vCPU · {{ metrics.cpu?.load1 ?? "–" }} / {{ metrics.cpu?.load5 ?? "–" }} / {{ metrics.cpu?.load15 ?? "–" }}</small>
                </div>
                <div class="metric-card">
                  <strong>{{ metrics.memory?.totalBytes ? Math.round(((metrics.memory.usedBytes ?? 0) / metrics.memory.totalBytes) * 100) : "–" }}%</strong>
                  <span>{{ t("metricsMemory") }}</span>
                  <small v-if="metrics.memory?.totalBytes">{{ formatBytes(metrics.memory.usedBytes) }} / {{ formatBytes(metrics.memory.totalBytes) }}<template v-if="metrics.memory.swapTotalBytes"> · {{ t("metricsSwap") }} {{ formatBytes(metrics.memory.swapUsedBytes ?? 0) }}</template></small>
                </div>
                <div class="metric-card metric-card--wide" v-if="metrics.uptimeSeconds != null">
                  <strong>{{ formatUptime(metrics.uptimeSeconds) }}</strong>
                  <span>{{ t("metricsUptime") }}</span>
                  <small v-if="metrics.kernel">{{ metrics.kernel }}</small>
                </div>
              </div>
              <div v-if="metricsCpuSparkline || metricsMemSparkline" class="metrics-disks metrics-trend">
                <div class="disk-row"><span class="mono">{{ t("metricsCpu") }}</span><svg class="metrics-sparkline metrics-trend-line" width="120" height="18" viewBox="0 0 120 18" role="img" aria-label="cpu trend"><polyline :points="metricsCpuSparkline" fill="none" style="stroke: var(--info)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg><span class="numeric">{{ Math.round(metricSamples.cpu.at(-1) ?? 0) }}%</span></div>
                <div class="disk-row"><span class="mono">{{ t("metricsMemory") }}</span><svg class="metrics-sparkline metrics-trend-line" width="120" height="18" viewBox="0 0 120 18" role="img" aria-label="memory trend"><polyline :points="metricsMemSparkline" fill="none" style="stroke: var(--success)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg><span class="numeric">{{ Math.round(metricSamples.mem.at(-1) ?? 0) }}%</span></div>
              </div>
              <div v-if="visibleDiskMounts.length" class="metrics-disks">
                <div v-for="disk in visibleDiskMounts" :key="disk.mount" class="disk-row">
                  <span class="mono" :title="disk.mount">{{ disk.mount }}</span>
                  <progress :value="Math.min(100, disk.percentUsed)" max="100" :class="{ 'disk-warn': disk.percentUsed >= 85 }" />
                  <span class="numeric">{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.totalBytes) }} · {{ Math.round(disk.percentUsed) }}%</span>
                </div>
              </div>
              <div v-if="visibleNetworkInterfaces.length">
                <h3 class="settings-section-title metrics-net-title">
                  <span>{{ t("metricsNetwork") }}</span>
                  <span v-if="metricsRxSparkline || metricsTxSparkline" class="metrics-sparkline-group">
                    <svg class="metrics-sparkline" width="60" height="18" viewBox="0 0 60 18" role="img" aria-label="rx"><polyline :points="metricsRxSparkline" fill="none" style="stroke: var(--info)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>
                    <svg class="metrics-sparkline" width="60" height="18" viewBox="0 0 60 18" role="img" aria-label="tx"><polyline :points="metricsTxSparkline" fill="none" style="stroke: var(--success)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>
                  </span>
                </h3>
                <div class="metrics-disks">
                  <div
                    v-for="net in visibleNetworkInterfaces"
                    :key="net.name"
                    class="disk-row"
                    :title="`rx ${formatBytes(net.rxTotal)} · tx ${formatBytes(net.txTotal)}`"
                  >
                    <span class="mono" :title="net.name">{{ net.name }}</span>
                    <progress :value="networkRateShare(net)" max="100" />
                    <span class="numeric">↓ {{ formatRate(net.rxRate) }} · ↑ {{ formatRate(net.txRate) }}</span>
                  </div>
                </div>
              </div>
              <div v-if="metrics.processes?.length">
                <h3 class="settings-section-title"><span>{{ t("metricsProc") }}</span><button class="link-button" @click="toggleProcessPanel">{{ t(processesOpen ? "procCollapse" : "procManage") }}</button></h3>
                <div class="file-header" :style="metricsProcGridStyle">
                  <span>{{ t("metricsProcPid") }}</span>
                  <span>{{ t("metricsProcUser") }}</span>
                  <span class="numeric">{{ t("metricsProcCpu") }}</span>
                  <span class="numeric">{{ t("metricsProcMem") }}</span>
                  <span>{{ t("metricsProcCommand") }}</span>
                </div>
                <div v-for="proc in metrics.processes" :key="proc.pid" class="file-row" :style="metricsProcGridStyle">
                  <span class="mono">{{ proc.pid }}</span>
                  <span class="mono">{{ proc.user }}</span>
                  <span class="numeric" :class="{ 'proc-hot': proc.cpuPercent >= 50 }">{{ proc.cpuPercent }}%</span>
                  <span class="numeric" :class="{ 'proc-hot': proc.memPercent >= 30 }">{{ proc.memPercent }}%</span>
                  <span class="mono" :title="proc.command">{{ proc.command }}</span>
                </div>
              </div>
              <div v-if="processesOpen" class="proc-manage">
                <div class="command-history-header">
                  <span>{{ t("procTitle", { count: processRows.length }) }}</span>
                  <span class="batch-target-actions">
                    <button class="link-button" @click="refreshProcessList">{{ t("refresh") }}</button>
                  </span>
                </div>
                <div class="proc-sort-row">
                  <label v-for="key in (['cpu', 'mem', 'pid'] as const)" :key="key" class="proc-sort-option">
                    <input type="radio" name="procSort" :value="key" v-model="processSortKey" />{{ t(`procSort.${key}`) }}
                  </label>
                </div>
                <div v-if="processLoading && !visibleProcessRows.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
                <div v-else-if="!visibleProcessRows.length" class="empty compact">{{ t("procEmpty") }}</div>
                <template v-else>
                  <div class="file-header" :style="procGridStyle">
                    <span>{{ t("metricsProcPid") }}</span>
                    <span>{{ t("metricsProcUser") }}</span>
                    <span class="numeric">{{ t("metricsProcCpu") }}</span>
                    <span class="numeric">{{ t("metricsProcMem") }}</span>
                    <span>{{ t("procEtime") }}</span>
                    <span>{{ t("metricsProcCommand") }}</span>
                    <span></span>
                  </div>
                  <div v-for="proc in visibleProcessRows" :key="proc.pid" class="file-row" :style="procGridStyle">
                    <span class="mono">{{ proc.pid }}</span>
                    <span class="mono">{{ proc.user }}</span>
                    <span class="numeric" :class="{ 'proc-hot': proc.cpuPercent >= 50 }">{{ proc.cpuPercent }}%</span>
                    <span class="numeric" :class="{ 'proc-hot': proc.memPercent >= 30 }">{{ proc.memPercent }}%</span>
                    <span class="mono">{{ proc.etime }}</span>
                    <span class="mono" :title="proc.command">{{ proc.command }}</span>
                    <span class="proc-kill-group">
                      <button class="link-button" @click="killProcessRow(proc, 15)">{{ t("procKill") }}</button>
                      <button class="link-button proc-kill-force" @click="killProcessRow(proc, 9)">{{ t("procKillForce") }}</button>
                    </span>
                  </div>
                  <p v-if="sortedProcessRows.length > visibleProcessRows.length" class="muted metrics-hint">{{ t("procCapped", { shown: visibleProcessRows.length, total: sortedProcessRows.length }) }}</p>
                </template>
              </div>
              <p class="metrics-hint muted">{{ t("metricsRefreshHint") }}</p>
            </template>
          </div>
        </section>
        <!-- 录制记录浮条：列出 .cast 录制，可回放/删除 -->
        <section v-if="recordingsOpen" class="metrics-float recordings-float">
          <header>
            <h2>{{ t("recordingsTitle") }}</h2>
            <button v-if="recordings.length" class="icon-button recording-delete" :title="t('recordingsClear')" :disabled="recordingClearAllSubmitting" @click="recordingClearAllOpen = true"><Trash2 /></button>
            <button :title="t('close')" class="icon-button" @click="toggleRecordings"><X /></button>
          </header>
          <div class="metrics-float-body">
            <div v-if="recordingsLoading && !recordings.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
            <div v-else-if="!recordings.length" class="empty compact">{{ t("recordingsEmpty") }}</div>
            <article v-for="item in recordings" :key="item.recordingId" class="recording-card">
              <Disc class="recording-icon" />
              <div class="recording-text">
                <span class="recording-host">{{ item.host || item.recordingId }}</span>
                <span class="recording-meta">{{ formatRecordedAt(item.startedAt) }}<template v-if="item.bytes"> · {{ formatBytes(item.bytes) }}</template></span>
              </div>
              <span class="recording-duration mono">{{ formatDuration(item.durationSecs ?? 0) }}</span>
              <div class="recording-actions">
                <button class="icon-button compact" :title="t('replayOpen')" @click="openReplay(item)"><Play /></button>
                <button class="icon-button compact" :title="t('replayExportGif')" :disabled="replayExporting" @click="exportRecordingFromList(item)"><Loader2 v-if="recordingExportingId === item.recordingId" class="spinning" /><ImagePlay v-else /></button>
                <button v-if="localCanSave" class="icon-button compact" :title="t('revealInFolder')" :aria-label="t('revealInFolder')" @click="revealRecording(item)"><FolderOpen /></button>
                <button class="icon-button compact recording-delete" :title="t('recordingDelete')" @click="deleteRecording(item)"><Trash2 /></button>
              </div>
            </article>
          </div>
        </section>
        <!-- 回放弹窗：xterm 重放 + 倍速/进度/GIF 导出 -->
        <div v-if="replayState" class="replay-overlay" @click.self="closeReplay">
          <section class="replay-modal">
            <header>
              <h2>{{ t("replayTitle") }}<span class="metrics-host"> · {{ replayState.summary.host || replayState.summary.recordingId }}</span></h2>
              <button class="icon-button" :title="t('replayClose')" @click="closeReplay"><X /></button>
            </header>
            <div class="replay-terminal-wrap">
              <div ref="replayHost" class="replay-terminal"></div>
              <div v-if="replayDurationMs <= 0" class="replay-empty">{{ t("replayEmpty") }}</div>
            </div>
            <div class="replay-controls">
              <button class="icon-button" :title="t(replayPlaying ? 'replayPause' : 'replayPlay')" @click="toggleReplayPlay"><Pause v-if="replayPlaying" /><Play v-else /></button>
              <select v-model.number="replaySpeed" class="replay-speed" :title="t('replaySpeed')">
                <option :value="0.5">0.5×</option>
                <option :value="1">1×</option>
                <option :value="2">2×</option>
                <option :value="4">4×</option>
              </select>
              <input class="replay-seek" type="range" min="0" :max="Math.max(1, replayDurationMs)" :value="replayPlayheadMs" step="100" @input="onReplaySeek" />
              <span class="mono replay-time">{{ formatDuration(replayPlayheadMs / 1000) }} / {{ formatDuration(replayDurationMs / 1000) }}</span>
              <button class="link-button" :disabled="replayExporting" @click="exportReplayGif">{{ replayExporting ? t("replayExporting") : t("replayExportGif") }}</button>
            </div>
          </section>
        </div>
        <!-- 批量发送结果浮条：显示在命令条上方，可手动关闭。 -->
        <div v-if="connected && batchBarOpen && (batchSummary || batchError)" class="batch-bar-status" role="status">
          <template v-if="batchSummary">
            <p :class="batchSummary.failed ? 'task-error' : 'muted'">
              {{ batchSummary.failed ? t("batchSendPartial", { sent: batchSummary.sent, failed: batchSummary.failed }) : t("batchSendSent", { count: batchSummary.sent }) }}
            </p>
            <div v-if="batchSummary.failed" class="batch-result-list">
              <span v-for="row in batchSummary.rows.filter((item) => !item.success)" :key="row.sessionId" class="batch-result-row mono">
                {{ batchSessionLabel(row.sessionId) }} · {{ row.error || t("batchSendFailed") }}
              </span>
            </div>
          </template>
          <p v-else class="task-error">{{ batchError }}</p>
          <button class="icon-button" :title="t('close')" @click="dismissBatchResult"><X /></button>
        </div>
        <!-- 批量发送命令条（Electerm quick-command bar）：贴终端底部，回车即发送；
             目标选择/快速命令切换/保存为快速命令均在条上完成。 -->
        <section v-if="connected && batchBarOpen" class="batch-bar" @contextmenu.stop @mousedown.stop @click.stop>
          <div class="menu-anchor">
            <button class="batch-bar-targets" :title="t('batchSendTitle')" @click.stop="toggleBatchTargetsPopover"><ListChecks /><span>{{ t("batchSendTargets", { count: batchSelected.length, total: batchTargets.length }) }}</span></button>
            <section v-if="batchTargetsOpen" class="popover batch-targets-popover" @click.stop>
              <p class="muted batch-send-hint">{{ t("batchSendHint") }}</p>
              <div class="command-history-header">
                <span>{{ t("batchSendTargets", { count: batchSelected.length, total: batchTargets.length }) }}</span>
                <span class="batch-target-actions">
                  <button class="link-button" @click="pickBatchTargets('connected')">{{ t("batchSendConnected") }}</button>
                  <button class="link-button" @click="pickBatchTargets('all')">{{ t("batchSendAll") }}</button>
                  <button class="link-button" :disabled="batchLoading" @click="refreshBatchTargets">{{ t("refresh") }}</button>
                </span>
              </div>
              <div v-if="batchLoading && !batchTargets.length" class="empty compact"><Loader2 class="spinning" /><span>{{ t("batchSendLoading") }}</span></div>
              <div v-else-if="!batchTargets.length" class="empty compact">{{ t("batchSendNoSessions") }}</div>
              <div v-else class="batch-target-list">
                <label v-for="target in batchTargets" :key="target.sessionId" class="batch-target-row" :class="{ offline: target.connected === false }">
                  <input type="checkbox" :checked="batchSelected.includes(target.sessionId)" @change="toggleBatchTargetId(target.sessionId)" />
                  <span class="mono">{{ batchTargetLabel(target) }}</span>
                  <span v-if="target.sessionId === session?.sessionId" class="batch-badge">{{ t("batchSendCurrent") }}</span>
                  <span v-if="target.connected === false" class="batch-badge batch-badge-warn">{{ t("batchSendDisconnected") }}</span>
                  <span v-if="target.readOnly" class="read-only-badge">{{ t("readOnly") }}</span>
                </label>
              </div>
            </section>
          </div>
          <select v-if="!batchSaveMode && quickCommands.length" v-model="batchQuickPickId" class="batch-bar-quick" :title="t('batchSendQuickPick')" @change="applyBatchQuickPick">
            <option value="">{{ t("batchSendQuickPick") }}</option>
            <option v-for="item in quickCommands" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <input
            v-if="batchSaveMode"
            v-model="batchSaveName"
            class="batch-bar-input"
            :placeholder="t('quickCommandsName')"
            :maxlength="60"
            autofocus
            :disabled="batchSaving"
            @keydown.enter="confirmBatchBarSave"
          />
          <input
            v-else
            v-model="batchDraft"
            class="batch-bar-input mono"
            spellcheck="false"
            :placeholder="t('batchSendPlaceholder')"
            :disabled="batchSending"
            @input="broadcastBatchBarState()"
            @keydown.up.prevent="browseBatchHistoryUp"
            @keydown.down.prevent="browseBatchHistoryDown"
            @keydown.enter="sendBatchCommand"
          />
          <template v-if="batchSaveMode">
            <button class="icon-button icon-emerald" :title="t('save')" :disabled="batchSaving" @click="confirmBatchBarSave"><Save /></button>
            <button class="icon-button" :title="t('cancel')" :disabled="batchSaving" @click="cancelBatchBarSave"><X /></button>
          </template>
          <button
            v-else
            class="icon-button"
            :title="quickCommands.length >= QUICK_COMMANDS_LIMIT ? t('quickCommandsLimit', { count: quickCommands.length, limit: QUICK_COMMANDS_LIMIT }) : t('batchBarSave')"
            :disabled="!batchDraft.trim() || quickCommands.length >= QUICK_COMMANDS_LIMIT"
            @click="openBatchBarSave"
          ><Save /></button>
          <button class="icon-button icon-emerald batch-bar-send" :title="t('batchSendSend')" :disabled="batchSending || !batchDraft.trim() || !batchSelected.length" @click="sendBatchCommand">
            <Loader2 v-if="batchSending" class="spinning" />
            <Send v-else />
          </button>
        </section>
      </section>

      <div v-if="sftpPaneOpen" class="divider" @pointerdown="startDividerDrag" />

      <section v-if="sftpPaneOpen" ref="sftpPane" class="sftp-pane" tabindex="-1" :class="{ 'drag-active': dragActive }" @pointerdown="focusSftpPaneOnPointerDown" @paste.capture="onSftpClipboardPaste" @dragenter.prevent="dragActive = true" @dragover.prevent @dragleave.self="dragActive = false" @drop.prevent="onDrop">
        <div class="path-toolbar">
          <button class="icon-button" :title="t('parentFolder')" :disabled="currentPath === '/'" @click="goParent"><ArrowUp /></button>
          <button class="icon-button icon-amber" :title="t('home')" :disabled="!connected" @click="loadHome"><Home /></button>
          <button class="icon-button icon-cyan" :title="t('refresh')" :disabled="!connected || loadingFiles" @click="loadDirectory()"><RefreshCw :class="{ spinning: loadingFiles }" /></button>
          <input v-model="currentPath" spellcheck="false" @keydown.enter="submitPathInput" />
          <div class="menu-anchor">
            <button class="icon-button icon-amber" :title="t('sftpBookmark.add')" :disabled="!connected" @click.stop="toggleBookmarkSave"><Star /></button>
            <!-- 星标收藏弹层：label 默认取路径末段，可编辑后保存（前端先行校验 + 后端错误回显） -->
            <div v-if="bookmarkSaveOpen" class="popover bookmark-save-popover" @click.stop>
              <strong class="path-history-title">{{ t("sftpBookmark.add") }}</strong>
              <span class="bookmark-save-path mono" :title="currentPath">{{ currentPath }}</span>
              <input v-model="bookmarkLabelDraft" class="bookmark-label-input mono" :maxlength="SFTP_BOOKMARK_LABEL_MAX_LENGTH" spellcheck="false" :placeholder="t('sftpBookmark.namePlaceholder')" :disabled="bookmarkSaving" autofocus @keydown.enter="confirmBookmarkSave" />
              <div class="bookmark-save-actions">
                <button class="icon-button icon-emerald" :title="t('save')" :disabled="bookmarkSaving" @click="confirmBookmarkSave"><Save /></button>
                <button class="icon-button" :title="t('cancel')" :disabled="bookmarkSaving" @click="bookmarkSaveOpen = false"><X /></button>
              </div>
            </div>
          </div>
          <div class="menu-anchor">
            <button class="icon-button" :title="t('sftpPathHistory.title')" :disabled="!connected" @click.stop="togglePathHistoryMenu"><History /></button>
            <div v-if="pathHistoryOpen" class="popover path-history-popover" @click.stop>
              <strong class="path-history-title">{{ t("sftpPathHistory.title") }}</strong>
              <button v-for="item in currentPathHistory" :key="item" class="path-item mono" :title="item" @click="goToPath(item)">{{ item }}</button>
              <div v-if="!currentPathHistory.length" class="empty compact">{{ t("sftpPathHistory.empty") }}</div>
              <!-- 书签区：点击跳转，行尾悬浮删除；全局清单（跨连接共享） -->
              <strong class="path-history-title">{{ t("sftpBookmark.title") }}</strong>
              <template v-if="sftpBookmarks.length">
                <div v-for="bookmark in sftpBookmarks" :key="bookmark.id" class="bookmark-row">
                  <button class="path-item mono" :title="`${bookmark.label} · ${bookmark.path}`" @click="goToPath(bookmark.path)">{{ bookmark.label }}</button>
                  <button class="bookmark-delete" :title="t('delete')" @click.stop="removeBookmark(bookmark)"><Trash2 /></button>
                </div>
              </template>
              <div v-else class="empty compact">{{ t("sftpBookmark.empty") }}</div>
              <strong class="path-history-title">{{ t("sftpQuickPath.title") }}</strong>
              <button v-for="item in SFTP_QUICK_PATHS" :key="item" class="path-item mono" :title="item" @click="goToPath(item)">{{ item }}</button>
            </div>
          </div>
          <button class="icon-button" :title="t('sftpPaste.action')" :disabled="!connected || !canWrite || !sftpClipboard || pasteBusy" @click="pasteClipboard"><ClipboardPaste /></button>
          <button class="icon-button icon-teal" :title="`${t('upload')} · Ctrl/Cmd+V`" :disabled="!connected || !canWrite" @click.stop="chooseUpload"><FileUp /></button>
          <button class="icon-button icon-amber" :title="t('newFolder')" :disabled="!connected || !canWrite" @click="operationDraft = ''; operationDialog = 'mkdir'"><FolderPlus /></button>
          <button class="icon-button icon-amber" :title="t('sftpNewFile.action')" :disabled="!connected || !canWrite" @click="openNewFileDialog"><FilePlus /></button>
          <label class="follow-directory-control sudo-label" :title="!canWrite ? t('readOnly') : t('sudo.modeHint')">
            <button class="switch-control" type="button" role="switch" :aria-checked="sudoMode" :disabled="!connected || !canWrite" @click="toggleSudoMode"><span /></button>
            <span>{{ t("sudo.mode") }}</span>
          </label>
        </div>
        <!-- SFTP 面板主体：左侧 tree/quick 双 tab 侧栏（可收起）+ 右侧文件区 -->
        <div class="sftp-body">
          <SideNavPanel
            :tab="sftpSideTab"
            :collapsed="sftpSideCollapsed"
            :tree-root="sftpTree"
            :quick-paths="sideQuickPaths"
            :current-path="currentPath"
            :t="t"
            @update:tab="setSftpSideTab"
            @update:collapsed="setSftpSideCollapsed"
            @navigate="goToPath"
            @toggle-node="expandSideTreeNode"
            @refresh-tree="refreshSideTree"
            @node-context="openSideMenu"
          />
          <div class="sftp-main">
          <div class="sftp-filter-bar">
            <label class="sftp-search-input">
              <Search />
              <input v-model="sftpSearch" type="search" :placeholder="t('sftpSearch.placeholder')" spellcheck="false" />
              <button v-if="sftpSearch" class="sftp-search-clear" :title="t('cancel')" @click.prevent="sftpSearch = ''"><X /></button>
            </label>
            <select v-model="sftpTypeFilter" class="sftp-type-filter" :title="t('sftpFilter.all')">
              <option value="all">{{ t("sftpFilter.all") }}</option>
              <option value="directory">{{ t("sftpFilter.folders") }}</option>
              <option value="file">{{ t("sftpFilter.files") }}</option>
            </select>
          </div>
          <div v-if="selectedUris.length > 1" class="sftp-batch-bar">
            <span>{{ t("sftpBatch.selected", { count: selectedUris.length }) }}</span>
            <template v-if="batchProgress">
              <progress class="batch-progress-bar" :value="batchProgressPercent(batchProgress)" max="100" />
              <span class="batch-progress mono">{{ t("sftpBatch.progress", { done: batchProgress.done, total: batchProgress.total }) }}</span>
            </template>
            <button :disabled="!canWrite || archiveBusy || batchDeleteSubmitting" @click="batchArchive"><Archive />{{ t("sftpBatch.archive") }}</button>
            <button class="danger" :disabled="!canWrite || archiveBusy || batchDeleteSubmitting" @click="batchDeleteOpen = true"><Trash2 />{{ t("sftpBatch.delete") }}</button>
            <button @click="clearRowSelection"><X />{{ t("sftpBatch.clear") }}</button>
          </div>
          <div class="file-table">
            <!-- 空白处右键：新建文件夹/新建文件/刷新（行右键已在 showFileMenu 内 .stop）-->
            <div class="file-rows" @contextmenu.prevent.stop="openBlankMenu({ x: $event.clientX, y: $event.clientY })">
              <div class="file-header" :style="sftpGridStyle">
                <button @click="toggleSort('name')">{{ t("name") }}<component :is="sortIcon('name')" /></button>
                <button v-if="visibleColumns.includes('size')" @click="toggleSort('size')">{{ t("size") }}<component :is="sortIcon('size')" /></button>
                <button v-if="visibleColumns.includes('modified')" @click="toggleSort('modified')">{{ t("modified") }}<component :is="sortIcon('modified')" /></button>
                <span v-if="visibleColumns.includes('permissions')">{{ t("permissions") }}</span>
              </div>
              <div v-if="loadingFiles" class="empty"><Loader2 class="spinning" />{{ t("loading") }}</div>
              <button
                v-for="entry in visibleEntries"
                v-else
                :key="entry.uri"
                class="file-row"
                :class="{ selected: selectedPath === entry.uri || selectedUris.includes(entry.uri) }"
                :style="sftpGridStyle"
                @click="selectFile(entry, $event)"
                @dblclick="openEntry(entry)"
                @contextmenu="showFileMenu($event, entry)"
                @keydown="onFileRowKeydown($event, entry)"
              >
                <span class="file-name">
                  <Folder v-if="entry.kind === 'directory'" class="folder-icon" />
                  <FileIcon v-else-if="entry.kind === 'file'" />
                  <FileText v-else />
                  <input
                    v-if="renamingPath === entry.uri"
                    v-model="renameDraft"
                    class="rename-input"
                    :disabled="renameSubmitting"
                    @click.stop
                    @dblclick.stop
                    @keydown.enter.stop="commitRename(entry)"
                    @keydown.escape.stop="renamingPath = ''"
                    @blur="commitRename(entry)"
                  />
                  <span v-else>{{ entry.name }}</span>
                </span>
                <span v-if="visibleColumns.includes('size')" class="numeric">{{ entry.kind === "file" ? formatBytes(entry.size) : "" }}</span>
                <span v-if="visibleColumns.includes('modified')">{{ formatModified(entry.modifiedAt) }}</span>
                <span v-if="visibleColumns.includes('permissions')" class="mono">{{ entry.permissions }}</span>
              </button>
              <div v-if="!loadingFiles && !visibleEntries.length" class="empty">{{ entries.length ? t("sftpSearch.noMatch") : t("emptyFolder") }}</div>
            </div>
            <footer class="file-footer"><span>{{ sftpFiltersActive ? t("sftpSearch.footerMatch", { matched: visibleEntries.length, total: entries.length }) : t("items", { count: entries.length }) }}</span><span v-if="diskUsage" :title="`${diskUsage.filesystem} → ${diskUsage.mount}`">{{ formatBytes(diskUsage.availableBytes) }} {{ t("diskFreeOf", { total: formatBytes(diskUsage.totalBytes) }) }}</span><span>{{ currentPath }}</span></footer>
          </div>
          </div>
        </div>
        <div v-if="dragActive" class="drop-overlay"><FileUp /><strong>{{ t("upload") }}</strong></div>
      </section>
    </section>

    <nav v-if="terminalMenu" class="context-menu" :style="{ left: terminalMenu.x + 'px', top: terminalMenu.y + 'px' }" @click.stop>
      <button :disabled="!terminal?.hasSelection()" @click="copyTerminalSelection"><Copy />{{ t("terminalCopy") }}</button>
      <button :disabled="!connected || terminalTransferBusy" @click="pasteTerminal"><ClipboardPaste />{{ t("terminalPaste") }}</button>
      <button @click="selectAllTerminal"><TextSelect />{{ t("terminalSelectAll") }}</button>
      <button @click="openTerminalSearch"><Search />{{ t("terminalSearch.open") }}</button>
      <button @click="clearTerminal"><Eraser />{{ t("terminalClear") }}</button>
      <button :disabled="!connected" @click="sendSudoRefresh"><ShieldCheck />{{ t("sudoRefresh.title") }}</button>
      <hr />
      <button :disabled="!connected || terminalTransferBusy || !canWrite" @click="chooseZmodem"><FileUp />{{ t("zmodemUpload") }}</button>
      <button :disabled="!connected || terminalTransferBusy || !canWrite" @click="chooseTrzszUpload"><FileUp />{{ t("trzszUpload") }}</button>
    </nav>

    <nav v-if="fileMenu" class="context-menu" :style="{ left: fileMenu.x + 'px', top: fileMenu.y + 'px' }" @click.stop>
      <!-- 多选感知：右键时已多选（selection > 1）→ 菜单整体切换为批量区，单项动作隐藏 -->
      <template v-if="fileMenu.selection.length > 1">
        <button :disabled="!canWrite || archiveBusy || batchDeleteSubmitting" @click="fileMenu = undefined; batchArchive()"><Archive />{{ t("sftpBatch.archive") }}</button>
        <button class="danger" :disabled="!canWrite || archiveBusy || batchDeleteSubmitting" @click="fileMenu = undefined; batchDeleteOpen = true"><Trash2 />{{ t("sftpBatch.delete") }}</button>
        <hr />
        <button @click="copySelectedPaths"><Copy />{{ t("sftpCopy.copySelected") }}</button>
      </template>
      <template v-else>
        <button v-if="fileMenu.entry.kind === 'directory' || fileMenu.entry.kind === 'file'" @click="openEntry(fileMenu.entry)"><Folder v-if="fileMenu.entry.kind === 'directory'" /><FileText v-else />{{ fileMenu.entry.kind === "directory" ? t("openFolder") : t("preview") }}</button>
        <button v-if="fileMenu.entry.kind === 'file'" @click="downloadEntry(fileMenu.entry)"><Download />{{ t("download") }}</button>
        <button :disabled="!canWrite" @click="beginRename(fileMenu.entry); fileMenu = undefined"><Pencil />{{ t("rename") }}</button>
        <button @click="copySelectedEntries('copy')"><Copy />{{ t("sftpCopy.copy") }}</button>
        <button :disabled="!canWrite" @click="copySelectedEntries('cut')"><Scissors />{{ t("sftpCopy.cut") }}</button>
        <hr />
        <button @click="copyTextToClipboard(pathFromUri(fileMenu.entry.uri), 'sftpCopy.copiedPath'); fileMenu = undefined"><Copy />{{ t("sftpCopy.copyPath") }}</button>
        <button @click="copyTextToClipboard(fileMenu.entry.name, 'sftpCopy.copiedName'); fileMenu = undefined"><FileText />{{ t("sftpCopy.copyName") }}</button>
        <hr />
        <button :disabled="!canWrite" @click="beginChmod(fileMenu.entry)"><Lock />{{ t("permissionsEdit") }}</button>
        <button @click="openAttributes(fileMenu.entry)"><Info />{{ t("sftpAttrs.action") }}</button>
        <button v-if="fileMenu.entry.kind === 'directory' || (fileMenu.entry.kind === 'file' && !isArchiveName(fileMenu.entry.name))" :disabled="!canWrite || archiveBusy" @click="archiveEntry(fileMenu.entry)"><Archive />{{ t("archive.action") }}</button>
        <button v-if="fileMenu.entry.kind === 'file' && isArchiveName(fileMenu.entry.name)" :disabled="!canWrite || archiveBusy" @click="extractEntry(fileMenu.entry)"><PackageOpen />{{ t("extract.action") }}</button>
        <hr />
        <button class="danger" :disabled="!canWrite" @click="deleteTarget = fileMenu.entry; fileMenu = undefined"><Trash2 />{{ t("delete") }}</button>
      </template>
    </nav>

    <nav v-if="transferHistoryMenu" class="context-menu" :style="{ left: transferHistoryMenu.x + 'px', top: transferHistoryMenu.y + 'px' }" @click.stop>
      <button @click="revealTransferTarget(transferHistoryMenu.path); transferHistoryMenu = undefined"><FolderOpen />{{ t("revealInFolder") }}</button>
      <button @click="openTransferTarget(transferHistoryMenu.path); transferHistoryMenu = undefined"><FileText />{{ t("openDownloadedFile") }}</button>
    </nav>

    <!-- 侧栏（目录树/快捷路径）行右键：打开 / 复制路径 / 复制文件名 / 压缩 -->
    <nav v-if="sideMenu" class="context-menu" :style="{ left: sideMenu.x + 'px', top: sideMenu.y + 'px' }" @click.stop>
      <button @click="sideMenuAction('open')"><Folder />{{ t("openFolder") }}</button>
      <button @click="sideMenuAction('copyPath')"><Copy />{{ t("sftpCopy.copyPath") }}</button>
      <button @click="sideMenuAction('copyName')"><FileText />{{ t("sftpCopy.copyName") }}</button>
      <button :disabled="!canWrite || archiveBusy" @click="sideMenuAction('archive')"><Archive />{{ t("archive.action") }}</button>
    </nav>

    <!-- 文件列表空白处右键：新建文件夹 / 新建文件 / 刷新 -->
    <nav v-if="blankMenu" class="context-menu" :style="{ left: blankMenu.x + 'px', top: blankMenu.y + 'px' }" @click.stop>
      <button :disabled="!canWrite" @click="blankMenuAction('mkdir')"><FolderPlus />{{ t("newFolder") }}</button>
      <button :disabled="!canWrite" @click="blankMenuAction('newFile')"><FilePlus />{{ t("sftpNewFile.action") }}</button>
      <button :disabled="!connected || loadingFiles" @click="blankMenuAction('refresh')"><RefreshCw />{{ t("refresh") }}</button>
    </nav>

    <section v-if="previewOpen" class="modal-backdrop" @mousedown.self="closePreview">
      <article class="modal preview-modal">
        <header>
          <h2>
            {{ previewTitle }}
            <span v-if="previewDirty" class="preview-dirty"><span class="preview-dirty-dot" />{{ t("editSave.unsaved") }}</span>
            <span v-else-if="previewTruncated" class="preview-truncated-badge">{{ t("previewDialog.truncated", { limit: formatBytes(MAX_INLINE_PREVIEW_BYTES), size: formatBytes(previewSize) }) }}</span>
          </h2>
          <div v-if="previewEditableAllowed" class="preview-actions">
            <template v-if="!previewEditable">
              <button :title="t('editSave.edit')" @click="beginPreviewEdit"><Pencil />{{ t("editSave.edit") }}</button>
            </template>
            <template v-else>
              <button :title="t('cancel')" @click="cancelPreviewEdit">{{ t("cancel") }}</button>
              <button :title="t('editSave.save')" :disabled="previewSaving" @click="savePreview"><Loader2 v-if="previewSaving" class="spinning" /><Save v-else />{{ t("editSave.save") }}</button>
            </template>
          </div>
          <button :title="t('close')" class="icon-button" @click="closePreview"><X /></button>
        </header>
        <div v-if="previewLoading" class="empty"><Loader2 class="spinning" />{{ t("loading") }}</div>
        <div v-else-if="previewMode === 'image'" class="preview-image-stage">
          <img class="preview-image" :class="{ 'preview-image--full': previewImageZoomed }" :src="previewImageUrl" :alt="previewTitle" :title="previewImageZoomed ? t('imagePreview.zoomOut') : t('imagePreview.zoomIn')" @click="previewImageZoomed = !previewImageZoomed" />
        </div>
        <TextPreview v-else :text="previewText" :file-name="previewTitle" :appearance="appearance" :editable="previewEditable" @change="previewDraft = $event" />
      </article>
    </section>

    <section v-if="operationDialog === 'mkdir'" class="modal-backdrop" @mousedown.self="operationDialog = null">
      <article class="modal small-modal">
        <header><h2>{{ t("newFolder") }}</h2><button :title="t('close')" class="icon-button" @click="operationDialog = null"><X /></button></header>
        <input v-model="operationDraft" autofocus @keydown.enter="createDirectory" />
        <footer><button @click="operationDialog = null">{{ t("cancel") }}</button><button class="primary-button" :disabled="!operationDraft.trim()" @click="createDirectory">{{ t("confirm") }}</button></footer>
      </article>
    </section>

    <section v-if="commandOpen" class="modal-backdrop" @mousedown.self="commandOpen = false">
      <article class="modal command-modal">
        <header><h2>{{ t("commandTitle") }}</h2><button :title="t('close')" class="icon-button" @click="commandOpen = false"><X /></button></header>
        <textarea
          v-model="commandDraft"
          class="mono"
          rows="5"
          spellcheck="false"
          autofocus
          :placeholder="t('commandPlaceholder')"
          :disabled="commandRunning"
          @keydown="handleCommandInputKeydown"
        />
        <div v-if="commandHistory.length" class="command-history">
          <div class="command-history-header">
            <span>{{ t("commandHistoryTitle") }}</span>
            <button class="link-button" @click="clearCommandHistory">{{ t("commandHistoryClear") }}</button>
          </div>
          <div class="command-history-list">
            <button
              v-for="item in commandHistory"
              :key="item"
              class="command-history-item mono"
              :title="t('commandHistoryResend')"
              @click="rerunHistoryCommand(item)"
            >{{ item }}</button>
          </div>
        </div>
        <label class="quick-sudo-control" :title="t('quickSudoHint')">
          <button class="switch-control" type="button" role="switch" :aria-checked="commandUseSudo" :disabled="commandRunning" @click="commandUseSudo = !commandUseSudo"><span /></button>
          <span>{{ t("quickSudo") }}</span>
        </label>
        <div v-if="commandRunning" class="command-output"><Loader2 class="spinning" /><span>{{ t("commandRunning") }}</span></div>
        <pre v-else-if="commandResult" class="command-output mono">{{ commandOutputText || t("commandNoOutput") }}<span class="command-exit">exit {{ commandResult.exitCode }}</span></pre>
        <p v-if="commandError" class="task-error">{{ commandError }}</p>
        <footer>
          <button @click="commandOpen = false">{{ t("close") }}</button>
          <button v-if="commandRunning" @click="cancelCommand"><X />{{ t("commandCancel") }}</button>
          <button class="primary-button" :disabled="!commandDraft.trim() || commandRunning" @click="runCommand">
            <Loader2 v-if="commandRunning" class="spinning" />
            <SquareTerminal v-else />
            {{ t("commandRun") }}
          </button>
        </footer>
      </article>
    </section>

    <section v-if="chmodTarget" class="modal-backdrop" @mousedown.self="chmodTarget = undefined">
      <article class="modal small-modal">
        <header><h2>{{ t("permissionsEdit") }} · {{ chmodTarget.name }}</h2><button :title="t('close')" class="icon-button" @click="chmodTarget = undefined"><X /></button></header>
        <div class="perm-matrix" role="group" :aria-label="t('permissionsEdit')">
          <span></span>
          <span v-for="column in PERM_COLUMNS" :key="column.bit" class="perm-matrix-head">{{ t(column.key) }}</span>
          <template v-for="role in PERM_ROLES" :key="role.who">
            <span class="perm-matrix-role">{{ t(role.key) }}</span>
            <label v-for="column in PERM_COLUMNS" :key="column.bit" class="perm-matrix-cell">
              <input type="checkbox" :checked="permBit(chmodDraft, role.who, column.bit)" @change="toggleChmodPerm(role.who, column.bit, $event)" />
            </label>
          </template>
        </div>
        <input v-model="chmodDraft" class="mono" spellcheck="false" :placeholder="t('permissionsPlaceholder')" @keydown.enter="confirmChmod" />
        <p class="muted">{{ t("permissionsHint") }}</p>
        <footer><button @click="chmodTarget = undefined">{{ t("cancel") }}</button><button class="primary-button" :disabled="!chmodDraft.trim() || chmodSubmitting" @click="confirmChmod">{{ t("confirm") }}</button></footer>
      </article>
    </section>

    <section v-if="deleteTarget" class="modal-backdrop" @mousedown.self="deleteTarget = undefined">
      <article class="modal small-modal destructive-modal">
        <header><h2>{{ t("deleteTitle") }}</h2><button :title="t('close')" class="icon-button" @click="deleteTarget = undefined"><X /></button></header>
        <div class="destructive-copy"><span class="destructive-icon"><Trash2 /></span><div><strong>{{ deleteTarget.name }}</strong><p class="muted">{{ t("deleteMessage") }}</p></div></div>
        <footer><button @click="deleteTarget = undefined">{{ t("cancel") }}</button><button class="danger-button" :disabled="deleteSubmitting" @click="confirmDelete"><Trash2 />{{ t("delete") }}</button></footer>
      </article>
    </section>

    <section v-if="batchDeleteOpen" class="modal-backdrop" @mousedown.self="batchDeleteOpen = false">
      <article class="modal small-modal destructive-modal">
        <header><h2>{{ t("sftpBatch.deleteTitle") }}</h2><button :title="t('close')" class="icon-button" @click="batchDeleteOpen = false"><X /></button></header>
        <div class="destructive-copy"><span class="destructive-icon"><Trash2 /></span><div><strong>{{ t("sftpBatch.selected", { count: selectedEntries.length }) }}</strong><p class="muted">{{ t("sftpBatch.deleteMessage") }}</p></div></div>
        <div v-if="batchProgress" class="batch-progress-row"><progress class="batch-progress-bar" :value="batchProgressPercent(batchProgress)" max="100" /><span class="batch-progress mono">{{ t("sftpBatch.progress", { done: batchProgress.done, total: batchProgress.total }) }}</span></div>
        <footer><button @click="batchDeleteOpen = false" :disabled="batchDeleteSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="batchDeleteSubmitting" @click="confirmBatchDelete"><Loader2 v-if="batchDeleteSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
      </article>
    </section>

    <!-- 录制删除确认：应用内弹窗替代 window.confirm（宿主沙箱 iframe 无 allow-modals，confirm 恒 false） -->
    <!-- 下载/导出前的保存目录选择（设置里开启「每次询问」时出现） -->
    <section v-if="downloadPrompt" class="modal-backdrop" @mousedown.self="resolveDownloadPrompt(undefined)">
      <article class="modal small-modal">
        <header><h2>{{ t("downloadSettings.askTitle") }}</h2><button class="icon-button" :title="t('close')" @click="resolveDownloadPrompt(undefined)"><X /></button></header>
        <p class="muted mono">{{ downloadPrompt.fileName }}</p>
        <label class="settings-field">
          <span>{{ t("downloadSettings.directory") }}</span>
          <span class="settings-dir-row">
            <input v-model="downloadPrompt.dir" class="mono" spellcheck="false" autofocus @keydown.enter="resolveDownloadPrompt({ dir: downloadPrompt.dir, setDefault: downloadPrompt.setDefault })" />
            <button v-if="localCanSave" type="button" class="browse-button" :title="t('downloadSettings.browse')" :aria-label="t('downloadSettings.browse')" @click="folderPickerTarget = 'prompt'"><FolderOpen /></button>
          </span>
        </label>
        <label class="settings-field settings-switch-row">
          <input v-model="downloadPrompt.setDefault" type="checkbox" />
          <span>{{ t("downloadSettings.setDefaultThisTime") }}</span>
        </label>
        <p class="muted settings-note">{{ t("downloadSettings.askHint") }}</p>
        <footer>
          <button @click="resolveDownloadPrompt(undefined)">{{ t("cancel") }}</button>
          <button class="primary-button" @click="resolveDownloadPrompt({ dir: downloadPrompt.dir, setDefault: downloadPrompt.setDefault })">{{ t("save") }}</button>
        </footer>
      </article>
    </section>

    <!-- 「询问我」冲突策略：目标目录已有同名文件时的选择 -->
    <section v-if="downloadConflictPrompt" class="modal-backdrop" @mousedown.self="resolveDownloadConflict(undefined)">
      <article class="modal small-modal">
        <header><h2>{{ t("downloadConflict.title") }}</h2><button class="icon-button" :title="t('close')" @click="resolveDownloadConflict(undefined)"><X /></button></header>
        <p>{{ t("downloadConflict.message", { name: downloadConflictPrompt.fileName }) }}</p>
        <p class="muted mono">{{ downloadConflictPrompt.path }}</p>
        <footer>
          <button @click="resolveDownloadConflict(undefined)">{{ t("cancel") }}</button>
          <button class="danger-button" @click="resolveDownloadConflict('overwrite')">{{ t("downloadSettings.conflict.overwrite") }}</button>
          <button class="primary-button" @click="resolveDownloadConflict('rename')">{{ t("downloadSettings.conflict.rename") }}</button>
        </footer>
      </article>
    </section>

    <section v-if="recordingDeleteTarget" class="modal-backdrop" @mousedown.self="recordingDeleteTarget = null">
      <article class="modal small-modal destructive-modal">
        <header><h2>{{ t("recordingDelete") }}</h2><button :title="t('close')" class="icon-button" @click="recordingDeleteTarget = null"><X /></button></header>
        <div class="destructive-copy"><span class="destructive-icon"><Trash2 /></span><div><strong>{{ t("recordingDeleteConfirm", { host: recordingDeleteTarget.host || recordingDeleteTarget.recordingId }) }}</strong><p class="muted">{{ formatRecordedAt(recordingDeleteTarget.startedAt) }} · {{ formatDuration(recordingDeleteTarget.durationSecs ?? 0) }}</p></div></div>
        <footer><button @click="recordingDeleteTarget = null" :disabled="recordingDeleteSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="recordingDeleteSubmitting" @click="confirmRecordingDelete"><Loader2 v-if="recordingDeleteSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
      </article>
    </section>

    <!-- 录制一键清空确认：应用内弹窗（沙箱 iframe confirm 恒 false） -->
    <section v-if="recordingClearAllOpen" class="modal-backdrop" @mousedown.self="recordingClearAllOpen = false">
      <article class="modal small-modal destructive-modal">
        <header><h2>{{ t("recordingsClear") }}</h2><button :title="t('close')" class="icon-button" @click="recordingClearAllOpen = false"><X /></button></header>
        <div class="destructive-copy"><span class="destructive-icon"><Trash2 /></span><div><strong>{{ t("recordingsClearConfirm", { count: recordings.length }) }}</strong></div></div>
        <footer><button @click="recordingClearAllOpen = false" :disabled="recordingClearAllSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="recordingClearAllSubmitting" @click="confirmRecordingClearAll"><Loader2 v-if="recordingClearAllSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
      </article>
    </section>

    <section v-if="newFileDialog" class="modal-backdrop" @mousedown.self="newFileDialog = false">
      <article class="modal small-modal">
        <header><h2>{{ t("sftpNewFile.title") }}</h2><button :title="t('close')" class="icon-button" @click="newFileDialog = false"><X /></button></header>
        <input v-model="newFileDraft" autofocus spellcheck="false" :placeholder="t('sftpNewFile.placeholder')" @keydown.enter="createNewFile" />
        <footer><button @click="newFileDialog = false">{{ t("cancel") }}</button><button class="primary-button" :disabled="!newFileDraft.trim() || newFileSubmitting" @click="createNewFile"><Loader2 v-if="newFileSubmitting" class="spinning" />{{ t("confirm") }}</button></footer>
      </article>
    </section>

    <section v-if="attrsTarget" class="modal-backdrop" @mousedown.self="closeAttributes">
      <article class="modal small-modal attrs-modal">
        <header><h2>{{ t("sftpAttrs.title") }} · {{ attrsTarget.name }}</h2><button :title="t('close')" class="icon-button" @click="closeAttributes"><X /></button></header>
        <div v-if="attrsLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
        <template v-else-if="attrsInfo">
          <dl class="attrs-grid">
            <dt>{{ t("sftpAttrs.path") }}</dt><dd class="mono">{{ attrsInfo.path }}</dd>
            <dt>{{ t("sftpAttrs.type") }}</dt><dd>{{ t(`sftpAttrs.kind.${attrsInfo.kind}`) }}</dd>
            <dt>{{ t("size") }}</dt><dd class="numeric">{{ attrsInfo.kind === "directory" ? "–" : formatBytes(attrsInfo.size || 0) }}</dd>
            <dt>{{ t("sftpAttrs.permissions") }}</dt><dd class="mono">{{ attrsInfo.mode || "–" }}</dd>
            <dt>{{ t("sftpAttrs.owner") }}</dt><dd>{{ [attrsInfo.owner, attrsInfo.group].filter(Boolean).join(":") || "–" }}</dd>
            <dt>{{ t("sftpAttrs.modified") }}</dt><dd>{{ formatModified(attrsInfo.modifiedAt) || "–" }}</dd>
          </dl>
          <div class="perm-matrix" role="group" :aria-label="t('sftpAttrs.permissions')">
            <span></span>
            <span v-for="column in PERM_COLUMNS" :key="column.bit" class="perm-matrix-head">{{ t(column.key) }}</span>
            <template v-for="role in PERM_ROLES" :key="role.who">
              <span class="perm-matrix-role">{{ t(role.key) }}</span>
              <label v-for="column in PERM_COLUMNS" :key="column.bit" class="perm-matrix-cell">
                <input type="checkbox" :disabled="!canWrite" :checked="permBit(attrsMode, role.who, column.bit)" @change="toggleAttrsPerm(role.who, column.bit, $event)" />
              </label>
            </template>
          </div>
          <label class="attrs-permissions-edit">
            <span>{{ t("sftpAttrs.permissions") }}</span>
            <input v-model="attrsMode" class="mono" spellcheck="false" :placeholder="t('permissionsPlaceholder')" :disabled="!canWrite" @keydown.enter="saveAttributesPermissions" />
          </label>
          <p class="muted">{{ t("permissionsHint") }}</p>
        </template>
        <footer>
          <button @click="closeAttributes">{{ t("close") }}</button>
          <button class="primary-button" :disabled="!canWrite || !attrsMode.trim() || attrsSubmitting" @click="saveAttributesPermissions"><Loader2 v-if="attrsSubmitting" class="spinning" />{{ t("sftpAttrs.save") }}</button>
        </footer>
      </article>
    </section>

    <section v-if="settingsOpen" class="modal-backdrop" @mousedown.self="settingsOpen = false">
      <article class="modal settings-modal settings-nav-modal">
        <header><h2>{{ t("settings") }}</h2><button :title="t('close')" class="icon-button" @click="settingsOpen = false"><X /></button></header>
        <div class="settings-body">
          <div v-if="settingsLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <div v-else-if="settingsLoadFailed" class="task-error" role="alert">
            {{ t("settingsLoadFailed") }}
            <button class="link-button" @click="openSettings">{{ t("refresh") }}</button>
          </div>
          <template v-else>
          <div class="settings-layout">
            <nav class="settings-nav" aria-label="settings categories">
              <button v-for="cat in SETTINGS_CATEGORIES" :key="cat.id" type="button" :class="{ 'is-active': settingsCategory === cat.id }" @click="settingsCategory = cat.id">{{ t(cat.labelKey) }}</button>
            </nav>
            <div class="settings-content">
            <div v-show="settingsCategory === 'sudo'" class="settings-pane">
            <label class="settings-field">
              <span>{{ t("settingsCredentialSource") }}</span>
              <span class="credential-source-row">
                <select v-model="settingsDraft.quickSudoProfileId">
                  <option value="">{{ t("profileSourceConnection") }}</option>
                  <option v-for="profile in sudoProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
                </select>
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
                  <select v-model="profileDraft.authFlowMode">
                    <option value="off">{{ t("flowOff") }}</option>
                    <option value="password_then_otp">{{ t("flowThenOtp") }}</option>
                    <option value="password_plus_otp">{{ t("flowPlusOtp") }}</option>
                    <option value="password_only">{{ t("flowOnly") }}</option>
                  </select>
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
                  <button class="switch-control" type="button" role="switch" :aria-checked="profileDraft.sudoUsePty" @click="profileDraft.sudoUsePty = !profileDraft.sudoUsePty"><span /></button>
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
              <button class="switch-control" type="button" role="switch" :aria-checked="settingsDraft.quickSudo" @click="settingsDraft.quickSudo = !settingsDraft.quickSudo"><span /></button>
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
              <select v-model="settingsDraft.authFlowMode">
                <option value="off">{{ t("flowOff") }}</option>
                <option value="password_then_otp">{{ t("flowThenOtp") }}</option>
                <option value="password_plus_otp">{{ t("flowPlusOtp") }}</option>
                <option value="password_only">{{ t("flowOnly") }}</option>
              </select>
            </label>
            <label class="settings-field">
              <span>{{ t("settingsPasswordHint") }}</span>
              <input v-model="settingsDraft.passwordPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
            </label>
            <label class="settings-field">
              <span>{{ t("settingsTotpHint") }}</span>
              <input v-model="settingsDraft.totpPromptHint" spellcheck="false" :placeholder="t('settingsHintPlaceholder')" />
            </label>
            <label class="quick-sudo-control">
              <button class="switch-control" type="button" role="switch" :aria-checked="settingsDraft.sudoUsePty" @click="settingsDraft.sudoUsePty = !settingsDraft.sudoUsePty"><span /></button>
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
              <select v-model="settingsDraft.agentTerminalMode">
                <option v-for="mode in AGENT_MODES" :key="mode" :value="mode">{{ t(`agentTerminal${mode === "off" ? "Off" : mode === "auto" ? "Auto" : "Strict"}`) }}</option>
              </select>
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
                <button v-if="localCanSave" type="button" class="browse-button" :title="t('downloadSettings.browse')" :aria-label="t('downloadSettings.browse')" @click="folderPickerTarget = 'settings'"><FolderOpen /></button>
              </span>
            </label>
            <label class="settings-field settings-switch-row">
              <button class="switch-control" type="button" role="switch" :aria-checked="downloadUseDefaultDraft" @click="downloadUseDefaultDraft = !downloadUseDefaultDraft"><span /></button>
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
            </div>

            <div v-show="settingsCategory === 'terminal'" class="settings-pane">
            <h3 class="settings-section-title">{{ t("webglSection") }}</h3>
            <label class="settings-field settings-switch-row">
              <button class="switch-control" type="button" role="switch" :aria-checked="webglEnabled" @click="setWebglEnabled(!webglEnabled)"><span /></button>
              <span>{{ t("webglLabel") }}</span>
            </label>
            <p class="muted settings-note">{{ t("webglHint") }}</p>

            <h3 class="settings-section-title">{{ t("terminalSelectCopy.section") }}</h3>
            <label class="quick-sudo-control">
              <button class="switch-control" type="button" role="switch" :aria-checked="termSelectCopy" @click="toggleSelectCopy"><span /></button>
              <span>{{ t("terminalSelectCopy.label") }}</span>
            </label>
            <p class="muted settings-note">{{ t("terminalSelectCopy.hint") }}</p>
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
              <select v-model="mcpDraft.permissionMode">
                <option value="autonomous">{{ t("mcpSettings.permissionModeAutonomous") }}</option>
                <option value="confirm">{{ t("mcpSettings.permissionModeConfirm") }}</option>
              </select>
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
          <button @click="settingsOpen = false">{{ t("close") }}</button>
          <button class="primary-button" :disabled="settingsLoading || settingsLoadFailed || settingsSaving || !settingsMeta" @click="saveSettings"><Loader2 v-if="settingsSaving" class="spinning" />{{ t("settingsSave") }}</button>
        </footer>
      </article>
    </section>

    <section v-if="auditOpen" class="modal-backdrop" @mousedown.self="auditOpen = false">
      <article class="modal settings-modal audit-modal">
        <header><h2>{{ t("auditLog.title") }}</h2><button :title="t('close')" class="icon-button" @click="auditOpen = false"><X /></button></header>
        <div class="settings-body">
          <div class="audit-toolbar">
            <label class="highlight-editor-flag">
              <span>{{ t("auditLog.kindFilter") }}</span>
              <select v-model="auditKindFilter">
                <option value="">{{ t("auditLog.kindAll") }}</option>
                <option v-for="kind in auditKindOptions(auditEntries)" :key="kind" :value="kind">{{ auditKindLabel(kind, t) }}</option>
              </select>
            </label>
            <button class="icon-button" :title="t('refresh')" :disabled="auditLoading" @click="loadAuditEntries"><RefreshCw :class="{ spinning: auditLoading }" /></button>
            <button class="icon-button" :title="t('auditLog.clear')" @click="clearAuditLog"><Trash2 /></button>
          </div>
          <div v-if="auditLoading && !auditEntries.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <div v-else-if="auditLoadFailed" class="empty compact">
            <span>{{ t("auditLog.loadFailed") }}</span>
            <button class="link-button" @click="loadAuditEntries">{{ t("refresh") }}</button>
          </div>
          <div v-else-if="!visibleAuditEntries.length" class="empty compact">{{ t("auditLog.empty") }}</div>
          <template v-else>
            <ul class="audit-list">
              <li v-for="(entry, index) in visibleAuditEntries" :key="`${entry.ts}-${entry.kind}-${index}`" class="audit-row">
                <span class="audit-time mono">{{ auditTime(entry.ts) }}</span>
                <span class="audit-kind-badge" :class="auditRowKindClass(entry.kind)">{{ auditKindLabel(entry.kind, t) }}</span>
                <span v-if="entry.connection || entry.sessionId" class="audit-connection mono" :title="entry.connection || entry.sessionId">{{ entry.connection || entry.sessionId }}</span>
                <span v-if="entry.command" class="audit-command mono" :title="entry.command">{{ entry.command }}</span>
                <span v-if="entry.output" class="audit-output mono" :title="entry.output">{{ entry.output }}</span>
                <span v-if="entry.gate" class="audit-gate mono">{{ entry.gate }}</span>
                <span v-if="auditOutcomeLabel(entry, t)" class="audit-outcome" :class="{ error: entry.outcome === 'error' || entry.decision === 'denied' || entry.decision === 'timeout', ok: entry.outcome === 'ok' || entry.decision === 'approved' }">{{ auditOutcomeLabel(entry, t) }}</span>
                <span v-if="entry.exitCode != null" class="audit-time">{{ t("auditLog.exitCode", { code: entry.exitCode }) }}</span>
              </li>
            </ul>
            <p v-if="auditTruncated" class="muted audit-truncated">{{ t("auditLog.truncated") }}</p>
          </template>
        </div>
        <footer><button @click="auditOpen = false">{{ t("close") }}</button></footer>
      </article>
    </section>

    <section v-if="profilesOpen" class="modal-backdrop" @mousedown.self="profilesOpen = false">
      <article class="modal settings-modal">
        <header><h2>{{ t("profilesTitle") }}</h2><button :title="t('close')" class="icon-button" @click="profilesOpen = false"><X /></button></header>
        <div class="settings-body">
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
              <select v-model="profileDraft.authFlowMode">
                <option value="password_then_otp">{{ t("flowThenOtp") }}</option>
                <option value="password_plus_otp">{{ t("flowPlusOtp") }}</option>
                <option value="password_only">{{ t("flowOnly") }}</option>
              </select>
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
              <button class="switch-control" type="button" role="switch" :aria-checked="profileDraft.sudoUsePty" @click="profileDraft.sudoUsePty = !profileDraft.sudoUsePty"><span /></button>
              <span>{{ t("settingsUsePty") }}</span>
            </label>
            <p v-if="sudoProfilesError" class="task-error">{{ sudoProfilesError }}</p>
            <footer class="profiles-form-actions">
              <button @click="cancelProfileEdit">{{ t("cancel") }}</button>
              <button class="primary-button" :disabled="profileSaving || !profileDraft.name.trim()" @click="saveProfileDraft"><Loader2 v-if="profileSaving" class="spinning" />{{ t("save") }}</button>
            </footer>
          </template>
        </div>
        <footer><button @click="profilesOpen = false">{{ t("close") }}</button></footer>
      </article>
    </section>
    <section v-if="hostKeyPrompt" class="modal-backdrop">
      <article class="modal host-key-modal">
        <header><h2>{{ t("hostKeyDialog.title") }}</h2></header>
        <p>{{ t("hostKeyDialog.desc") }}</p>
        <dl><dt>{{ t("hostKeyDialog.server") }}</dt><dd>{{ hostKeyPrompt.host }}:{{ hostKeyPrompt.port }}</dd><dt>{{ t("hostKeyDialog.keyType") }}</dt><dd>{{ hostKeyPrompt.keyType }}</dd><dt>{{ t("hostKeyDialog.fingerprint") }}</dt><dd class="fingerprint">{{ hostKeyPrompt.fingerprint }}</dd></dl>
        <label class="remember"><input v-model="rememberHostKey" type="checkbox" /> {{ t("hostKeyDialog.remember") }}</label>
        <footer><button @click="resolveHostKey(false)">{{ t("hostKeyDialog.reject") }}</button><button class="primary-button" @click="resolveHostKey(true)">{{ t("hostKeyDialog.trust") }}</button></footer>
      </article>
    </section>

    <section v-if="agentPromptHead" class="modal-backdrop">
      <article class="modal agent-prompt-modal">
        <header><h2>{{ agentPromptHead.source === "mcp" ? t("agentPrompt.mcpSource", { tool: agentPromptHead.tool }) : t("agentPromptTitle") }}</h2></header>
        <div class="agent-prompt-meta">
          <span>{{ t("agentPromptSource") }} <code class="mono">{{ agentPromptHead.tool }}</code></span>
          <span class="agent-risk-badge" :class="agentPromptHead.risk === 'elevated' ? 'elevated' : 'low'">{{ agentPromptHead.risk === "elevated" ? t("agentPromptRiskElevated") : t("agentPromptRiskLow") }}</span>
        </div>
        <label class="agent-prompt-command">
          <span>{{ t("agentPromptCommandLabel") }}</span>
          <textarea v-model="agentPromptCommand" class="mono" rows="3" spellcheck="false" />
        </label>
        <!-- 记住不限风险档：strict 模式下低危命令同样每次弹审、同样需要免审
             记忆（IMPL_PLAN 预期 strict/auto 下 approve+remember 二次零弹窗）；
             破坏性命令由后端 D2 兜底忽略 remember。 -->
        <label class="agent-prompt-remember">
          <input v-model="agentPromptRemember" type="checkbox" />
          <span>{{ t("approval.remember") }}</span>
        </label>
        <p class="muted agent-prompt-countdown">{{ t("agentPromptTimeoutHint", { seconds: Math.ceil(agentPromptRemaining) }) }}</p>
        <footer><button @click="resolveAgentPrompt('deny')">{{ t("agentPromptDeny") }}</button><button class="primary-button" @click="resolveAgentPrompt('approve')">{{ t("agentPromptApprove") }}</button></footer>
      </article>
    </section>

    <!-- 告警排查：异构告警 → 结构化 + 分类 + 只读诊断命令清单 -->
    <section v-if="alertTriageOpen" class="modal-backdrop" @mousedown.self="alertTriageOpen = false">
      <article class="modal alert-triage-modal">
        <header>
          <h2>{{ t("alertTriage.title") }}</h2>
          <button :title="t('close')" class="icon-button" @click="alertTriageOpen = false"><X /></button>
        </header>
        <p class="muted alert-triage-hint">{{ t("alertTriage.hint") }}</p>
        <textarea v-model="alertTriagePayload" class="mono alert-triage-payload" rows="6" :placeholder="t('alertTriage.placeholder')" :disabled="alertTriageBusy" spellcheck="false" autofocus />
        <p v-if="alertTriageError" class="task-error" role="alert">{{ alertTriageError }}</p>
        <footer class="alert-triage-actions">
          <button class="primary-button" :disabled="alertTriageBusy || !sanitizeTriagePayload(alertTriagePayload)" @click="runAlertTriage">{{ t("alertTriage.analyze") }}</button>
        </footer>
        <div v-if="alertTriageBusy" class="empty compact" role="status"><Loader2 class="spinning" />{{ t("loading") }}</div>
        <div v-else-if="!alertTriageResult && !alertTriageError" class="empty compact">{{ t("alertTriage.emptyResult") }}</div>
        <div v-else-if="alertTriageResult" class="alert-triage-result">
          <div class="alert-triage-summary">
            <span class="alert-severity-badge" :class="severityClass(alertTriageResult.normalized.severity)">{{ t(`alertTriage.severity.${severityClass(alertTriageResult.normalized.severity)}`) }}</span>
            <span class="alert-category">{{ t(`alertTriage.category.${alertTriageResult.category}`) }}</span>
            <strong v-if="alertTriageResult.normalized.title" class="alert-title">{{ alertTriageResult.normalized.title }}</strong>
          </div>
          <p v-if="alertTriageResult.normalized.message" class="muted alert-message mono">{{ alertTriageResult.normalized.message }}</p>
          <p v-if="!alertTriageResult.suggestions.length" class="muted">{{ t("alertTriage.emptyResult") }}</p>
          <ul v-else class="alert-suggestion-list">
            <li v-for="suggestion in alertTriageResult.suggestions" :key="suggestion.command" class="alert-suggestion-row">
              <code class="mono alert-suggestion-command">{{ suggestion.command }}</code>
              <span class="alert-purpose muted">{{ purposeKeyLabel(suggestion.purposeKey, t) }}</span>
              <button :disabled="!session" :title="!session ? t('alertTriage.noSession') : ''" @click="sendSuggestionToTerminal(suggestion.command)">{{ t("alertTriage.sendToTerminal") }}</button>
            </li>
          </ul>
          <footer v-if="alertTriageResult.suggestions.length" class="alert-triage-actions">
            <button @click="copySuggestions">{{ t("alertTriage.copyAll") }}</button>
          </footer>
        </div>
      </article>
    </section>

    <section v-if="pasteConfirm" class="modal-backdrop" @mousedown.self="resolvePasteConfirm(false)">
      <article class="modal small-modal" :class="{ 'destructive-modal': pasteConfirm.danger }">
        <header>
          <h2>{{ pasteConfirm.danger ? t("terminalDanger.title") : t("terminalPasteConfirm.title") }}</h2>
          <button :title="t('close')" class="icon-button" @click="resolvePasteConfirm(false)"><X /></button>
        </header>
        <div v-if="pasteConfirm.danger" class="destructive-copy">
          <span class="destructive-icon"><TriangleAlert /></span>
          <div>
            <strong>{{ t("terminalDanger.detected") }}</strong>
            <p class="task-error mono">{{ pasteConfirm.hits.map((hit) => hit.label).join(" · ") }}</p>
            <p class="muted">{{ t("terminalDanger.desc") }}</p>
          </div>
        </div>
        <p v-else class="muted">{{ t("terminalPasteConfirm.desc") }}</p>
        <p class="muted">{{ t("terminalPasteConfirm.summary", { lines: pasteConfirm.lines, chars: pasteConfirm.chars }) }}<template v-if="pasteConfirm.lines > 1"> · {{ t("terminalPasteConfirm.multiline") }}</template></p>
        <pre class="command-output mono">{{ pasteConfirm.preview }}</pre>
        <footer>
          <button @click="resolvePasteConfirm(false)">{{ t("cancel") }}</button>
          <button :class="pasteConfirm.danger ? 'danger-button' : 'primary-button'" @click="resolvePasteConfirm(true)">{{ t("terminalPasteConfirm.confirm") }}</button>
        </footer>
      </article>
    </section>

    <section v-if="dropUploadPrompt" class="modal-backdrop" @mousedown.self="resolveDropUpload('cancel')">
      <article class="modal small-modal">
        <header>
          <h2>{{ t("terminalDropPrompt.title") }}</h2>
          <button :title="t('close')" class="icon-button" @click="resolveDropUpload('cancel')"><X /></button>
        </header>
        <p class="muted">{{ t("terminalDropPrompt.summary", { count: dropUploadPrompt.files.length }) }}</p>
        <pre class="command-output mono drop-file-list">{{ dropUploadPrompt.files.map((file) => file.name).join("\n") }}</pre>
        <label class="drop-option">
          <input v-model="dropUploadTarget" type="radio" name="drop-upload-target" value="cwd" />
          <span>{{ t("terminalDropPrompt.toCurrent") }}</span>
          <code class="mono">{{ currentPath }}</code>
        </label>
        <label class="drop-option">
          <input v-model="dropUploadTarget" type="radio" name="drop-upload-target" value="custom" />
          <span>{{ t("terminalDropPrompt.toCustom") }}</span>
        </label>
        <input
          ref="dropUploadPathInputEl"
          v-model="dropUploadPathInput"
          class="drop-path-input mono"
          type="text"
          spellcheck="false"
          :placeholder="t('terminalDropPrompt.pathPlaceholder')"
          :disabled="dropUploadTarget !== 'custom'"
          @keydown.enter.prevent="confirmDropUpload"
        />
        <footer>
          <button @click="resolveDropUpload('cancel')">{{ t("cancel") }}</button>
          <button class="primary-button" :disabled="dropUploadTarget === 'custom' && !normalizeDropTargetDir(dropUploadPathInput)" @click="confirmDropUpload">{{ t("upload") }}</button>
        </footer>
      </article>
    </section>

    <!-- 目录选择器：DOM 末尾渲染，保证叠在设置弹窗/下载询问弹窗之上。
         不传 initialPath：默认从「此电脑」盘符页开始（macOS/Linux 无盘符概念，
         回退到默认下载目录），与 kimi-code-desktop 的选择器行为对齐。 -->
    <FolderPickerDialog
      v-if="folderPickerTarget"
      :locale="locale"
      @select="onFolderPicked"
      @close="folderPickerTarget = null"
    />

    <input ref="uploadInput" class="hidden" type="file" multiple @change="onUploadInput" />
    <input ref="zmodemInput" class="hidden" type="file" multiple @change="onZmodemInput" />
    <input ref="trzszInput" class="hidden" type="file" multiple @change="onTrzszPickInput" @cancel="onTrzszPickCancel" />
  </main>
</template>

<style scoped>
/* SFTP 面板扩展（工作包 B）：搜索/类型过滤、批量条、路径历史、属性弹窗。 */
.sftp-filter-bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); padding: 5px 7px; }
.sftp-search-input { display: flex; flex: 1; min-width: 0; height: 26px; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 7px; background: var(--background); }
.sftp-search-input:focus-within { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); }
.sftp-search-input svg { width: 13px; height: 13px; flex: 0 0 13px; color: var(--muted-foreground); }
.sftp-search-input input { min-width: 0; flex: 1; border: 0; padding: 0; background: transparent; color: var(--foreground); font-size: 12px; outline: none; }
.sftp-search-clear { display: grid; width: 16px; height: 16px; flex: 0 0 16px; border: 0; border-radius: 50%; padding: 0; place-items: center; background: transparent; color: var(--muted-foreground); cursor: pointer; }
.sftp-search-clear:hover { background: var(--accent); color: var(--foreground); }
.sftp-search-clear svg { width: 11px; height: 11px; }
.sftp-type-filter { height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 3px; background: var(--background); color: var(--foreground); font-size: 12px; }
.sftp-batch-bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); padding: 5px 8px; background: color-mix(in srgb, var(--primary) 8%, var(--background)); color: var(--muted-foreground); font-size: 11px; }
.sftp-batch-bar span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sftp-batch-bar button { display: inline-flex; height: 24px; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 11px; cursor: pointer; }
.sftp-batch-bar button:hover:not(:disabled) { background: var(--accent); }
.sftp-batch-bar button.danger { color: var(--destructive); }
.sftp-batch-bar button svg { width: 12px; height: 12px; }
.sftp-batch-bar .batch-progress { flex: 0 0 auto; overflow: visible; font-variant-numeric: tabular-nums; }
.batch-progress-bar { flex: 0 1 140px; height: 6px; min-width: 80px; accent-color: var(--primary); }
.batch-progress-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.batch-progress-row .batch-progress-bar { flex: 1; }
.path-history-popover { display: flex; width: 250px; max-height: min(320px, 50vh); flex-direction: column; padding: 8px; overflow: auto; }
.path-history-title { margin: 4px; color: var(--muted-foreground); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
.path-history-popover .path-item { display: block; width: 100%; height: 26px; overflow: hidden; border: 0; border-radius: 4px; padding: 0 7px; background: transparent; color: var(--foreground); font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.path-history-popover .path-item:hover { background: var(--accent); }
/* 书签行：label 跳转 + 行尾悬浮删除（对齐 path-item 观感） */
.bookmark-row { display: flex; align-items: center; gap: 2px; }
.bookmark-row .path-item { flex: 1 1 auto; min-width: 0; }
.bookmark-row .bookmark-delete { display: flex; width: 22px; height: 22px; flex: 0 0 22px; align-items: center; justify-content: center; border: 0; border-radius: 4px; background: transparent; color: var(--muted-foreground); cursor: pointer; opacity: 0; }
.bookmark-row:hover .bookmark-delete, .bookmark-row .bookmark-delete:focus-visible { opacity: 1; }
.bookmark-row .bookmark-delete:hover { color: var(--destructive); background: var(--accent); }
.bookmark-row .bookmark-delete svg { width: 12px; height: 12px; }
/* 星标收藏弹层：路径预览 + 可编辑 label + 保存/取消 */
.bookmark-save-popover { display: flex; width: 250px; flex-direction: column; gap: 6px; padding: 8px; }
.bookmark-save-path { overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.bookmark-label-input { width: 100%; border: 1px solid var(--border); border-radius: 4px; padding: 4px 7px; background: var(--background); color: var(--foreground); font-size: 11px; }
.bookmark-save-actions { display: flex; justify-content: flex-end; gap: 4px; }
/* 传输历史区标题：与任务卡片间的分隔线 */
.transfer-history-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; border-top: 1px solid var(--border); margin-top: 10px; }
.transfer-history-title { margin: 0; padding-top: 8px; }
.transfer-history-actions { display: flex; gap: 2px; padding-top: 6px; }
.attrs-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 12px; }
.attrs-grid dt { max-width: 16ch; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis; white-space: nowrap; }
.attrs-grid dd { margin: 0; overflow-wrap: anywhere; }
.attrs-permissions-edit { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.attrs-permissions-edit span { flex: 0 0 auto; color: var(--muted-foreground); }
.attrs-permissions-edit input { flex: 1; }
/* 权限矩阵：所有者/属组/其他人 × 读/写/执行勾选，与八进制输入双向联动 */
.perm-matrix { display: grid; grid-template-columns: minmax(56px, auto) repeat(3, 1fr); gap: 4px 6px; align-items: center; margin: 2px 0 8px; font-size: 12px; }
.perm-matrix-head { color: var(--muted-foreground); font-size: 11px; text-align: center; }
.perm-matrix-role { color: var(--muted-foreground); white-space: nowrap; }
.perm-matrix-cell { display: flex; justify-content: center; }
.perm-matrix-cell input { width: 13px; height: 13px; margin: 0; accent-color: var(--primary); }

/* 工具栏 A+/A- 字号步进按钮（复用 Ctrl+滚轮的 clampFontSize 语义） */
.font-step-label { font-size: 11px; font-weight: 600; line-height: 1; letter-spacing: 0; }

/* 命令历史下拉（命令弹窗内）：↑↓ 浏览 + 点击一键重发 */
.command-history { display: flex; flex-direction: column; gap: 4px; }
.command-history-header { display: flex; align-items: center; justify-content: space-between; color: var(--muted-foreground); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
.command-history-list { display: flex; max-height: 168px; flex-direction: column; gap: 1px; overflow: auto; }
.command-history-item { display: block; width: 100%; overflow: hidden; border: 1px solid transparent; border-radius: 4px; padding: 4px 8px; background: transparent; color: var(--foreground); font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.command-history-item:hover { background: var(--accent); border-color: var(--border); }

/* 快速命令栏（工具栏下拉）：发送 / 编辑 / 删除 + 底部新增编辑器 */
.quick-commands-popover { display: flex; width: min(360px, calc(100vw - 24px)); max-height: min(480px, calc(100vh - 60px)); flex-direction: column; gap: 4px; padding: 8px; overflow: auto; }
.quick-commands-popover h3 { margin: 2px 4px 6px; font-size: 12px; }
/* 搜索行：图标 + 无边框输入（容器边框即输入框）。 */
.quick-search { display: flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 4px; padding: 0 8px; background: var(--background); }
.quick-search:focus-within { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); }
.quick-search svg { width: 13px; height: 13px; flex: 0 0 13px; color: var(--muted-foreground); }
.quick-search input { min-width: 0; flex: 1; height: 26px; border: 0; padding: 0; background: transparent; color: var(--foreground); font-size: 12px; outline: none; }
/* 命令卡片（Termius Snippets 式）：{} 图标 + 名称/命令两行；动作按钮 hover
   或展开时浮现；展开时显示完整命令（自动换行）。 */
.quick-card { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; border: 1px solid transparent; border-radius: var(--radius); padding: 3px 4px; }
.quick-card:hover { background: color-mix(in srgb, var(--accent) 55%, transparent); }
.quick-card.expanded { border-color: var(--border); background: color-mix(in srgb, var(--accent) 40%, transparent); }
.quick-card-main { display: flex; min-width: 0; flex: 1; align-items: center; gap: 8px; border: 0; padding: 3px; background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.quick-card-icon { width: 15px; height: 15px; flex: 0 0 15px; color: var(--muted-foreground); }
.quick-card.expanded .quick-card-icon, .quick-card:hover .quick-card-icon { color: var(--primary); }
.quick-card-text { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 1px; }
.quick-card-text strong { max-width: 100%; overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.quick-card-text .mono { max-width: 100%; overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.quick-card-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 3px; opacity: 0; transition: opacity 100ms ease; }
.quick-card:hover .quick-card-actions, .quick-card.expanded .quick-card-actions, .quick-card-actions:focus-within { opacity: 1; }
.quick-action { height: 22px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 10px; cursor: pointer; }
.quick-action:hover:not(:disabled) { background: var(--accent); }
.quick-card-full { flex: 1 1 100%; margin: 2px 4px 4px 27px; color: var(--foreground); font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.quick-command-footer { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; }
.quick-new-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: 1; height: 26px; border: 1px dashed var(--border); border-radius: var(--radius); background: transparent; color: var(--foreground); font-size: 11px; cursor: pointer; }
.quick-new-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--primary) 60%, var(--border)); background: var(--accent); }
.quick-new-btn:disabled { cursor: default; opacity: .42; }
.quick-new-btn svg { width: 13px; height: 13px; }
.quick-editor-head { display: flex; align-items: center; gap: 6px; }
.quick-editor-head h3 { flex: 1; margin: 0; }
/* 编辑器子视图（新建/编辑共用）：名称 + 多行命令 + 保存/取消。 */
.quick-command-editor { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.quick-command-editor input { width: 100%; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.quick-command-editor textarea { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; background: var(--background); color: var(--foreground); font-size: 12px; line-height: 1.5; }
.quick-command-editor input:focus, .quick-command-editor textarea:focus { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); outline: none; }
.quick-command-editor-actions { display: flex; align-items: center; gap: 6px; }
.quick-command-editor-actions .quick-command-limit { flex: 1; overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.quick-command-editor-actions button { height: 24px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 11px; cursor: pointer; }
.quick-command-editor-actions .primary-button { background: var(--primary); color: var(--primary-foreground); }

/* 连接信息面板（工具栏下拉，只读） */
.connection-info-popover { width: min(300px, calc(100vw - 24px)); padding: 8px 12px 12px; }
.connection-info-popover h3 { margin: 4px 0 8px; font-size: 12px; }
.connection-info-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 12px; }
.connection-info-grid dt { max-width: 16ch; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis; white-space: nowrap; }
.connection-info-grid dd { display: flex; min-width: 0; align-items: center; gap: 8px; margin: 0; overflow-wrap: anywhere; }
.connection-info-grid .task-error { font-size: 10px; }
.connection-info-grid .link-button { flex: 0 0 auto; align-self: center; font-size: 10px; }

/* 终端 MCP 模式快速开关（工具栏弹出层，与设置弹窗共用三档文案） */
.agent-mode-popover { width: min(280px, calc(100vw - 24px)); padding: 8px 12px 12px; }
.agent-mode-popover h3 { margin: 4px 0 8px; font-size: 12px; }
.agent-mode-option { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; cursor: pointer; }
.agent-mode-note { margin: 8px 0 0; font-size: 11px; }

/* AI 终端同步执行：执行横幅（终端底部，避开命令标记条）+ 审批弹窗 */
.agent-run-banner { position: absolute; z-index: 3; right: 8px; bottom: 36px; left: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius); padding: 6px 8px; background: color-mix(in srgb, var(--background) 92%, transparent); box-shadow: 0 4px 14px color-mix(in srgb, #000 18%, transparent); font-size: 11px; }
.agent-run-banner svg { width: 14px; height: 14px; flex: 0 0 14px; }
.agent-run-text { flex: 0 0 auto; color: var(--foreground); }
.agent-run-command { min-width: 0; flex: 1; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis; white-space: nowrap; }
.agent-interrupt { flex: 0 0 auto; height: 24px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--destructive); font-size: 11px; cursor: pointer; }
.agent-interrupt:hover { background: var(--accent); }
.agent-prompt-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 12px; }
.agent-risk-badge { flex: 0 0 auto; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 600; letter-spacing: .02em; }
.agent-risk-badge.low { border: 1px solid var(--border); background: var(--accent); color: var(--muted-foreground); }
.agent-risk-badge.elevated { border: 1px solid color-mix(in srgb, var(--destructive) 55%, transparent); background: color-mix(in srgb, var(--destructive) 12%, transparent); color: var(--destructive); }
.agent-prompt-command { display: flex; flex-direction: column; gap: 5px; padding: 4px 0 8px; font-size: 12px; }
.agent-prompt-command span { color: var(--muted-foreground); }
.agent-prompt-command textarea { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; background: var(--background); color: var(--foreground); font-family: var(--terminal-font-family); font-size: 12px; }
.agent-prompt-command textarea:focus { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); outline: none; }
.agent-prompt-countdown { padding-bottom: 10px; }
/* —— 断点续传 / 进程管理 / 会话录制（F1-F3）—— */
.is-recording { color: var(--destructive); }
/* 录制中：悬浮控制条（红色呼吸点 + 时长 mono 等宽不跳动 + 停止按钮）。
   锚定视口而非终端面板：面板底边可能探出可视区（批量栏等会推高布局），
   绝对定位会被裁掉半截；fixed 与 toast 通知同款，已验证可靠。 */
.recording-float { position: fixed; z-index: 40; bottom: 64px; left: 50%; display: flex; align-items: center; gap: 8px; transform: translateX(-50%); border: 1px solid color-mix(in srgb, var(--destructive) 45%, var(--border)); border-radius: 999px; padding: 5px 7px 5px 12px; background: color-mix(in srgb, var(--background) 92%, transparent); box-shadow: 0 4px 14px color-mix(in srgb, #000 18%, transparent); font-size: 11px; }
.recording-float-dot { width: 12px; height: 12px; flex: 0 0 12px; color: var(--destructive); animation: record-pulse 1.6s ease-in-out infinite; }
.recording-elapsed { color: var(--foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.recording-stop { display: inline-flex; align-items: center; gap: 4px; height: 24px; border: 1px solid var(--border); border-radius: 999px; padding: 0 10px; background: var(--background); color: var(--destructive); font-size: 11px; cursor: pointer; }
.recording-stop:hover { background: var(--accent); }
.recording-stop svg { width: 11px; height: 11px; }
@keyframes record-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* 录制开始倒计时遮罩：终端区中央大数字逐级放缩淡入，点击/Esc 取消。 */
.record-countdown-overlay {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: color-mix(in srgb, var(--background) 62%, transparent);
  cursor: pointer;
  user-select: none;
}
.record-countdown-number {
  color: var(--foreground);
  font-size: 72px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 4px 24px rgb(0 0 0 / 40%);
  animation: record-countdown-pop 0.9s cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
.record-countdown-hint { color: var(--muted-foreground); font-size: 11px; }
@keyframes record-countdown-pop {
  0% { opacity: 0; transform: scale(1.5); }
  25% { opacity: 1; transform: scale(1); }
  85% { opacity: 1; transform: scale(0.96); }
  100% { opacity: 0.25; transform: scale(0.92); }
}
.recordings-float { width: 440px; }
/* 录制记录卡片：左 图标+主机/时间两行，右 时长+操作图标按钮（不再复用
   传输卡片 grid——那是为进度条设计的，录制卡塞进去行列全错位）。 */
.recording-card { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); padding: 8px 4px; }
.recording-icon { width: 16px; height: 16px; flex: 0 0 16px; color: var(--muted-foreground); }
.recording-text { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 1px; }
.recording-host { overflow: hidden; font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.recording-meta { overflow: hidden; color: var(--muted-foreground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.recording-duration { flex: 0 0 auto; color: var(--foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.recording-actions { display: flex; flex: 0 0 auto; gap: 2px; }
.recording-delete { color: var(--muted-foreground); }
.recording-delete:hover:not(:disabled) { color: var(--destructive); }
.resumable-hint { margin: 2px 0 6px; font-size: 12px; }
.metrics-trend .metrics-trend-line { width: 120px; height: 18px; }
.proc-manage { margin-top: 10px; }
.proc-manage .settings-section-title { display: flex; justify-content: space-between; align-items: center; }
.proc-sort-row { display: flex; gap: 16px; margin: 6px 0; font-size: 12px; color: var(--muted-foreground); }
.proc-sort-option { display: inline-flex; align-items: center; gap: 4px; }
.proc-kill-group { display: flex; gap: 8px; justify-content: flex-end; }
.proc-kill-force { color: var(--destructive); }
/* 回放弹窗并入模态体系：遮罩用 --overlay、z-index 走 80 梯队、圆角同 .modal。 */
.replay-overlay { position: fixed; inset: 0; background: var(--overlay); z-index: 80; display: flex; align-items: center; justify-content: center; }
.replay-modal { background: var(--popover); color: var(--foreground); border: 1px solid var(--border); border-radius: var(--radius-lg, 8px); padding: 16px; width: min(920px, 92vw); display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-modal); }
/* 标题行弹性布局：关闭按钮固定右上角（block 布局下按钮会掉到标题下一行）。 */
.replay-modal header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.replay-modal header h2 { margin: 0; min-width: 0; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
/* 不固定高度：xterm 26 行实际渲染 442px，写死 420px 会让终端溢出压住下方控制条。 */
.replay-terminal { min-height: 44px; }
.replay-controls { display: flex; align-items: center; gap: 10px; }
.replay-seek { flex: 1; min-width: 0; height: 4px; accent-color: var(--primary); cursor: pointer; }
/* 空录制（00:00/00:00）在终端区中央给提示，不再黑屏干等。 */
.replay-terminal-wrap { position: relative; }
.replay-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted-foreground); font-size: 12px; pointer-events: none; }
/* 控制行控件对齐：播放钮 24px / 倍速 26px / 导出按钮走次级按钮规范。 */
.replay-controls .link-button { display: inline-flex; height: 24px; align-items: center; align-self: center; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 11px; }
.replay-controls .link-button:hover:not(:disabled) { background: var(--accent); }
.replay-speed { width: 76px; height: 26px; }
.replay-time { min-width: 110px; text-align: right; font-size: 12px; color: var(--muted-foreground); }
/* 终端拖入上传落点询问：文件清单限高滚动，路径行对齐 radio 观感。 */
.drop-file-list { max-height: 132px; margin: 0; overflow: auto; white-space: pre; }
.drop-option { display: flex; align-items: center; gap: 7px; margin: 2px 0; font-size: 12px; cursor: pointer; }
.drop-option input { accent-color: var(--primary); }
.drop-option code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); font-size: 11px; }
.drop-path-input { width: 100%; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.drop-path-input:focus { outline: none; border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); }
.drop-path-input:disabled { opacity: .5; }
</style>
