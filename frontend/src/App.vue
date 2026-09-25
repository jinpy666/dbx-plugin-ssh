<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  Archive,
  ChevronDown,
  Disc,
  Eye,
  EyeOff,
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
  ExternalLink,
  File as FileIcon,
  FilePlus,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  Globe,
  ImagePlay,
  History,
  Home,
  Info,
  KeyRound,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  MonitorPlay,
  MonitorUp,
  Network,
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
  SquarePlus,
  ListPlus,
  SquareTerminal,
  Star,
  Terminal as TerminalIcon,
  TextSelect,
  Trash2,
  TriangleAlert,
  Usb,
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
import { handleOsc52ClipboardWrite, handleTerminalColorQuery } from "./lib/terminalOsc";
import {
  createTerminalCopyCache,
  resolveTerminalPasteText,
  sanitizeSearchOptions,
  isApplePlatform,
  TERMINAL_SEARCH_OPTIONS_KEY,
  terminalSearchSeedFromSelection,
  canAcceptTerminalDrop,
  canAcceptFileDrop,
  normalizeDropTargetDir,
  resolveDropTargetDir,
  type TerminalSearchOptions,
} from "./lib/terminalInteraction";
import { planHostFileDrop } from "./lib/hostFileDrop";
import { createTerminalWriteThrottle, type TerminalWriteThrottle } from "./lib/terminalWriteThrottle";
import { createOutputGate } from "./lib/terminalBackpressure";
import { createTerminalInputQueue } from "./lib/terminalInputQueue";
import { SERIAL_STREAM_STDIN, isKnownStreamTag, supportsBinaryInput } from "./lib/serialTerminalFrames";
import { describeReconnectCountdown, describeReconnectRestoredNotice, isConnectionInactiveError, isSessionGoneError, shouldReattachTerminal, terminalReconnectDelay, TERMINAL_RECONNECT_DELAYS, type ReconnectCountdown } from "./lib/terminalReconnect";
import { classifyConnectError, connectErrorKey } from "./lib/connectError";
import { decideConnectRetry, isDuplicatedTransportUnavailableError } from "./lib/connectRetry";
import {
  createSessionTransportReuseState,
  fallbackToFreshTransport,
  markSessionTransportOpenSucceeded,
  sessionTransportOpenParams,
} from "./lib/sessionTransportReuse";
import { createConnectLog } from "./lib/connectLog";
import { pickModalFocusTarget } from "./lib/modalFocus";
import { createZmodemSentry, sendZmodemFiles, type ZmodemUploadProgress } from "./lib/terminalZmodem";
import { sampleTransferSpeed, type TransferSpeedSample } from "./lib/transferSpeed";
import { buildPasteConfirmation, type PasteConfirmation } from "./lib/dangerousCommands";
import { readClipboardText, writeClipboardText, type ClipboardDeps } from "./lib/clipboardBridge";
import { filesFromClipboard } from "./lib/clipboardFiles";
import { friendlySftpError } from "./lib/sftpErrors";
import { filterDiskMounts, filterNetworkInterfaces } from "./lib/metricsView";
import type { GpuOverviewView, NpuOverviewView } from "./lib/metricsGpuNpu";
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
import { searchCommands, commandSuggestionQueryAcceptable, type CommandSuggestion } from "./lib/commandSuggestions";
import { classifyGhostInput, createGhostState, evaluateGhost, nextGhostState, ghostMenuSuppressed, type TerminalGhostState } from "./lib/terminalGhostSuggest";
import { cursorAbsoluteRow, cursorViewportRow } from "./lib/terminalAnchor";
import { canShowSuggestions, createSuggestionGuardState, type SuggestionGuardState } from "./lib/suggestionGuard";
// 结构化补全（对标 Warp/fig，线 2）：spec 命中时优先于历史建议浮层展示
// 带描述的命令/flag/值候选；开关读 pluginStore（SettingsDialog 自治写入）。
import { matchSpecLine, type CompletionLevel, type CompletionRow } from "./lib/completions/spec";
import { COMPLETION_SPECS } from "./lib/completions/specs";
import { clampTransferConcurrency, runTransfers, sanitizeTransferDuplicatePolicy, type TransferDuplicatePolicy } from "./lib/transferQueue";
import { filterQuickCommands, normalizeQuickCommands, QUICK_COMMANDS_LIMIT, quickCommandText, type QuickCommand } from "./lib/quickCommands";
import { batchTargetLabel, deriveBatchCommandName, normalizeBatchTargets, normalizeLocalBatchTargets, quickPickCommandById, selectBatchTargets, summarizeBatchResults, toggleBatchTarget, type BatchSendSummary, type BatchSendTarget } from "./lib/batchSend";
import { formatLatency, formatAuthMethodLabel, normalizeConnectionPort, normalizeConnectionText, type KnownAuthMethod } from "./lib/connectionInfo";
import { readPluginMode, readPluginShell, resolveWorkbenchId } from "./lib/pluginContext";
import { clampFontSize } from "./lib/terminalZoom";
import { loadLastConnectParams } from "./lib/connectLastParams";
import { pluginStore } from "./lib/pluginStore";
import { loadTerminalFontOverride, persistTerminalFontFamily, persistTerminalFontSize, resolveTerminalFont, type TerminalFontOverride } from "./lib/terminalFont";
import { MIB, settingsErrorOf } from "./lib/settingsModel";
import type { DownloadConflictPolicy } from "./lib/downloadPrefs";
import { commandMarkerTooltip, formatCommandDuration, Osc633CommandParser, runningCommandElapsedMs, type Osc633StreamUpdates } from "./lib/terminalCommandMarkers";
import { advanceBatchProgress, batchProgressPercent, createBatchProgress, type BatchProgressState } from "./lib/sftpBatchProgress";
import { describeWorkbenchSessionStatus, type WorkbenchSessionStatus } from "./lib/sessionStatus";
import { sanitizeCommandOutput } from "./lib/terminalOutputText";
import { normalizeTerminalInputBytes } from "./lib/terminalInput";
import { registerTerminalModeQueryHandlers } from "./lib/terminalModeQueries";
import { installMacWebkitInputFallback } from "./lib/terminalWebkitInput";
import { looksBinary } from "./lib/textSniff";
import { formatBytes, formatRate } from "./lib/format";
import { mergeTransferProgress, transferCancelReason, type TransferPhase } from "./lib/transferProgress";
import { DBX_POPOVER, resolveAppearance, TERMINAL_ANSI, type DbxPluginAppearanceInput } from "./lib/appearance";
import { isDbxPluginTheme, onHostThemeChange, themeToAppearance } from "./lib/hostTheme";
import { AGENT_MODES, approvalRemainingSecs, buildAgentResolveBody, dropAgentPrompt, enqueueAgentPrompt, type AgentFinishPayload, type AgentNoticePayload, type AgentPromptPayload, type AgentTerminalMode } from "./lib/agentTerminal";
import { purposeKeyLabel, sanitizeTriagePayload, severityClass, type TriageResult } from "./lib/alertTriage";
import {
  compileRules,
  highlightFillStyle,
  matchesInLine,
  normalizeHighlightRules,
  sanitizeHighlightRuleInput,
  shouldRebuildHighlightRow,
  toAbsoluteRowRange,
  HIGHLIGHT_COLOR_DEFAULT,
  HIGHLIGHT_RULES_LIMIT,
  type HighlightRuleView,
} from "./lib/keywordHighlight";
// 动作链接（P1-2，默认关闭）+ 行号/时间戳 gutter（P1-3，默认关闭）。
import { createActionLinkProvider } from "./lib/actionLinksAddon";
import {
  matchActionLinks,
  sanitizeActionLinksSettings,
  type ActionLinkMatch,
  type ActionLinkMatcherToggles,
  type ActionLinksSettings,
} from "./lib/actionLinksMatcher";
import {
  computeGutterRows,
  getRenderCellHeight,
  sanitizeGutterSettings,
  trimTimestampMap,
  GUTTER_TIMESTAMP_RETENTION_ROWS,
  type GutterRow,
  type GutterSettings,
} from "./lib/terminalGutter";
import { pushSample, sparklinePath, METRICS_SAMPLE_CAPACITY } from "./lib/metricsSparkline";
import { transferPausable, matchResumableUpload, canResumeUpload, type ResumableUploadTask } from "./lib/transferResume";
import { isLiveTransferStatus, sortTransferTasks } from "./lib/transferOrder";
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
import {
  COLUMN_MIN_WIDTHS,
  COLUMN_WIDTH_MAX,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
  NAME_COLUMN_MAX,
  NAME_COLUMN_MIN,
  sanitizeSftpEntries,
  sanitizeVisibleColumns,
  sftpEntryIconKind,
  type SftpColumn,
} from "./lib/sftpEntries";
import { resolveRemotePath, splitRemotePathSegments } from "./lib/remotePathInput";
import { shouldCommitRename } from "./lib/sftpRename";
import { folderDownloadOutcome, type FolderDownloadFinish } from "./lib/sftpFolderDownload";
import { decideFileRowAction } from "./lib/fileRowKeydown";
import { attachWebglRenderer, loadWebglEnabled, persistWebglEnabled, syncWebglRenderer, type WebglRecoveryOptions, type WebglRendererLike } from "./lib/terminalWebgl";
import {
  activeProfileId,
  applySchemeToTerminalTheme,
  CUSTOM_SCHEME_LIMIT,
  CUSTOM_THEME_LIMIT,
  loadTerminalAppearance,
  persistTerminalAppearance,
  sanitizeAppearanceSettings,
  terminalOptionPatch,
  terminalPaddingVars,
  type TerminalAppearanceProfile,
  type TerminalAppearanceSettings,
  type TerminalAppearanceState,
} from "./lib/terminalAppearance";
import { schemeIdFromName, schemeTone, uniqueSchemeId, type TerminalColorScheme, type TerminalThemeLike } from "./lib/terminalScheme";
import {
  isLinkModifierSatisfied,
  loadTerminalBehavior,
  persistTerminalBehavior,
  resolveRightClickBehavior,
  sanitizeTerminalBehavior,
  terminalBehaviorOptionPatch,
  transformPasteText,
  type TerminalBehaviorSettings,
} from "./lib/terminalBehavior";
import {
  keyComboFromEvent,
  loadTerminalHotkeys,
  matchTerminalHotkey,
  persistTerminalHotkeys,
  sanitizeTerminalHotkeys,
  type TerminalHotkeyBindings,
} from "./lib/terminalHotkeys";
import { cellFromMouseEvent, clickCursorArrows, resolveClickCursorMove } from "./lib/terminalClickCursor";
import { bridgeBinaryBytes } from "../../shared/frontend/binaryEvent";
import { applyTreeChildren, createTreeRoot, findTreeNode, markTreeStale, type DirTreeNode } from "./lib/sftpDirTree";
import { workbenchMessage } from "./lib/i18n";
import { randomUUID } from "./lib/uuid";
import TextPreview from "./components/TextPreview.vue";
import TerminalSearchPanel from "./components/TerminalSearchPanel.vue";
import TerminalGutter from "./components/TerminalGutter.vue";
import CommandSuggestions from "./components/CommandSuggestions.vue";
import CompletionMenu from "./components/CompletionMenu.vue";
import ConnectingCard from "./components/ConnectingCard.vue";
import GpuNpuMonitor from "./components/GpuNpuMonitor.vue";
import FolderPickerDialog from "./components/FolderPickerDialog.vue";
import SideNavPanel, { type SftpSideQuickPath } from "./components/SideNavPanel.vue";
import { Switch } from "./components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "./components/ui/context-menu";
import { Popover, PopoverAnchor, PopoverContent } from "./components/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import SettingsDialog from "./components/SettingsDialog.vue";
import TerminalContextMenu, {
  buildSearchUrl,
  DEFAULT_CTX_SEARCH_ENGINES_TEXT,
  parseCtxSearchEnginesText,
  type CtxSearchEngine,
} from "./components/TerminalContextMenu.vue";
import PortForwardDialog from "./components/PortForwardDialog.vue";
import TelnetConnectDialog, { type TelnetConnectOptions } from "./components/TelnetConnectDialog.vue";
import SerialConnectDialog, { type SerialConnectOptions } from "./components/SerialConnectDialog.vue";
// 串口文件上传（NyaTerm 对齐 P0-3）：弹窗 + overlay 状态机在 lib/serialUpload。
import SerialUploadDialog from "./components/SerialUploadDialog.vue";
import {
  initialSerialUploadState,
  reduceSerialUpload,
  serialUploadActive,
  serialUploadPercent,
  streamSerialUploadFile,
  type SerialUploadProgress,
  type SerialUploadProtocol,
  type SerialUploadUiState,
} from "./lib/serialUpload";
// VNC 会话（nyaterm-parity P2 2d）：连接表单 + 画布表面，帧通道在
// handleBinary 的 vnc/frame/{id} 分支接入。
import VncConnectDialog, { type VncConnectOptions } from "./components/VncConnectDialog.vue";
import VncSurface from "./components/VncSurface.vue";
import type { VncInputEvent } from "./lib/vncFrame";
// RDP 会话（nyaterm-parity P3-4）：画布与 VNC 同构（同一 44 字节 patch 头，
// 解码复用 vncFrame），输入走扫描码/unicode 双通道，证书确认走
// connection/challenge kind=rdp-certificate 分支。
import RdpConnectDialog, { type RdpConnectOptions } from "./components/RdpConnectDialog.vue";
import RdpSurface from "./components/RdpSurface.vue";
import {
  initialRdpSessionState,
  isRdpCertificateChallenge,
  rdpCertRemainingSecs,
  rdpCertStatusKey,
  rdpErrorKindKey,
  reduceRdpSessionState,
  type RdpInputEvent,
  type RdpPointerEvent,
  type RdpSessionStateView,
} from "./lib/rdpFrame";
import { ToastAction, ToastClose, ToastProvider, ToastRoot, ToastViewport } from "./components/ui/toast";

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
  /** 属主用户/属组（includeOwner 时由 sidecar 返回；缺失显示 "-"）。 */
  owner?: string;
  group?: string;
}

interface SftpStatInfo {
  path: string;
  kind: SftpEntry["kind"];
  size?: number;
  modifiedAt?: number;
  mode?: string;
  owner?: string;
  group?: string;
  ownerName?: string | null;
  ownerUid?: number | null;
  groupName?: string | null;
  groupGid?: number | null;
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
  // 上传分两阶段计数（issue #60）：staging=字节缓存进本地 spool（快），
  // uploading=字节真正推到 SFTP 服务器（慢）。transferred 只反映 uploading，
  // staged 单独记录 staging 字节，面板不再出现"3G→100M"回跳与假速度。
  phase?: TransferPhase;
  staged?: number;
  // 本工作台首次见到该任务的时间（issue #18 排序：live 行缺 startedAt 时
  // 用它兜底，保证活跃区顺序稳定可解释）。
  joinedAt?: number;
  // 目录下载（sftp/download/tree/start）扩展：整树文件数、在传相对路径与
  // 失败汇总（完成但部分文件失败时面板提示）。（issue #46）
  fileCount?: number;
  currentFile?: string;
  failedCount?: number;
  failureSample?: string;
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
  sftpColumnWidths?: Partial<Record<SftpColumn, number>>;
  sftpNameWidth?: number | null;
  /** 列配置版本标记：六列默认（issue #35）上线后的一次性迁移，老偏好重置为全开。 */
  columnsV2?: boolean;
}

interface ConnectionSummary {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  color?: string;
  readOnly?: boolean;
  /** 宿主连接表单的 protocol 字段（缺省 ssh）：非 SSH 连接在 openSession 里路由到各自会话。 */
  protocol?: "ssh" | "telnet" | "vnc";
}

interface DownloadInfo {
  taskId: string;
  fileName: string;
  size: number;
  chunkSize: number;
  // 断点续传：start 带 offset 时回显的恢复起点。
  resumeOffset?: number;
  // 目录下载（tree/start）扩展：扫描得到的整树规模。
  fileCount?: number;
  dirCount?: number;
  skippedCount?: number;
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
  // GPU / Ascend NPU 总览（Task P1-4）：仅新 sidecar 输出，缺省时监控面板
  // 不渲染 GPU/NPU 区（optional 降级）。
  gpu?: GpuOverviewView;
  npu?: NpuOverviewView;
}

interface DiskUsage {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  percentUsed: number;
}

// 列类型移到 lib/sftpEntries（issue #34：owner/group 属主/属组列，默认关）。
type SftpSortColumn = "name" | "size" | "modified";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", svg: "svg+xml", bmp: "bmp", ico: "x-icon" };
// 已知二进制扩展名在双击时直接提示不打开；无后缀/改名文件由打开前的内容嗅探兜底。
const BINARY_PREVIEW_EXTENSIONS = new Set(["7z", "bin", "bz2", "class", "dll", "dmg", "dylib", "exe", "gz", "iso", "jar", "lz4", "o", "obj", "otf", "pdf", "pyc", "rar", "so", "tar", "tif", "tiff", "ttf", "war", "woff", "woff2", "xz", "zip", "zst"]);
// 打开预览前先读该字节数做二进制嗅探（looksBinary），避免向编辑器灌入乱码。
const SNIFF_CHUNK_BYTES = 8 * 1024;
const MAX_INLINE_PREVIEW_BYTES = 1024 * 1024;
const MAX_DIRECT_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 20 * MIB;
// Above this size the browser download path buffers the whole file in memory, so ask first.
const WEB_DOWNLOAD_WARNING_BYTES = 512 * MIB;
const ZMODEM_DETECTION_TIMEOUT_MS = 5000;
// 粘贴防护：内容含换行或达到该字符数时先确认（对齐 tiny-rdm TerminalPane 阈值）。
const PASTE_CONFIRM_CHAR_THRESHOLD = 200;
// SFTP 路径历史：每连接最多保留 10 条，存 pluginStore（宿主 host.storage；对齐 tiny-rdm pathHistory）。
const SFTP_PATH_HISTORY_KEY = "sftp-path-history";
const SFTP_PATH_HISTORY_LIMIT = 10;
// 传输历史查询上限（sftp/transfer/history，后端环形 200，面板一次取 50）。
const TRANSFER_HISTORY_LIMIT = 50;
// Upper bound for out-of-order terminal frames held while waiting for the
// missing sequence; the replay path re-delivers anything dropped beyond it.
const TERMINAL_PENDING_FRAME_LIMIT = 1024;
const SFTP_QUICK_PATHS = ["/", "/home", "/tmp", "/etc", "/var", "/root"];
// 命令历史 / 终端字号：pluginStore 持久化（敏感命令不入持久层；快速命令已迁 sidecar，见 QUICK_COMMANDS_KEY）。
const COMMAND_HISTORY_KEY = "ssh-command-history";
// 快速命令旧键：迁移到 sidecar 全局存储后仅作一次性迁移种子（见 hydrateQuickCommands）。
const QUICK_COMMANDS_KEY = "ssh-quick-commands";
// 终端字号/字体族键移入 lib/terminalFont.ts（issue #31 字体单独设置）统一管理。
// SFTP 面板默认打开偏好：pluginStore 全局持久化（"false" = 新工作台仅终端）。
const SFTP_PANE_OPEN_KEY = "ssh-sftp-pane-open";
// 侧栏形态偏好：tree/quick tab（默认 tree）与收起状态，pluginStore 全局持久化。
const SFTP_SIDE_TAB_KEY = "ssh-sftp-side-tab";
const SFTP_SIDE_COLLAPSED_KEY = "ssh-sftp-side-collapsed";
const DOWNLOAD_DIR_KEY = "ssh-download-directory";
// 是否默认下载到「下载保存目录」（默认开）；关闭则每次下载打开目录选择窗口。
const DOWNLOAD_USE_DEFAULT_KEY = "ssh-download-use-default-dir";
// 文件已存在时的处理策略：rename（自动重命名，默认）/ ask（询问我）/ overwrite（覆盖）。
const DOWNLOAD_CONFLICT_KEY = "ssh-download-conflict-policy";
// 上传并发（P1-5，1..10，默认 3）与重复目标策略（rename 默认）：sidecar
// preferences 权威存储，localStorage 仅作同步缓存（语义同下载偏好）。
const TRANSFER_CONCURRENCY_KEY = "ssh-transfer-concurrency";
const TRANSFER_DUPLICATE_KEY = "ssh-transfer-duplicate-policy";
// 命令输入建议（P1-1）：开关 + 查询长度上下限；同一偏好链路持久化。
const SUGGESTIONS_ENABLED_KEY = "ssh-history-suggestions-enabled";
const SUGGESTIONS_MIN_CHARS_KEY = "ssh-history-suggestion-min-chars";
const SUGGESTIONS_MAX_CHARS_KEY = "ssh-history-suggestion-max-chars";
// 下载偏好的内存权威态：setup 早期（downloadUseDefaultDraft 初始化）就会被读，
// 必须声明在所有读取点之前（存储语义见下方 loadDownloadDir 一带的注释）。
const downloadDirState = ref("");
const downloadUseDefaultState = ref(true);
const downloadConflictState = ref<DownloadConflictPolicy>("rename");
// 上传并发/重复策略与命令建议的内存权威态（hydratePrefs 时被 sidecar 值覆盖）。
const transferConcurrencyState = ref(3);
const transferDuplicateState = ref<TransferDuplicatePolicy>("rename");
const suggestionsEnabledState = ref(true);
const suggestionMinCharsState = ref(2);
const suggestionMaxCharsState = ref(64);

function sanitizeConflictPolicy(value: unknown): DownloadConflictPolicy {
  return value === "ask" || value === "overwrite" ? value : "rename";
}
// Apple 平台判定（Cmd 为主修饰键）：既有的全选语义与新增的快捷键默认键位都要用，
// 因此在此单点声明，供后面的偏好初始值与终端选项复用。
const applePlatform = isApplePlatform();
// 关键词高亮总开关（IMPL_PLAN_NETCATTY_PARITY §3-B1）：pluginStore 全局持久化，
// 默认开、仅显式 "false" 关；关闭时零挂钩子。
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
let transportReuseState = createSessionTransportReuseState({});
// Bottom dock panel surface (surface=panel, host §8.3): hide the workbench identity block so the panel
// and focus the terminal itself; multi-open/shell switching goes through the panel "+" menu (bridge openWorkbench opens another panel).
// Declared early: the batch bar / sftp pane initializers below must know the surface at setup time.
const panelSurface = computed(() => hostContext.value.surface === "panel");
// 宿主未下发 appearance 前的兜底：DBX `.dark` 规范令牌。
const appearance = ref(resolveAppearance());
const terminalState = ref<"connecting" | "connected" | "disconnected" | "error">("connecting");
const terminalError = ref("");
// 连接卡片：用户取消（在途 open 无法中止，仅切换 UI 态并在 promise 落地后回收
// 孤儿会话）、Show logs 展开态与连接尝试日志（环形 200 条，跨尝试保留历史）。
const connectCancelled = ref(false);
// 成功过渡动画：open 成功后先切 success 卡片（进度到顶 + 对号），hold 播完再进终端。
const connectSucceeded = ref(false);
// 手动重连撞上 "Connection is not active"（sidecar 注册表丢凭据）：卡片保持
// connecting 态并提示用户在 DBX 侧边栏重开连接，插件在有界窗口内自动轮等待宿主重放凭据。
const inactiveWaiting = ref(false);
const CONNECT_SUCCESS_HOLD_MS = 750;
const connectLogsOpen = ref(false);
const connectLog = createConnectLog();
const sftpError = ref("");
const sftpErrorRetry = ref<(() => void) | null>(null);
const sftpErrorOpen = ref(false);
const sftpErrorKey = ref(0);
const notice = ref("");
const noticeActions = ref<Array<{ label: string; run: () => void }>>([]);
const noticeOpen = ref(false);
const noticeKey = ref(0);
const session = ref<SessionInfo>();
const currentPath = ref("/");
const entries = ref<SftpEntry[]>([]);
const selectedPath = ref("");
const loadingFiles = ref(false);
const hostKeyPrompt = ref<HostKeyPrompt>();
// RDP 证书确认（connection/challenge kind=rdp-certificate，RDP-3 前端）：
// 复用 host-key 挑战的 kind 分支入口，展示 SHA256 指纹 + 120s 倒计时 +
// remember 勾选；应答走 rdp/certificate/resolve（fail-closed，超时即拒绝）。
interface RdpCertPrompt {
  challengeId: string;
  sessionId: string;
  host: string;
  port: number;
  fingerprint: string;
  knownHostStatus: string;
  receivedAt: number;
}
const rdpCertPrompt = ref<RdpCertPrompt | null>(null);
const rdpCertRemember = ref(false);
const rdpCertRemaining = ref(0);
let rdpCertTimer = 0;
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
// 新工作台的初始值取全局"默认打开"偏好（pluginStore）。
const sftpPaneOpen = ref(loadSftpPaneDefaultOpen());
const sftpPaneDefaultOpen = ref(loadSftpPaneDefaultOpen());
// 侧栏导航形态偏好：tree（目录树，默认）/ quick（快捷路径）+ 收起状态。
const sftpSideTab = ref<"tree" | "quick">(loadSftpSideTab());
const sftpSideCollapsed = ref(loadSftpSideCollapsed());
// 侧栏目录树：根 = 连接根 "/"，展开时经 sftp/list 懒加载子目录（仅目录）。
const sftpTree = ref<DirTreeNode>(createTreeRoot("/", "/"));
// sftp/home 探测结果：quick tab 置顶展示（获取失败时该项隐藏）。
const sftpHomePath = ref("");
// 终端行为偏好（对标 Tabby「Terminal」页）：右键语义、剪贴板、响铃、渲染细项，
// 单键 pluginStore 持久化（宿主 host.storage → localStorage 降级）；选中复制
// 是其一个字段（旧键镜像保降级，见 LEGACY_SELECT_COPY_KEY）。
const terminalBehavior = ref<TerminalBehaviorSettings>(loadTerminalBehavior());
/** 选中复制（既有消费点：选区变更钩子与设置页开关）。 */
const termSelectCopy = computed(() => terminalBehavior.value.copyOnSelect);
// 终端快捷键绑定（对标 Tabby「Hotkeys」页）：平台默认 + 用户改写，单键持久化。
const terminalHotkeys = ref<TerminalHotkeyBindings>(loadTerminalHotkeys(applePlatform));
// 沙箱宿主读不到系统剪贴板：右键粘贴的降级链靠这份插件视图内的复制副本。
const terminalCopyCache = createTerminalCopyCache();
const followDirectory = ref(false);
// 终端 shell 最近一次上报的 cwd（OSC 7 / OSC 633 Cwd，无论跟随开关是否打开
// 都记录）：终端拖拽上传的「当前目录」落点解析靠它，避免误用 SFTP 面板的
// 浏览目录（初始值 "/"，拼根路径会被服务器以权限拒绝）。
const terminalCwd = ref("");
const directoryTrackingSupported = ref<boolean | undefined>();
const visibleColumns = ref<SftpColumn[]>([...DEFAULT_VISIBLE_COLUMNS]);
/** 每列当前宽度（px）。 */
const sftpColumnWidths = reactive<Record<SftpColumn, number>>({ ...DEFAULT_COLUMN_WIDTHS });
/** 名称列宽度（px）；null = 未拖过，弹性填充剩余空间。 */
const sftpNameWidth = ref<number | null>(null);
/** 正在拖拽的列（含 name）；null 表示没在拖。 */
let sftpResizing: { column: SftpColumn | "name"; startX: number; startWidth: number } | null = null;
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

// —— 外部编辑器回传（P2-5，桌面端）：文件先经 sftp/download 落到
// <下载目录>/remote-edit/<ts>/，watch/start 注册监听；编辑器保存经
// watch/file-modified 事件回来弹确认，上传走 watch/upload（sidecar 从本机
// 路径读字节、原子写回远端，写门禁与其他 SFTP 写一致）。
const externalEditBusy = ref(false);
const activeExternalWatch = ref<{ watchId: string; name: string; remotePath: string }>();
const watchModifiedPrompt = ref<{ watchId: string; name: string } | null>(null);
// 「总是上传」记住的 watchId：同一监听上的后续保存直接推回，不再逐次确认。
const alwaysUploadWatches = new Set<string>();
// —— 符号链接（P2-6）：新建/改指向小对话框 + 列表 tooltip 的 → target 缓存。
// create 用 draft(链接名)+targetDraft(指向)；edit 复用 draft 承载指向。
const symlinkDialog = ref<{ mode: "create" | "edit"; linkPath: string; name: string } | null>(null);
const symlinkDraft = ref("");
const symlinkTargetDraft = ref("");
const symlinkSubmitting = ref(false);
const linkTargets = ref<Record<string, string>>({});
const deleteTarget = ref<SftpEntry>();
const deleteSubmitting = ref(false);
const renamingPath = ref("");
const renameDraft = ref("");
const renameSubmitting = ref(false);
const dragActive = ref(false);
// Terminal-local drag overlay: true only while files are dragged over the
// terminal pane and the drop can actually be accepted (writable session).
const terminalDragActive = ref(false);
// 右键菜单由 reka ContextMenu 承载（定位/碰撞/Esc/外点关闭均交给 reka）；
// 这里只保留受控 open 状态与负载数据，坐标由 trigger 从原生事件捕获。
const terminalMenuOpen = ref(false);
// 行右键菜单：selection 为打开菜单瞬间的多选快照（>1 时切换为批量区）。
const fileMenu = ref<{ entry: SftpEntry; selection: string[] }>();
// 文件列表空白处右键：新建文件夹 / 新建文件 / 刷新（拦截浏览器默认菜单）。
const blankMenu = ref(false);
// 侧栏（目录树/快捷路径）行右键：打开 / 复制路径 / 复制文件名 / 压缩。
const sideMenu = ref<{ path: string }>();
// 下载历史项右键：只为已有本机落盘路径提供定位/打开操作；taskId 用于按卡受控打开。
const transferHistoryMenu = ref<{ taskId: string }>();
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
// 命令历史：内存环形 + pluginStore 非敏感持久化；index 为 -1 表示未在浏览历史。
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
// 命令输入建议浮层（P1-1）运行时状态：条目/选中项/光标锚点与抑制门锁存。
// 开关与长度上下限的权威值在上方 suggestions*State（sidecar 偏好）。
const suggestionOpen = ref(false);
const suggestionItems = ref<CommandSuggestion[]>([]);
const suggestionActiveIndex = ref(0);
const suggestionAnchor = ref<{ x: number; y: number } | null>(null);
const suggestionQuery = ref("");
// 抑制门锁存（跟随型程序命中后保持抑制，Ctrl+C/q 解除）：非响应式即可，
// 只有 canShowSuggestions 的返回值会进渲染。
let suggestionGuardState: SuggestionGuardState = createSuggestionGuardState();
// 最近一次执行的命令行（onData 回车行 + OSC 633 E 帧），抑制门据此判定。
const lastTerminalCommand = ref<string | null>(null);
// —— 终端行内 ghost 自动建议（对标 Warp/fish autosuggest）——状态机纯逻辑在
// lib/terminalGhostSuggest.ts；数据源即上方 commandHistory/quickCommands refs
// （经 evaluateGhost 选项注入，不新建存储）。开关持久化在 SettingsDialog
// （pluginStore 键 ssh-terminal-ghost-suggest，组件内自治），App 只持内存态、
// 经 update:ghost-suggest 即时跟随；acceptPayload 直接写 PTY，等价用户键入。
const GHOST_SUGGEST_KEY = "ssh-terminal-ghost-suggest";
function loadGhostSuggestEnabled(): boolean {
  try {
    return pluginStore.getItem(GHOST_SUGGEST_KEY) !== "0";
  } catch {
    return true;
  }
}
const ghostEnabled = ref(loadGhostSuggestEnabled());
const ghostMatch = ref<{ command: string; remainder: string } | null>(null);
const ghostAnchor = ref<{ x: number; y: number } | null>(null);
// 门状态非响应式：只有 evaluateGhost 的产物（ghostMatch）进渲染。
let ghostGate: TerminalGhostState = createGhostState();

// 结构化补全浮层（对标 Warp/fig，线 2）：spec 命中时取代历史建议浮层；
// 行缓冲/锚点语义与 suggestion* 一致（pendingTerminalInput +
// readTerminalSuggestionAnchor）。开关存 pluginStore（"false" = 关，默认开），
// SettingsDialog 开关行内联自治读写，本处每次弹出前直读（无缓存即时生效）。
const COMPLETION_SPEC_ENABLED_KEY = "ssh-completion-spec";
const completionOpen = ref(false);
const completionRows = ref<CompletionRow[]>([]);
const completionLevel = ref<CompletionLevel>("sub");
const completionCommandPath = ref<string[]>([]);
const completionActiveIndex = ref(0);
const completionAnchor = ref<{ x: number; y: number } | null>(null);

function completionSpecEnabled(): boolean {
  try {
    return pluginStore.getItem(COMPLETION_SPEC_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

function closeCompletionMenu() {
  completionOpen.value = false;
  completionRows.value = [];
  completionActiveIndex.value = 0;
}

function openCompletionMenu(commandPath: string[], level: CompletionLevel, rows: CompletionRow[]) {
  completionCommandPath.value = commandPath;
  completionLevel.value = level;
  completionRows.value = rows;
  completionActiveIndex.value = 0;
  completionAnchor.value = readTerminalSuggestionAnchor();
  completionOpen.value = true;
}

/** 结构化补全浮层的按键消费：↑↓ 选择、Tab/Enter 填充、Esc 关闭。 */
function handleCompletionKey(event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || !completionOpen.value || !completionRows.value.length) return false;
  const rows = completionRows.value;
  if (event.key === "ArrowDown") {
    completionActiveIndex.value = (completionActiveIndex.value + 1) % rows.length;
    return true;
  }
  if (event.key === "ArrowUp") {
    completionActiveIndex.value = (completionActiveIndex.value - 1 + rows.length) % rows.length;
    return true;
  }
  if (event.key === "Tab" || event.key === "Enter") {
    acceptCompletionRow(rows[completionActiveIndex.value]);
    return true;
  }
  if (event.key === "Escape") {
    closeCompletionMenu();
    return true;
  }
  return false;
}

/** 接受候选项：替换当前 token 并按新行内容刷新（无后续候选则关闭）。 */
function acceptCompletionRow(row: CompletionRow) {
  if (!row.token) {
    closeCompletionMenu();
    terminal?.focus();
    return;
  }
  replaceTerminalLineWith(row.token + (row.space ? " " : ""), false);
  refreshCompletionMenu();
  if (!completionOpen.value) terminal?.focus();
}

/** 按当前行缓冲重算结构化补全候选：无命中或无候选时关闭（回落历史建议）。 */
function refreshCompletionMenu() {
  if (!completionSpecEnabled()) {
    closeCompletionMenu();
    return;
  }
  const match = matchSpecLine(pendingTerminalInput, COMPLETION_SPECS);
  if (match && match.rows.length) {
    openCompletionMenu(match.commandPath, match.level, match.rows);
  } else {
    closeCompletionMenu();
  }
}

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
    return pluginStore.getItem(BATCH_BAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

// Dock panel surface keeps the bar closed unconditionally: the panel is a single
// focused terminal, and the sandbox has no localStorage so the persisted
// default (open) would otherwise win.
const batchBarOpen = ref(panelSurface.value ? false : loadBatchBarOpen());
const batchTargetsOpen = ref(false);
const batchLoading = ref(false);
const batchSending = ref(false);
const batchTargets = ref<BatchSendTarget[]>([]);
const batchSelected = ref<string[]>([]);
const batchDraft = ref("");
const batchError = ref("");
const batchSummary = ref<BatchSendSummary>();
const batchQuickPickId = ref("");
// hostContext 由 initialize() 异步填充，panelSurface 在 setup 时还是 false——
// 初始门控永远打不中（这就是"批量命令条关不掉"的根因）。改为响应式强制：
// panel 成立即收批量条、关 SFTP 窗格（无窗格即无目录列表/SFTP 流量）。
watch(panelSurface, (panel) => {
  if (!panel) return;
  batchBarOpen.value = false;
  sftpPaneOpen.value = false;
}, { immediate: true });
// 保存为快速命令的内联名称态（保存走 ssh/quickCommands/save，全局共享）。
const batchSaveMode = ref(false);
const batchSaveName = ref("");
const batchSaving = ref(false);
// 命令条 ↑↓ 浏览历史（与命令弹窗共用 commandHistory 一份存储）。
const batchHistoryIndex = ref(-1);
const batchHistoryBackup = ref("");
// 跨工作台同步源标识：sidecar 把本端状态广播给所有 webview，各端按 source
// 过滤回声；sidecar 缺该方法（旧版二进制）时静默降级，只影响同步。
const batchBarSourceId = randomUUID();
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
// reka Select 不接受空串 option value（空串 = 未选中占位）；空值选项用哨兵值双向映射。
const SELECT_EMPTY_SENTINEL = "__empty__";
const auditOpen = ref(false);
// 终端 MCP 模式快速开关（工具栏弹出层）：连接级 agentTerminalMode 的就地入口，
// 与设置弹窗共用 ssh/settings/set，值语义见 lib/agentTerminal.ts。
const agentModeOpen = ref(false);
const agentMode = ref<AgentTerminalMode>("off");
const agentModeBusy = ref(false);
const profilesOpen = ref(false);
const chmodTarget = ref<SftpEntry>();
const chmodDraft = ref("");
const chmodSubmitting = ref(false);
const diskUsage = ref<DiskUsage>();
const searchOpen = ref(false);
// 打开搜索面板时的种子状态：选区首行预填 + 持久化的选项开关（见 openTerminalSearch）。
const searchSeedQuery = ref("");
const searchSeedOptions = ref<TerminalSearchOptions>(sanitizeSearchOptions(null));
const searchMatchState = ref<TerminalSearchMatchState>("idle");
const searchResultIndex = ref(0);
const searchResultCount = ref(0);
const pasteConfirm = ref<PasteConfirmation>();
// 终端拖入文件的落点询问：null 表示取消；"cwd" 用解析后的 shell/SFTP 当前
// 目录（resolveDropTargetDir：终端 cwd 跟随 → SFTP home → 面板当前目录），
// 弹窗展示解析结果；{ dir } 是用户输入的目标目录（文件原名落其下）。
const dropUploadPrompt = ref<{ files: Array<{ name: string }> }>();
const dropUploadTarget = ref<"cwd" | "custom">("cwd");
// 拖拽落点解析：终端 cwd（OSC 7/633）优先，其次远端主目录，最后兜底面板目
// 录——终端拖拽只在面板关闭时接收，面板目录此刻不可见，仅作旧 sidecar 兜底。
// 弹窗展示的就是这里的解析结果。
const dropCwdTarget = computed(() => resolveDropTargetDir({ terminalCwd: terminalCwd.value || undefined, sftpHome: sftpHomePath.value || undefined, fallback: currentPath.value }));
const dropUploadPathInput = ref("");
const dropUploadPathInputEl = ref<HTMLInputElement>();
const terminalFontSize = ref(appearance.value.terminal.fontSize);
// 终端字体单独设置（issue #31）：字体族/字号的用户覆盖，null 字段 = 跟随宿主。
// setup 期读取安全：loadTerminalFontOverride 经 pluginStore（内部全 guarded，
// opaque origin 不抛错），见 lib/terminalFont.ts 说明。
const terminalFontOverride = ref<TerminalFontOverride>(loadTerminalFontOverride());
// 终端外观偏好（对标 Tabby 的 Settings → Appearance）：配色方案两槽（随宿主
// 亮暗自动切换）、底色策略、字体间距、光标形态与多套主题快照。默认态为
// schemeSource: "host"，即不启用任何方案、行为与既有版本完全一致。
//
// 字体字段（font）不在此持久化状态里作为真相：权威态是 terminalFontOverride
// （Ctrl+滚轮缩放也写它）。读取时用 terminalAppearanceState 覆盖合成，避免
// 「缩放改过字号后主题仍高亮」这类双真相漂移。
const terminalAppearance = ref<TerminalAppearanceState>(loadTerminalAppearance());
const terminalAppearanceState = computed<TerminalAppearanceState>(() => ({
  ...terminalAppearance.value,
  font: { family: terminalFontOverride.value.fontFamily, size: terminalFontOverride.value.fontSize },
}));
// 当前配置命中的主题 id（null = 已改动，不再等于任何预设/我的主题）。
const activeAppearanceThemeId = computed(() => activeProfileId(terminalAppearanceState.value));
// 设置弹窗（独立组件 SettingsDialog）：实例 ref 用于 Esc 内联分层消费与
// 下载草稿回填；下载偏好权威态在本组件，经适配器交给组件读写。
const settingsDialog = ref<InstanceType<typeof SettingsDialog>>();
const downloadPrefsAdapter = {
  loadDir: loadDownloadDir,
  loadUseDefault: loadDownloadUseDefaultDir,
  loadConflict: loadDownloadConflictPolicy,
  persistDir: persistDownloadDir,
  persistUseDefault: persistDownloadUseDefaultDir,
  persistConflict: persistDownloadConflictPolicy,
};
// 传输并发/重复策略与命令建议的读写适配器（权威态在本组件，同下载偏好）。
const transferPrefsAdapter = {
  loadConcurrency: loadTransferConcurrency,
  loadDuplicatePolicy: loadTransferDuplicatePolicy,
  persistConcurrency: persistTransferConcurrency,
  persistDuplicatePolicy: persistTransferDuplicatePolicy,
};
const suggestionPrefsAdapter = {
  loadEnabled: loadSuggestionsEnabled,
  loadMinChars: loadSuggestionMinChars,
  loadMaxChars: loadSuggestionMaxChars,
  persistEnabled: persistSuggestionsEnabled,
  persistMinChars: persistSuggestionMinChars,
  persistMaxChars: persistSuggestionMaxChars,
};
// 终端 WebGL 渲染加速（对标 iShell GPU 加速）：pluginStore 全局偏好，
// 默认开；WebGL 不可用（headless/无 context）时静默回退 DOM 渲染。只有主
// 终端长期挂 renderer；回放弹窗保持 DOM 渲染，GIF 导出在导出期间给离屏
// 终端临时挂载（取像素依赖 canvas），导出完随终端 dispose 释放 context。
const webglEnabled = ref(loadWebglEnabled());
// 背景图开启时强制回退 DOM 渲染器（见 rendererWebglEffective watch）。
const rendererWebglEffective = computed(() => webglEnabled.value && !wallpaperActive.value);
const webglRenderer = ref<WebglRendererLike | null>(null);
// GPU 重置/驱动切换后有限次重建 renderer（Tabby 同款策略）：成功经
// onRecovered 回填引用，偏好已关闭则放弃重建，预算耗尽静默留在 DOM 渲染。
function webglRecoveryOptions(): WebglRecoveryOptions<WebglRendererLike> {
  return {
    onRecovered: (addon) => {
      webglRenderer.value = addon;
    },
    enabled: () => webglEnabled.value,
  };
}
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
/** 默认隐藏以 "." 开头的 Unix 隐藏文件、__pycache__ 等系统缓存条目；
 *  用户可通过过滤栏眼睛图标切换。 */
const sftpShowHidden = ref(false);
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
/** WindTerm 风格属主显示：用户名:组名（uid:gid），名字 = uid 数字时只显示一次。 */
const attrsOwnerDisplay = computed(() => {
  const ai = attrsInfo.value;
  if (!ai) return "–";
  const name = ai.ownerName || ai.owner || "–";
  const gname = ai.groupName || ai.group || "–";
  const label = `${name}:${gname}`;
  if (ai.ownerUid == null || ai.groupGid == null) return label;
  // 如果 ownerName 为 null 且 owner 就是 uid 数字字符串，不重复括号
  const ownerIsUid = ai.ownerName == null && ai.owner === String(ai.ownerUid);
  const groupIsGid = ai.groupName == null && ai.group === String(ai.groupGid);
  if (ownerIsUid && groupIsGid) return label;
  return `${label} (${ai.ownerUid}:${ai.groupGid})`;
});
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
// OSC 10/11 颜色查询应答 handler（registerOscHandler 的 disposable）：主题切换
// 时重挂，终端销毁时统一释放；OSC 52 只在 createTerminal 挂一次。
let oscColorQueryDisposables: { dispose(): void }[] = [];
let osc52Disposable: { dispose(): void } | undefined;
// CSI 能力查询应答（kitty 键盘协议 / XTVERSION / DECRQM）：claude code 等
// TUI 启动时探测并等待应答；xterm 内核对 `CSI ? u` 静默吞掉不回、XTVERSION
// 无 handler，TUI 卡在 raw-mode 初始化——表现为"卡住、键盘没反应"。
let modeQueryDisposables: { dispose(): void }[] = [];
// 主题色解析失败时颜色查询的兜底应答（深色系常规值，仅在宿主下发非法颜色时触达）。
const OSC_COLOR_FALLBACK = { foreground: "#c9d1d9", background: "#0d1117" };
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
let disposeWebkitInputFallback: (() => void) | undefined;
let disposeSelectionCopy: { dispose(): void } | undefined;
let disposeTerminalBell: { dispose(): void } | undefined;
/** 视觉响铃高亮时长（对标 Tabby bell: visual 的一次闪烁）。 */
const TERMINAL_BELL_FLASH_MS = 150;
/** 连响时先摘类、下一帧再加回，否则浏览器认为动画仍在播放不会重播。 */
const TERMINAL_BELL_RETRIGGER_MS = 0;
/** 听觉响铃的合成参数：短促一声 A5 正弦音，音量取保守值避免惊吓。 */
const TERMINAL_BELL_FREQUENCY_HZ = 880;
const TERMINAL_BELL_GAIN = 0.08;
const TERMINAL_BELL_DURATION_S = 0.15;
/** 响铃视觉提示的短暂高亮（xterm 6.x 无 bellStyle，须自行实现）。 */
const terminalBellFlash = ref(false);
let terminalBellFlashTimer = 0;
let bellAudioContext: AudioContext | undefined;
let unsubscribeEvent: (() => void) | undefined;
let unsubscribeBinary: (() => void) | undefined;
// 宿主 fileTransfer 桥拖放事件（宿主 1.1 optional）注销句柄：OS 级拖入上传
// 与终端/SFTP 面板共享同一道门禁，见 handleHostFileDrop。
let unsubscribeFileDrag: (() => void) | undefined;
let unsubscribeFileDrop: (() => void) | undefined;
let unsubscribeAppearance: (() => void) | undefined;
let unsubscribeTheme: (() => void) | undefined;
let unsubscribeLocale: (() => void) | undefined;
let unsubscribeContext: (() => void) | undefined;
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
// 上传收尾等待器（issue #60）：finish RPC 只负责把远端推送交给 sidecar
// 后台任务，真正的完成/失败经终态 progress 事件回传，这里据此结算。
const transferCompletionWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
const downloadChunkWaiters = new Map<string, { offset: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: number }>();
const transferSamples = new Map<string, TransferSpeedSample>();
// Download task ids the user cancelled from the transfer panel; lets the download
// loop distinguish a user cancel (notice) from a real failure (error banner).
const cancelledTransferTasks = new Set<string>();
const directoryParser = new Osc7DirectoryParser();
// OSC 633 shell-integration markers (pure frontend parse; no-op streams pass through).
const commandMarkerParser = new Osc633CommandParser();

// —— 本地终端（sidecar 所在机器的交互式登录 shell）——
// 与 SSH 会话共用同一条渲染管线（乱序重组/补发/633 命令标记/输出节流），
// 同一时刻只展示一个会话：进入本地模式前先经确认关闭 SSH 会话。会话帧用
// 独立的 sequence/pending 状态，避免与 SSH 流互染。
const localSession = ref<{ sessionId: string; shell: string } | null>(null);
const localState = ref<"starting" | "running" | "exited">("exited");
const localExitCode = ref<number | null>(null);
const localOpenConfirmOpen = ref(false);
const localLastSequence = ref(0);
const localPendingFrames = new Map<number, { stream: number; data: Uint8Array }>();
let localReplayInFlight = false;
let localReplayNoProgress = 0;
const isLocalMode = computed(() => localSession.value !== null);
// A4 restored shell (spec §7.6/§8.4): a restored local tab never auto-starts a shell; the exit
// overlay as the shell state waiting for an explicit start; cleared once a shell actually comes up (startLocalTerminal succeeds)
// cleared. localUiMode = "local-terminal UI state" (running session or restored shell); SSH-only toolbar actions gate on it,
// SSH-only toolbar actions and display branches gate on it, decoupled from session existence.
const localShellRestored = ref(false);
// Telnet 会话（P2-3）：与 SSH/本地终端同款互斥展示。并入 localUiMode 后，
// 所有 SSH-only 工具栏分支对 Telnet 自动隐藏；Telnet 专属分支按 isTelnetMode
// 优先接在既有 localSession 分支前面。
const telnetSession = ref<{ sessionId: string; host: string; port: number } | null>(null);
const telnetDialogOpen = ref(false);
const telnetConfirmOpen = ref(false);
const telnetState = ref<"idle" | "connecting" | "running" | "closed">("idle");
const telnetError = ref("");
const telnetLastSequence = ref(0);
const telnetPendingFrames = new Map<number, { stream: number; data: Uint8Array }>();
let telnetReplayInFlight = false;
let telnetReplayNoProgress = 0;
const isTelnetMode = computed(() => telnetSession.value !== null);
const telnetTarget = computed(() => (telnetSession.value ? `${telnetSession.value.host}:${telnetSession.value.port}` : ""));
// 串口会话（P3 + B1 增强）：与 SSH/本地/Telnet 同款互斥展示，并入
// localUiMode。出帧由读线程单线程递增 sequence；键盘输入主路径走
// `serial/terminal/in/{id}` 二进制写通道（B1，Stdin=3 标签），JSON
// `serial/write` 保留为兼容/降级路径；resize 无协议概念（设计稿 §4）。
const serialSession = ref<{ sessionId: string; port: string; baudRate: number } | null>(null);
const serialDialogOpen = ref(false);
const serialConfirmOpen = ref(false);
const serialState = ref<"idle" | "running" | "closed">("idle");
const serialError = ref("");
const serialLastSequence = ref(0);
const serialPendingFrames = new Map<number, { stream: number; data: Uint8Array }>();
// 序号缺口回放（设计稿 §3）：与 telnet/local 的 drain/replay 体系同构，
// 复用既有 gap 检测 + 无进度重试上限，不新写恢复逻辑。
let serialReplayInFlight = false;
let serialReplayNoProgress = 0;
// B1 解码契约：输出帧遇到未知流标签（> Stdin=3）一律静默丢弃并计数。
let serialUnknownStreamFrames = 0;
// B1 能力开关：true = 键盘走二进制写通道。初始值取 serial/start 的
// binaryInput 能力字段（未声明 = 旧 sidecar → JSON 兼容路径）；通道报错
// （未知方法/会话消失）时 send 回调一次性降级 JSON。
const serialBinaryInput = ref(true);
const isSerialMode = computed(() => serialSession.value !== null);
const serialTarget = computed(() => (serialSession.value ? `${serialSession.value.port}@${serialSession.value.baudRate}` : ""));
// 串口文件上传 overlay 状态：进度由 sidecar 的 serial/upload/progress 事件
// 驱动；running 期间吞掉键入（协议控制字符窗口）且禁止并发第二次 upload。
const serialUpload = ref<SerialUploadUiState>(initialSerialUploadState());
const serialUploadDialogOpen = ref(false);
let serialUploadAbortRequested = false;
const serialUploadBusy = computed(() => serialUploadActive(serialUpload.value));
const serialUploadOverlayVisible = computed(() => serialUpload.value.phase !== "idle");
const serialUploadPercentValue = computed(() => serialUploadPercent(serialUpload.value));
const serialUploadStatusLabel = computed(() => {
  const upload = serialUpload.value;
  if (upload.phase === "complete") return t("serial.upload.complete", { name: upload.fileName });
  if (upload.phase === "failed") return t("serial.upload.failed", { reason: upload.reason });
  return t("serial.upload.running", { name: upload.fileName, percent: serialUploadPercentValue.value });
});
// VNC 会话（nyaterm-parity P2 2d）：与 SSH/本地/Telnet/串口同款互斥展示，
// 并入 localUiMode。与终端会话不同，VNC 画面走 VncSurface 画布（xterm
// 仍然挂着但被画布盖住），帧从 vnc/frame/{id} 二进制通道解码成 patch。
const vncSession = ref<{ sessionId: string; host: string; port: number } | null>(null);
const vncDialogOpen = ref(false);
const vncConfirmOpen = ref(false);
const vncState = ref<"idle" | "connecting" | "running" | "closed">("idle");
const vncError = ref("");
const vncScaleMode = ref<VncConnectOptions["scaleMode"]>("fit");
const vncSurface = ref<InstanceType<typeof VncSurface> | null>(null);
let vncClipboardNoticeAt = 0;
const isVncMode = computed(() => vncSession.value !== null);
const vncTarget = computed(() => (vncSession.value ? `${vncSession.value.host}:${vncSession.value.port}` : ""));
// RDP 会话（nyaterm-parity P3-4）：与 SSH/本地/Telnet/串口/VNC 同款互斥展示，
// 并入 localUiMode。画面走 RdpSurface 画布（帧从 rdp/frame/{id} 解码），状态
// 经 lib/rdpFrame 的纯 reducer 折叠（connecting/connected/reconnecting/closed
// + errorKind），断线重连展示手动 rdp/reconnect 出口。
const rdpSession = ref<{ sessionId: string; host: string; port: number } | null>(null);
const rdpDialogOpen = ref(false);
const rdpConfirmOpen = ref(false);
const rdpState = ref<RdpSessionStateView>(initialRdpSessionState());
const rdpScaleMode = ref<RdpConnectOptions["scaleMode"]>("fit");
const rdpSurface = ref<InstanceType<typeof RdpSurface> | null>(null);
let rdpClipboardNoticeAt = 0;
const isRdpMode = computed(() => rdpSession.value !== null);
const rdpTarget = computed(() => (rdpSession.value ? `${rdpSession.value.host}:${rdpSession.value.port}` : ""));
const localUiMode = computed(() => isLocalMode.value || localShellRestored.value || isTelnetMode.value || isSerialMode.value || isVncMode.value || isRdpMode.value);
// —— 本地终端偏好（sidecar preferences.json 持久化；iframe 沙箱无 localStorage）——
// shell 空串 = 跟随自动探测；integration 缺省开。
const localShellPref = ref("");
const localShellIntegrationPref = ref(true);
// shell 选择器菜单：打开时拉一次 local/shells/list。
const localMenuOpen = ref(false);
const localShells = ref<Array<{ program: string; name: string; isDefault: boolean; isUserShell: boolean; injectable?: boolean }>>([]);
const localShellsLoading = ref(false);
// 上次本地会话跟踪到的 cwd：重开时继承（VS Code 新终端继承工作区目录惯例）。
const localLastCwd = ref("");
// 本地终端最近命令（633;E 收集， newest-first，cap 20）：右键菜单"重跑"用。
// 注入关闭时无命令边界，本功能静默缺席。
const localRecentCommands = ref<string[]>([]);
// 当前偏好 shell 是否支持注入（ksh/csh/cmd 等裸 shell 灰掉开关）。
const selectedShellInjectable = computed<boolean | undefined>(() => {
  if (!localShellPref.value) return undefined;
  return localShells.value.find((entry) => entry.program === localShellPref.value)?.injectable;
});

// Large-output rendering throttle: coalesce consecutive PTY frames into one
// merged xterm write per animation frame (capped, order preserving). The sink
// reads `terminal` lazily so it also works across terminal recreation. The
// write completion callback is the gutter timestamp capture point (P1-3): it
// stamps the logical rows each merged batch actually produced.
//
// 大输出保护（IMPL_PLAN Task P2-7）：积压口径 = 已交给 xterm 但 write 回调尚未
// 触发（还没解析完）的字节数。≥128KiB 进入 strained：合并批次按 32KiB 分帧写、
// 挂起 gutter/关键词高亮/动作链接扫描；回落到 64KiB 以下自动恢复并补扫一次。
const outputGate = createOutputGate();
let outputInFlightBytes = 0;
function settleOutputChunk(chunk: Uint8Array) {
  outputInFlightBytes = Math.max(0, outputInFlightBytes - chunk.byteLength);
  // 写入完成回调同时是模式复评点；恢复时挂起的扫描由 onOutputGateRelease 补上。
  if (outputGate.feed(outputInFlightBytes) && outputGate.mode === "normal") onOutputGateRelease();
  stampGutterWrittenRows();
}
function onOutputGateRelease() {
  showNotice(t("backpressure.released"));
  rescanHighlightViewport();
  if (actionLinksEnabled.value && terminal) scheduleActionLinkScan(0, terminal.rows - 1);
  scheduleGutterRecompute();
}
const terminalWriteThrottle: TerminalWriteThrottle = createTerminalWriteThrottle({
  sink: (data) => {
    if (!terminal) return;
    outputInFlightBytes += data.byteLength;
    if (outputGate.feed(outputInFlightBytes) && outputGate.mode === "strained") {
      showNotice(t("backpressure.engaged"));
      scheduleGutterRecompute();
    }
    if (outputGate.mode === "strained") {
      for (const frame of outputGate.write(data)) terminal.write(frame, () => settleOutputChunk(frame));
    } else {
      terminal.write(data, () => settleOutputChunk(data));
    }
  },
});
// #33/#71 快速输入丢字母的分层计数：keys(onData 实际路由到 PTY 的按键)、
// sends(提交给宿主桥的帧)、acks(sidecar 确认收到的帧)、errors(桥拒绝)、
// swallowed(被 zmodem/trzsz 路由吞掉的按键)。宿主开启 localStorage 的
// dbx-term-diag=1 后每 2s 在控制台输出；始终挂在 window 上便于随时读取。
const terminalDiag = reactive({ keys: 0, sends: 0, acks: 0, errors: 0, swallowed: 0 });
const terminalDiagVisible = ref(false);
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__dbxTerminalDiag = terminalDiag;
  let diagEnabled = false;
  try {
    diagEnabled = window.localStorage?.getItem("dbx-term-diag") === "1";
  } catch {
    // 沙箱策略禁止 localStorage 时诊断保持关闭。
  }
  if (diagEnabled) {
    window.setInterval(() => {
      console.info("[term-diag]", JSON.stringify(terminalDiag));
    }, 2000);
  }
}

const terminalInputQueue = createTerminalInputQueue({
  send: (sessionId, payload) => {
    terminalDiag.sends += 1;
    // Telnet 会话以 "telnet:" 前缀进同一串行队列（发送时按前缀拆通道，
    // 避免异步间隙里模式切换串台）；本地/SSH 会话保持原通道不变。
    if (sessionId.startsWith("telnet:")) {
      return window.dbxPlugin.sendBinary(`telnet/terminal/in/${sessionId.slice("telnet:".length)}`, payload);
    }
    return window.dbxPlugin.sendBinary(`ssh/terminal/in/${sessionId}`, payload);
  },
  onError: (cause) => {
    terminalDiag.errors += 1;
    showError(cause, "terminal");
    // 会话被外部杀掉（宿主重推连接的 disconnect、sidecar 重启）时本 tab 无
    // 事件感知，终端看似活着实则打不进字。输入撞上死会话时按传输断开的
    // 同款有界梯子自动重连。错误串契约见 backend ssh.rs session()。
    if (terminalState.value === "connected" && !reconnectPending.value && isSessionGoneError(cause)) scheduleSessionReconnect();
  },
});

// 串口专用输入队列：与 SSH/Telnet 共用同一有序实现，但负载带 Stdin 流
// 标签（B1 TerminalFrame 形状），序列号独立计数；宿主对未知通道/方法报错
// 时一次性降级 JSON 兼容路径（serialBinaryInput）。
const serialInputQueue = createTerminalInputQueue({
  frameTag: SERIAL_STREAM_STDIN,
  send: (sessionId, payload) => {
    if (!sessionId.startsWith("serial:")) return;
    return window.dbxPlugin
      .sendBinary(`serial/terminal/in/${sessionId.slice("serial:".length)}`, payload)
      .catch((cause: unknown) => {
        serialBinaryInput.value = false;
        throw cause;
      });
  },
  onError: (cause) => showError(cause, "terminal"),
});

const locale = ref("zh-CN");
const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(locale.value, key, values);
const connectionId = computed(() => normalizeConnectionText(hostContext.value.connectionId));
// Host API 1.1 provides a stable workbenchId in the host context; on 1.0 a
// locally generated id keeps session scoping per workbench instance (A4 W1
// helper, spec §11: host-authoritative workbenchId; the fallback covers 1.0
// hosts that omit the injection — see lib/pluginContext.spec.ts).
const fallbackWorkbenchId = randomUUID();
const workbenchId = computed(() => resolveWorkbenchId(hostContext.value, fallbackWorkbenchId));
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
    protocol: raw.protocol === "telnet" || raw.protocol === "vnc" ? raw.protocol : "ssh",
  };
});
// 连接协议（对标 Tabby profile）：宿主连接表单的 protocol 字段，缺省 ssh。
// 非 SSH 连接由 openSession 路由到各自的会话视图，不建立 SSH 会话。
const connectionProtocol = computed<"ssh" | "telnet" | "vnc">(() => {
  const protocol = connection.value.protocol;
  return protocol === "telnet" || protocol === "vnc" ? protocol : "ssh";
});
const canWrite = computed(() => !connection.value.readOnly && !connectionReadOnly.value);
const selectedEntry = computed(() => entries.value.find((entry) => entry.uri === selectedPath.value));
const connected = computed(() => terminalState.value === "connected" && !!session.value);
const sessionStatus = computed<WorkbenchSessionStatus | "local">(() => (localUiMode.value ? "local" : describeWorkbenchSessionStatus(terminalState.value, { reattaching: reconnectPending.value })));
// 本地模式徽标附带 shell 名（Local · Zsh），一眼可见当前在哪种 shell 里。
const sessionPillText = computed(() => {
  // 串口徽标显示 port@baud（Serial · /dev/ttyUSB0@115200），一眼可见线路参数。
  if (isSerialMode.value) return `${t("serial.pillPrefix")} · ${serialTarget.value}`;
  // Telnet 徽标显示明文目标（Telnet · host:port），提示这是非 SSH 连接。
  if (isTelnetMode.value) return telnetState.value === "connecting" ? t("telnet.connecting") : `${t("telnet.pillPrefix")} · ${telnetTarget.value}`;
  // VNC 徽标显示远端桌面目标（VNC · host:port）。
  if (isVncMode.value) return vncState.value === "connecting" ? t("vnc.connecting") : `${t("vnc.pillPrefix")} · ${vncTarget.value}`;
  // RDP 徽标：连接中/重连中（带退避进度）显示状态，其余显示 host:port。
  if (isRdpMode.value) {
    if (rdpState.value.state === "connecting") return t("rdp.connecting");
    if (rdpState.value.state === "reconnecting") {
      return rdpState.value.maxAttempts > 0
        ? t("rdp.reconnectingAttempt", { attempt: rdpState.value.attempt, max: rdpState.value.maxAttempts })
        : t("rdp.reconnecting");
    }
    return `${t("rdp.pillPrefix")} · ${rdpTarget.value}`;
  }
  if (!isLocalMode.value || !localSession.value) return t(`sessionStatus.${sessionStatus.value}`);
  const kind = localSession.value.shell.split(/[\\/]/).pop() || localSession.value.shell;
  return `${t("sessionStatus.local")} · ${kind}`;
});
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
  // Connectionless local-terminal tab (including the restored shell): there is no connection identity to show.
  if (localUiMode.value && !connectionId.value) {
    if (isSerialMode.value) return `${t("serial.pillPrefix")} ${serialTarget.value}`;
    if (isTelnetMode.value) return `${t("telnet.pillPrefix")} ${telnetTarget.value}`;
    if (isVncMode.value) return `${t("vnc.pillPrefix")} ${vncTarget.value}`;
    return t("localTerminal.active");
  }
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
// 活跃区只显示进行中的任务（queued/running），按 transferOrder 的稳定规则
// 排序：先开始/先加入的排最上，同键用 taskId 兜底（issue #18）。此前这里
// 按对象插入序渲染全部任务：插入序来自后端 HashMap 迭代序 + 事件到达序，
// 终态行还永久堆积，同一张卡就会在面板里"一会儿在上、一会儿在中间、一会儿
// 在下"。终态行由历史区承接（落盘 + 内存合并视图），转终态的同一拍刷新。
const transferList = computed(() =>
  sortTransferTasks(Object.values(transferTasks).filter((task) => isLiveTransferStatus(task.status))),
);
const activeTransfers = computed(() => transferList.value.filter((task) => task.status === "queued" || task.status === "running").length);
const zmodemBusy = computed(() => zmodemState.value !== "idle");
const zmodemPercent = computed(() => zmodemTotalSize.value > 0 ? Math.min(100, Math.round((zmodemTransferred.value / zmodemTotalSize.value) * 100)) : 0);
// 文件传输占用统一语义：ZMODEM 或 trzsz 任一持有终端流即视为 busy。
const terminalTransferBusy = computed(() => zmodemBusy.value || trzszBusy.value);
const trzszBusy = computed(() => trzszPhase.value === "waiting" || trzszPhase.value === "transferring");
const trzszOverlayVisible = computed(() => trzszPhase.value !== "idle");
const sftpGridStyle = computed(() => {
  // 名称列：未拖过 = 弹性填充剩余空间；拖动后锁定为固定宽度。
  const nameTrack = sftpNameWidth.value != null ? `${sftpNameWidth.value}px` : `minmax(${NAME_COLUMN_MIN}px, 1fr)`;
  const cols: string[] = [nameTrack];
  const nameMin = sftpNameWidth.value ?? NAME_COLUMN_MIN;
  const list: SftpColumn[] = ["size", "modified", "owner", "group", "permissions"];
  for (const col of list) {
    if (visibleColumns.value.includes(col)) {
      cols.push(`${sftpColumnWidths[col]}px`);
    }
  }
  // 总宽超出容器时靠 .file-rows 的 overflow:auto 出横向滚动条。
  let minWidth = nameMin + 16; // + 左右 padding
  for (const col of list) if (visibleColumns.value.includes(col)) minWidth += sftpColumnWidths[col] + 6; // 6px column-gap
  return {
    gridTemplateColumns: cols.join(" "),
    minWidth: `${minWidth}px`,
  };
});
const sftpFiltersActive = computed(() => sftpSearch.value.trim() !== "" || sftpTypeFilter.value !== "all" || sftpShowHidden.value);
const visibleEntries = computed(() => filterSftpEntries(sortedEntries.value, sftpSearch.value, sftpTypeFilter.value, sftpShowHidden.value));
const selectedEntries = computed(() => entries.value.filter((entry) => selectedUris.value.includes(entry.uri)));
const currentPathHistory = computed(() => pathHistories[connectionId.value] || []);
const previewDirty = computed(() => previewEditable.value && previewDraft.value !== previewBaseline.value);
// 编辑保存走 sftp/write 整文件覆写：只有完整加载（未截断）且不超直写上限的
// 文本才允许进入编辑，否则保存会把未加载部分丢掉。
const previewEditableAllowed = computed(() => canWrite.value && previewMode.value === "text" && !previewTruncated.value && previewSize.value <= MAX_DIRECT_WRITE_BYTES);

function initialState(): WorkbenchState {
  const value = hostContext.value.workbenchState;
  return value && typeof value === "object" ? (value as WorkbenchState) : {};
}

function restoreUiState() {
  const state = initialState();
  currentPath.value = typeof state.sftpPath === "string" ? normalizeRemotePath(state.sftpPath) : "/";
  splitRatio.value = typeof state.splitRatio === "number" && state.splitRatio >= 35 && state.splitRatio <= 80 ? state.splitRatio : 58;
  paneOrder.value = state.paneOrder === "sftp-left" ? "sftp-left" : "terminal-left";
  // Dock panel surface: the SFTP pane stays closed (no auto-list/auto-connect);
  // users who want SFTP open the workbench tab.
  sftpPaneOpen.value = panelSurface.value ? false : resolveSftpPaneOpen(state, sftpPaneDefaultOpen.value);
  // Dock panel surface：目录跟随是 SFTP 域能力，面板一律关闭。
  followDirectory.value = panelSurface.value ? false : state.followDirectory === true;
  sudoMode.value = state.sudoMode === true && canWrite.value;
  // 一次性迁移：六列默认上线前的旧偏好重置为全开（之后用户自定义照常持久化）。
  const legacyColumns = state.visibleColumns != null && state.columnsV2 !== true;
  visibleColumns.value = legacyColumns ? [...DEFAULT_VISIBLE_COLUMNS] : sanitizeVisibleColumns(state.visibleColumns);
  // 恢复列宽，未知列或越界用默认值兜底
  const saved = state.sftpColumnWidths || {};
  const allCols: SftpColumn[] = ["size", "modified", "owner", "group", "permissions"];
  for (const col of allCols) {
    const raw = saved[col];
    const num = typeof raw === "number" ? raw : DEFAULT_COLUMN_WIDTHS[col];
    sftpColumnWidths[col] = Math.max(COLUMN_MIN_WIDTHS[col], Math.min(COLUMN_WIDTH_MAX, num));
  }
  sftpNameWidth.value = typeof state.sftpNameWidth === "number" ? Math.max(NAME_COLUMN_MIN, Math.min(NAME_COLUMN_MAX, state.sftpNameWidth)) : null;
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
    columnsV2: true,
    sftpColumnWidths: { ...sftpColumnWidths },
    sftpNameWidth: sftpNameWidth.value,
  }).catch(() => undefined);
}

function persistState() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    void writeWorkbenchState();
  }, 150);
}

// —— 自定义 tooltip（对齐 DBX 宿主的气泡提示）——
// 全局接管 title 属性：悬停或键盘聚焦时把值挪到 data-tooltip（抑制原生慢速
// 灰框），350ms 后显示主题化气泡；下方空间不足翻到上方。模板无需改动，所有
// 现有和未来的 title 自动生效。
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

function scheduleTooltip(target: HTMLElement) {
  // title → data-tooltip：Vue 绑定只在值变化时重写 title，下次触发再挪一次。
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

function onTooltipOver(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest?.("[title], [data-tooltip]") as HTMLElement | null;
  if (target === tooltipEl) return;
  hideTooltip();
  if (!target) return;
  scheduleTooltip(target);
}

function onTooltipOut(event: MouseEvent) {
  if (!tooltipEl) return;
  const related = event.relatedTarget as HTMLElement | null;
  if (related && tooltipEl.contains(related)) return;
  hideTooltip();
}

// 键盘可达性：focusin/focusout 走同一套气泡（focus 锚定元素本身，
// 不依赖指针位置），blur 时收起。
function onTooltipFocusIn(event: FocusEvent) {
  const target = (event.target as HTMLElement | null)?.closest?.("[title], [data-tooltip]") as HTMLElement | null;
  if (target === tooltipEl) return;
  hideTooltip();
  if (!target) return;
  scheduleTooltip(target);
}

function onTooltipFocusOut(event: FocusEvent) {
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
// reka Toast 承载展示与计时（悬停暂停/滑动关闭为内建行为）；通知为单实例替换
// 语义——每次 show 递增 key 重挂 ToastRoot，时长重置（3500ms，带动作放宽到 8000ms）。
function showNotice(message: string, actions: BannerAction[] = []) {
  notice.value = message;
  noticeActions.value = actions;
  noticeKey.value += 1;
  noticeOpen.value = true;
}

function onNoticeOpenChange(open: boolean) {
  if (open) return;
  noticeOpen.value = false;
  notice.value = "";
  noticeActions.value = [];
}

function onSftpErrorOpenChange(open: boolean) {
  if (open) return;
  sftpErrorOpen.value = false;
  sftpError.value = "";
  sftpErrorRetry.value = null;
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
    sftpErrorKey.value += 1;
    sftpErrorOpen.value = true;
  }
}

// 宿主派生的终端主题（未启用配色方案时的最终结果）：DBX 面板色 + 内置 16 色
// ANSI。作为「跟随宿主」基底，也是设置页预览的基准。
function hostTerminalTheme(): TerminalThemeLike {
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

// 实际生效的主题：宿主基底 + 用户选定方案（未启用方案时原样返回基底）。
function terminalTheme(): TerminalThemeLike {
  return applySchemeToTerminalTheme(
    hostTerminalTheme(),
    terminalAppearance.value.settings,
    terminalAppearance.value.customSchemes,
    appearance.value.colorScheme,
  );
}

// 终端内边距经 CSS 变量下发（style.css 的 .terminal-host .xterm 读取）；
// 未设置的方向删变量，回落内置值（左 10 / 右 0 / 上 5 / 下 8）。
function applyTerminalPaddingVars() {
  const root = document.documentElement;
  const padding = terminalPaddingVars(terminalAppearance.value.settings);
  const entries: Array<[string, string | null]> = [
    ["--ssh-terminal-padding-left", padding.left],
    ["--ssh-terminal-padding-right", padding.right],
    ["--ssh-terminal-padding-top", padding.top],
    ["--ssh-terminal-padding-bottom", padding.bottom],
  ];
  for (const [name, value] of entries) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

/**
 * 外观改动落地：CSS 变量 + xterm 选项 + 主题 + OSC 颜色应答重挂。
 * 行高/字间距/内边距都会改变单元格尺寸，末尾必须 scheduleFit 重算行列。
 */
function applyTerminalAppearance() {
  applyTerminalPaddingVars();
  const theme = terminalTheme();
  document.documentElement.style.setProperty("--ssh-terminal-background", theme.background);
  if (!terminal) return;
  const patch = terminalOptionPatch(terminalAppearance.value.settings);
  terminal.options.fontWeight = patch.fontWeight;
  terminal.options.fontWeightBold = patch.fontWeightBold;
  terminal.options.lineHeight = patch.lineHeight;
  terminal.options.letterSpacing = patch.letterSpacing;
  terminal.options.cursorStyle = patch.cursorStyle;
  terminal.options.cursorBlink = patch.cursorBlink;
  terminal.options.cursorInactiveStyle = patch.cursorInactiveStyle;
  terminal.options.drawBoldTextInBrightColors = patch.drawBoldTextInBrightColors;
  terminal.options.minimumContrastRatio = patch.minimumContrastRatio;
  terminal.options.theme = theme;
  // 10/11 应答闭包捕获注册时的颜色值：配色切换后重挂，查询才返回新颜色。
  registerOscColorQueryHandlers();
  scheduleFit();
}

/** 外观设置局部更新（设置页控件）：归一化 → 持久化 → 即时应用。 */
function updateTerminalAppearance(patch: Partial<TerminalAppearanceSettings>) {
  terminalAppearance.value = {
    ...terminalAppearance.value,
    settings: sanitizeAppearanceSettings({ ...terminalAppearance.value.settings, ...patch }),
  };
  persistTerminalAppearance(terminalAppearance.value);
  applyTerminalAppearance();
}

/** 套用主题快照：设置 + 字体一起落地（字体走既有 terminalFont 键与链路）。 */
function applyTerminalAppearanceTheme(theme: TerminalAppearanceProfile) {
  terminalAppearance.value = { ...terminalAppearance.value, settings: sanitizeAppearanceSettings(theme.settings) };
  persistTerminalAppearance(terminalAppearance.value);
  // 主题里的字体为 null 表示「跟随宿主」：把字号键一起清掉（null），否则
  // 快照与实际态不一致、主题永远无法高亮。
  setTerminalFont(theme.font.family, theme.font.size);
  applyTerminalAppearance();
  showNotice(t("terminalAppearance.themeApplied", { name: t(theme.name) }));
}

/** 保存当前配置为「我的主题」（字体取缩放链路当前的覆盖态）。 */
function saveTerminalAppearanceTheme(name: string) {
  const theme: TerminalAppearanceProfile = {
    id: uniqueSchemeId(schemeIdFromName(name), terminalAppearance.value.customThemes.map((item) => item.id)),
    name,
    builtin: false,
    settings: sanitizeAppearanceSettings(terminalAppearance.value.settings),
    font: { family: terminalFontOverride.value.fontFamily, size: terminalFontOverride.value.fontSize },
  };
  const customThemes = [...terminalAppearance.value.customThemes, theme].slice(-CUSTOM_THEME_LIMIT);
  terminalAppearance.value = { ...terminalAppearance.value, customThemes };
  persistTerminalAppearance(terminalAppearance.value);
  showNotice(t("terminalAppearance.themeSaved", { name }));
}

function deleteTerminalAppearanceTheme(id: string) {
  terminalAppearance.value = {
    ...terminalAppearance.value,
    customThemes: terminalAppearance.value.customThemes.filter((theme) => theme.id !== id),
  };
  persistTerminalAppearance(terminalAppearance.value);
}

/**
 * 导入外部配色方案（Tabby/iTerm2/Windows Terminal/Xresources）：
 * 分配唯一 id、落盘；单个方案或首个方案按自身亮暗挂到对应槽位并切到
 * 「使用配色方案」——导入的意图通常就是立刻用上，否则用户还要再点一次。
 */
function addImportedSchemes(schemes: Array<Omit<TerminalColorScheme, "id" | "source">>) {
  const existing = terminalAppearance.value.customSchemes;
  const taken = existing.map((scheme) => scheme.id);
  const added: TerminalColorScheme[] = [];
  for (const item of schemes) {
    if (existing.length + added.length >= CUSTOM_SCHEME_LIMIT) break;
    const id = uniqueSchemeId(schemeIdFromName(item.name), taken);
    taken.push(id);
    added.push({ ...item, id, source: "custom" });
  }
  if (!added.length) {
    showNotice(t("terminalAppearance.importEmpty"));
    return;
  }
  const first = added[0];
  const slot = schemeTone(first) === "light" ? "lightSchemeId" : "darkSchemeId";
  terminalAppearance.value = {
    ...terminalAppearance.value,
    customSchemes: [...existing, ...added],
    settings: sanitizeAppearanceSettings({ ...terminalAppearance.value.settings, schemeSource: "custom", [slot]: first.id }),
  };
  persistTerminalAppearance(terminalAppearance.value);
  applyTerminalAppearance();
  showNotice(t("terminalAppearance.importImported", { count: added.length }));
}

/** 删除自定义方案：同时清掉引用它的槽位，避免持久化悬空 id。 */
function removeImportedScheme(id: string) {
  const scheme = terminalAppearance.value.customSchemes.find((item) => item.id === id);
  const settings = terminalAppearance.value.settings;
  terminalAppearance.value = {
    ...terminalAppearance.value,
    customSchemes: terminalAppearance.value.customSchemes.filter((item) => item.id !== id),
    settings: sanitizeAppearanceSettings({
      ...settings,
      darkSchemeId: settings.darkSchemeId === id ? null : settings.darkSchemeId,
      lightSchemeId: settings.lightSchemeId === id ? null : settings.lightSchemeId,
    }),
  };
  persistTerminalAppearance(terminalAppearance.value);
  applyTerminalAppearance();
  if (scheme) showNotice(t("terminalAppearance.schemeRemoved", { name: scheme.name }));
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
  // 终端底色：启用配色方案且背景来源为「方案」时取方案底色，否则宿主面板色。
  root.style.setProperty("--ssh-terminal-background", terminalTheme().background);
  followHostFonts(resolved);
  applyTerminalAppearance();
  if (terminal) {
    // 宿主下发的字体大小即缩放基准；外观切换后回到基准值，
    // 但用户单独调过的字号（issue #31 持久化覆盖）优先于宿主基准。
    terminalFontSize.value = terminalFontOverride.value.fontSize ?? resolved.terminal.fontSize;
    terminal.options.fontSize = terminalFontSize.value;
    scheduleFit();
  }
}

// vim/tmux/neovim 等启动时用 OSC 10/11 查询终端前景/背景色定调色板；xterm 内核
// 不应答，这里按当前主题补答（对标 electerm）。颜色"设置"分支交回内核处理。
function registerOscColorQueryHandlers() {
  for (const disposable of oscColorQueryDisposables) {
    if (disposable.dispose) disposable.dispose();
  }
  oscColorQueryDisposables = [];
  registerModeQueryHandlers();
  if (!terminal) return;
  const term = terminal;
  // 应答当前「生效」主题的前景/背景（宿主基底已被配色方案覆盖时返回方案色），
  // 否则 vim/tmux 会按宿主色板渲染，与屏幕实际底色不一致。
  const theme = terminalTheme();
  oscColorQueryDisposables.push(
    term.parser.registerOscHandler(10, (data) =>
      handleTerminalColorQuery(term, 10, theme.foreground, OSC_COLOR_FALLBACK.foreground, data),
    ),
    term.parser.registerOscHandler(11, (data) =>
      handleTerminalColorQuery(term, 11, theme.background, OSC_COLOR_FALLBACK.background, data),
    ),
  );
}

// CSI 能力查询应答只在终端创建时挂一次：应答与主题无关，无需随外观重挂。
function registerModeQueryHandlers() {
  for (const disposable of modeQueryDisposables) disposable.dispose();
  modeQueryDisposables = [];
  if (!terminal) return;
  const dispose = registerTerminalModeQueryHandlers(terminal);
  modeQueryDisposables.push({ dispose });
}

// 字体始终跟随宿主：不写内联字体变量——内联样式会压过 themeSync 桥样式表里的
// var(--font-sans)/var(--font-mono) 引用（这正是宿主全局字体此前不生效的根因），
// 撤出内联后桥引用直接命中宿主令牌，宿主改字体经 SDK 令牌推送自动跟随。
function followHostFonts(resolved: ReturnType<typeof resolveAppearance>) {
  const root = document.documentElement;
  root.style.removeProperty("--ui-font-family");
  root.style.removeProperty("--terminal-font-family");
  if (terminal) {
    // 用户单独设置过字体族时保持用户值（issue #31），否则跟随宿主。
    terminal.options.fontFamily = terminalFontOverride.value.fontFamily ?? hostTerminalFontFamily(resolved);
    scheduleFit();
  }
}

// xterm 需要具体字体串（不认 CSS 变量）：取 --terminal-font-family 的计算值
// （桥已把宿主令牌/回退解析好），计算值为空时回退 appearance 解析值。
function hostTerminalFontFamily(resolved: ReturnType<typeof resolveAppearance>): string {
  const computed = getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-family").trim();
  return computed || resolved.terminal.fontFamily;
}

// 宿主字体令牌经 SDK applyTheme 写 :root 内联样式推送（无事件通道）：观察
// style 属性变化，终端字体随之更新；插件自身写颜色令牌也会触发，
// 计算值未变时为空操作。
const hostFontObserver = new MutationObserver(() => {
  if (!terminal) return;
  // 用户单独设置过字体族时不跟随宿主字体变化（issue #31）。
  if (terminalFontOverride.value.fontFamily) return;
  const family = hostTerminalFontFamily(appearance.value);
  if (family !== terminal.options.fontFamily) {
    terminal.options.fontFamily = family;
    scheduleFit();
  }
});

function createTerminal() {
  if (!terminalHost.value || terminal) return;
  // 用户设置优先、未设置跟随宿主（issue #31）：合成一次，字号/字体族同步生效；
  // 重连/新开终端都经此路径拿到最终值。
  const font = resolveTerminalFont(terminalFontOverride.value, {
    fontFamily: hostTerminalFontFamily(appearance.value),
    fontSize: appearance.value.terminal.fontSize,
  });
  const optionPatch = terminalOptionPatch(terminalAppearance.value.settings);
  terminalFontSize.value = font.fontSize;
  const behaviorPatch = terminalBehaviorOptionPatch(terminalBehavior.value);
  terminal = new Terminal({
    convertEol: false,
    cursorBlink: optionPatch.cursorBlink,
    // 默认细竖线（bar）：块状光标在宽字距下显得笨重，竖线更接近常规输入框观感。
    // 具体形态由外观设置覆盖（样式/闪烁/失焦态三档）。
    cursorStyle: optionPatch.cursorStyle,
    cursorInactiveStyle: optionPatch.cursorInactiveStyle,
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    fontWeight: optionPatch.fontWeight,
    fontWeightBold: optionPatch.fontWeightBold,
    lineHeight: optionPatch.lineHeight,
    letterSpacing: optionPatch.letterSpacing,
    drawBoldTextInBrightColors: optionPatch.drawBoldTextInBrightColors,
    minimumContrastRatio: optionPatch.minimumContrastRatio,
    // 行为类选项（对标 Tabby「Terminal」页）：回滚行数默认与既有硬编码一致。
    scrollback: behaviorPatch.scrollback,
    scrollOnUserInput: behaviorPatch.scrollOnUserInput,
    wordSeparator: behaviorPatch.wordSeparator,
    ignoreBracketedPasteMode: behaviorPatch.ignoreBracketedPasteMode,
    macOptionIsMeta: behaviorPatch.macOptionIsMeta,
    // SearchAddon 的 highlight decorations 走 proposed API，缺这一项会在
    // findNext/registerDecoration 时直接抛 "allowProposedApi option"。
    allowProposedApi: true,
    theme: terminalTheme(),
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  // 链接点击处理器自持：既做「需按住修饰键才可点」的门禁，也复刻 addon 默认的
  // 反制反向标签劫持（开空白窗 → 清 opener → 导航），不给安全打折扣。
  terminal.loadAddon(new WebLinksAddon(openTerminalLink));
  terminal.open(terminalHost.value);
  // 对标 electerm 的终端体验增强（须在 open 之后挂载）：
  // - Unicode 11 宽度表：emoji/新版 CJK 符号按两列计宽，旧宽度表会错位对齐；
  // - 内联图像（sixel + iTerm2 OSC 1337）：imgcat/chafa/htop 图表可渲染，
  //   像素上限与 electerm 同款 32MiB。
  // 连字 addon（@xterm/addon-ligatures）暂不引入：其 opentype.js 依赖走 Node
  // 内置模块，Electron（electerm）可用，本插件的沙箱 iframe 模块求值即崩，
  // 上游尚无浏览器安全构建。
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  terminal.loadAddon(new ImageAddon({ pixelLimit: 33_554_432 }));
  registerOscColorQueryHandlers();
  osc52Disposable = terminal.parser.registerOscHandler(52, (data) =>
    handleOsc52ClipboardWrite(data, (text) => {
      // 远端主动写剪贴板同样进插件视图副本，供沙箱宿主的右键粘贴降级。
      terminalCopyCache.set(text);
      return writeClipboardText(text, clipboardDeps());
    }),
  );
  terminal.attachCustomKeyEventHandler(handleTerminalKey);
  searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
    if (!searchOpen.value) return;
    searchResultCount.value = resultCount;
    searchResultIndex.value = resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0;
    searchMatchState.value = resultCount > 0 ? "match" : "no-match";
  });
  // Named handler: main's WKWebView input-loss fallback shares this route.
  // Gate is local-terminal aware (a4): no SSH session AND no local shell means
  // there is no PTY to receive input.
  const routeTerminalData = (data: string) => {
    if (!session.value && !localSession.value) return;
    // 文件传输占用路由：trzsz 持有流时，传输中的输入进 filter（Ctrl+C 停传输、
    // 其余吞掉），等待协商期直接吞掉（防止杂散键入干扰 trz 握手）；zmodem 持有
    // 流时输入保持阻塞，否则走普通 PTY 键盘写入（8 字节序号前缀已封装）。
    const route = resolveTerminalInputRoute({ zmodemBusy: zmodemBusy.value, trzszBusy: trzszBusy.value });
    if (route === "trzsz") {
      if (trzszPhase.value === "transferring") trzszFilter?.processTerminalInput(data);
      terminalDiag.swallowed += 1;
      return;
    }
    if (route === "blocked") {
      terminalDiag.swallowed += 1;
      return;
    }
    // 命令建议（P1-1）：行快照先于 trackPendingInput 取（\r 会清空行缓冲），
    // 之后按输入事件推进抑制门并刷新浮层。快速命令/粘贴/自动应答不走路由，
    // 天然不会触发浮层，也不会进入采集。
    const lineBeforeInput = pendingTerminalInput;
    trackPendingInput(data);
    refreshSuggestionsAfterInput(data, lineBeforeInput);
    refreshGhostAfterInput(data);
    terminalDiag.keys += 1;
    sendTerminalBytes(new TextEncoder().encode(data));
  };
  disposeInput = terminal.onData(routeTerminalData);
  // xterm.js 6.1 still drops rapid direct commits on macOS WKWebView when an
  // IME reports printable keys as keyCode=229 (#5887/#6045/#6144 upstream).
  // The adapter runs before xterm's hidden textarea listeners and routes only
  // single-byte text outside real composition through the same PTY path.
  // 右键菜单打开时暂停直写捕获（P2-8）：菜单操作不该漏进 PTY。
  disposeWebkitInputFallback = installMacWebkitInputFallback({ terminal, onData: (data) => {
    if (terminalMenuOpen.value) return;
    routeTerminalData(data);
  } });
  // 选中复制（可在设置里关闭）：选择一变化即静默写入剪贴板，不弹提示。
  // 系统剪贴板写链可能整体失败（沙箱 iframe），插件视图副本必须照记——
  // 右键粘贴在宿主读链断掉时靠它兜底。
  disposeSelectionCopy = terminal.onSelectionChange(() => {
    if (!termSelectCopy.value || !terminal?.hasSelection()) return;
    const selection = terminal.getSelection();
    terminalCopyCache.set(selection);
    void writeClipboardText(selection, clipboardDeps()).catch(() => undefined);
  });
  // 终端响铃（对标 Tabby「Terminal → Sound」）：xterm 6.x 移除了 bellStyle，
  // 只在每次响铃时抛 onBell，因此「关闭 / 视觉 / 听觉」三态只能由这里自行实现。
  disposeTerminalBell = terminal.onBell(handleTerminalBell);
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
  if (webglEnabled.value && !wallpaperActive.value) {
    webglRenderer.value = attachWebglRenderer(terminal, () => new WebglAddon(), webglRecoveryOptions());
  }
  if (highlightEnabled.value) attachHighlightRender();
  if (actionLinksEnabled.value) attachActionLinks();
  if (isGutterActive()) attachGutterListeners();
  scheduleFit();
}

// 设置开关即时生效：开=挂 renderer（失败静默回退 DOM），关=dispose。
function setWebglEnabled(next: boolean) {
  webglEnabled.value = next;
  persistWebglEnabled(next);
  if (!terminal) return;
  webglRenderer.value = syncWebglRenderer(terminal, next, webglRenderer.value, () => new WebglAddon(), webglRecoveryOptions());
}

/**
 * 终端快捷键派发（对标 Tabby「Hotkeys」页）：先由 lib 侧把事件折算成规范组合串
 * （基于 event.code，Shift 恒保留为修饰键，故 Ctrl+= 与 Ctrl+Shift+= 不会塌成一个），
 * 再到用户可改写的注册表里查动作。lib 只做纯解析与匹配，命令执行留在 App。
 *
 * 默认表刻意不绑裸 Ctrl+A / Ctrl+C / Ctrl+F：这些要留给远端 shell 的
 * readline 与 SIGINT，只有 macOS 的 Cmd 系列、以及其余平台的 Ctrl+Shift 系列被占用。
 */
function handleTerminalKey(event: KeyboardEvent) {
  if (event.type !== "keydown") return true;
  // 右键菜单打开时暂停终端键盘捕获（P2-8）：按键归菜单导航，不落远端 shell
  // （macOS 直写路径已在 onData 包装层同步暂停）。不取消浏览器默认动作。
  if (terminalMenuOpen.value) return false;
  // xterm 的 false 只跳过终端处理，不会取消浏览器默认动作或冒泡。
  const consume = () => {
    event.preventDefault();
    event.stopPropagation();
    return false;
  };
  // IME 组合中不出 ghost（组合文本尚未落行；提交后的 onData 会重算）。
  if (event.isComposing || event.keyCode === 229) hideGhostSuggestion();
  // ghost 接受（→）：仅在无菜单态（浮层建议/结构化补全都未开）时消费一次，
  // 避免与 handleSuggestionKey/handleCompletionKey 的菜单按键语义冲突；
  // 补全菜单打开时 → 必须归 handleCompletionKey（其分支在本分支之后），
  // 故此处显式排除 completionOpen（旧 ghostMatch 可能在 onData 重算前残留）。
  // 无 ghost 的 → 原样放行给 shell。
  // 复查 commandRunning/传输占用（与 evaluateGhost 同门）：update 与 accept
  // 之间远端可能已开跑（回车竞态），不能把剩余字节打进运行中的命令。
  if (
    ghostMatch.value &&
    !suggestionOpen.value &&
    !completionOpen.value &&
    event.key === "ArrowRight" &&
    !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) &&
    !(commandRunning.value || terminalTransferBusy.value)
  ) {
    acceptGhostSuggestion();
    return consume();
  }
  // 命令建议浮层开启时优先消费导航/填充键（Tab 回车不落远端 shell）。
  // 结构化补全浮层（线 2）优先级更高，按键语义相同（↑↓/Tab/Enter/Esc）。
  if (completionOpen.value && handleCompletionKey(event)) return consume();
  if (suggestionOpen.value && handleSuggestionKey(event)) return consume();
  // 搜索框已打开时 Esc 先关面板，不参与快捷键匹配（关闭键不可改写）。
  {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.shiftKey && (event.key === "d" || event.key === "D")) {
      // 快速输入丢失诊断浮层（#33/#71）：三计数锁定丢失层，双击浮层关闭。
      terminalDiagVisible.value = !terminalDiagVisible.value;
      return consume();
    }
  }
  if (event.key === "Escape" && searchOpen.value) {
    closeTerminalSearch();
    return consume();
  }
  const combo = keyComboFromEvent(event);
  if (!combo) return true;
  switch (matchTerminalHotkey(terminalHotkeys.value, combo)) {
    case "search":
      openTerminalSearch();
      return consume();
    case "copy":
      // 无选区时不消费：裸 Ctrl+C 仍要作为 SIGINT 发给远端。
      if (!terminal?.hasSelection()) return true;
      void copyTerminalSelection();
      return consume();
    case "paste":
      // 不取消默认动作：放行浏览器原生 paste 事件（自带真实 clipboardData，
      // 沙箱 iframe 中无需剪贴板读权限），由 terminalHost 的 capture 拦截器
      // 统一走风险确认。stopPropagation 挡住宿主/文档级快捷键；返回 false
      // 让 xterm 跳过该键，否则 Ctrl+V 会先作为 ^V 字符发给远端。
      event.stopPropagation();
      return false;
    case "select-all":
      selectAllTerminal();
      return consume();
    case "clear":
      clearTerminal();
      return consume();
    case "zoom-in":
      adjustTerminalZoom(1);
      return consume();
    case "zoom-out":
      adjustTerminalZoom(-1);
      return consume();
    case "reset-zoom":
      resetTerminalZoom();
      return consume();
    case "scroll-to-top":
      terminal?.scrollToTop();
      return consume();
    case "scroll-to-bottom":
      terminal?.scrollToBottom();
      return consume();
    default:
      return true;
  }
}

/**
 * 终端响铃（对标 Tabby「Terminal → Sound」）：xterm 6.x 只抛 onBell、
 * 不再有 bellStyle，「视觉 / 听觉」两态在这里按设置自行实现。
 */
function handleTerminalBell() {
  if (terminalBehavior.value.bell === "visual") flashTerminalBell();
  else if (terminalBehavior.value.bell === "audible") playTerminalBell();
}

/**
 * 视觉响铃：给终端区域加一个短暂高亮类。先摘掉类、下一帧再加回，否则连续
 * 响铃时浏览器认为动画已在播放，不会重新触发。
 */
function flashTerminalBell() {
  window.clearTimeout(terminalBellFlashTimer);
  terminalBellFlash.value = false;
  terminalBellFlashTimer = window.setTimeout(() => {
    terminalBellFlash.value = true;
    terminalBellFlashTimer = window.setTimeout(() => {
      terminalBellFlash.value = false;
    }, TERMINAL_BELL_FLASH_MS);
  }, TERMINAL_BELL_RETRIGGER_MS);
}

/**
 * 听觉响铃：不引入音频资源（仓库规则禁止新增运行时依赖，二进制资源也无必要），
 * 用 WebAudio 现场合成一声短促正弦提示音。AudioContext 懒建并复用。沙箱可能
 * 直接拒绝构造，或自动播放策略让声音静默挂起；两种情况下都退化为视觉闪动，
 * 保证响铃至少有可见反馈，不抛错打断终端。
 */
function playTerminalBell() {
  try {
    bellAudioContext ??= new AudioContext();
    const context = bellAudioContext;
    void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = TERMINAL_BELL_FREQUENCY_HZ;
    const startedAt = context.currentTime;
    // 用指数包络避免方波式的爆音；起止值不能为 0（指数斜坡不接受 0）。
    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(TERMINAL_BELL_GAIN, startedAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + TERMINAL_BELL_DURATION_S);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startedAt);
    oscillator.stop(startedAt + TERMINAL_BELL_DURATION_S);
  } catch {
    flashTerminalBell();
  }
}

/**
 * 链接点击（对标 Tabby「Mouse → Require a key to click links」）：链接修饰键未按下
 * 时直接忽略，把点击还给下面的终端内容。
 *
 * 打开动作逐句复刻 addon 内置处理器（先开空窗拿句柄 → 清 opener → 改写 location），
 * 只是多了上面这道修饰键闸门：清 opener 是防「反向标签劫持」的关键，不能省。
 * 沙箱 iframe 未开 allow-popups 时 window.open 会返回 null，此时静默放弃。
 */
function openTerminalLink(event: MouseEvent, uri: string) {
  if (!isLinkModifierSatisfied(terminalBehavior.value, event)) return;
  const opened = window.open();
  if (!opened) return;
  try {
    opened.opener = null;
  } catch {
    // Electron 等环境写入 opener 会抛错；与内置处理器同样忽略。
  }
  opened.location.href = uri;
}

/**
 * 中键粘贴（对标 Tabby「Mouse → Paste on middle-click」，默认关闭）。
 * 仅当设置开启时消费事件：默认放行，保持浏览器既有行为不变。
 */
function handleTerminalMiddleClick(event: MouseEvent) {
  if (!terminalBehavior.value.pasteOnMiddleClick) return;
  event.preventDefault();
  terminalMenuOpen.value = false;
  fileMenu.value = undefined;
  void pasteTerminal();
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
  // 主题可能自带字号（外观快照的 font.size）：复位回到「主题基准」，没有主题
  // 或主题未指定字号时才回宿主基准（= 既有行为）。
  const base = terminalAppearance.value.font.size ?? appearance.value.terminal.fontSize;
  if (terminalFontSize.value === base) return;
  applyTerminalFontSize(base);
}

/**
 * 字体落地唯一入口：内存覆盖态 + terminalFont 两个键 + xterm 生效值。
 * `size` 允许为 null（跟随宿主字号）——主题快照的「未指定」语义靠它表达，
 * 若在此处把 null 折成宿主具体值，快照与实况就会永远不相等、主题无法高亮。
 */
function setTerminalFont(family: string | null, size: number | null) {
  terminalFontOverride.value = { fontFamily: family, fontSize: size };
  persistTerminalFontFamily(family);
  persistTerminalFontSize(size);
  const effectiveSize = size ?? appearance.value.terminal.fontSize;
  terminalFontSize.value = effectiveSize;
  if (terminal) {
    terminal.options.fontFamily = family ?? hostTerminalFontFamily(appearance.value);
    terminal.options.fontSize = effectiveSize;
    scheduleFit();
  }
}

// 缩放只动字号：同步内存覆盖态并经 lib 持久化（键与解析逻辑集中在 terminalFont.ts）。
function applyTerminalFontSize(size: number) {
  setTerminalFont(terminalFontOverride.value.fontFamily, size);
  window.clearTimeout(zoomNoticeTimer);
  zoomNoticeTimer = window.setTimeout(() => showNotice(t("terminalZoom.fontSize", { size })), 500);
}

// 应用用户字体设置并持久化：family null = 恢复跟随宿主。立即生效并 toast 反馈。
function applyTerminalFontSettings(family: string | null, size: number) {
  const followHost = family == null;
  setTerminalFont(family, size);
  showNotice(followHost ? t("terminalFont.resetDone") : t("terminalFont.applied", { size }));
}

function openTerminalSearch() {
  if (!terminal) return;
  terminalMenuOpen.value = false;
  // iTerm2 风格：打开搜索时用当前选区首行预填查询，并带入持久化的选项开关。
  searchSeedQuery.value = terminalSearchSeedFromSelection(terminal.getSelection() || "");
  searchSeedOptions.value = sanitizeSearchOptions(pluginStore.getItem(TERMINAL_SEARCH_OPTIONS_KEY));
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

// ---------------------------------------------------------------------------
// 命令输入建议浮层（P1-1）：采集→抑制门→检索→定位→按键消费。
// 采集只走两条真实来源：① 命令弹窗/命令条执行（已入 commandHistory）；
// ② OSC 633 shell-integration E 帧（applyCommandMarker）。无 shell
// integration 的 SSH 会话不做按键模拟式采集（真实降级）；Expect/OTP 自动
// 应答由 sidecar 直接注入 PTY，与 onData 用户输入不同源，永不入历史。
// ---------------------------------------------------------------------------

function closeSuggestions() {
  suggestionOpen.value = false;
  suggestionItems.value = [];
  suggestionActiveIndex.value = 0;
  // 结构化补全浮层与历史建议浮层同一生命周期（Ctrl+C/回车/Esc 同步关闭）。
  closeCompletionMenu();
}

function suggestionSearchBounds() {
  return {
    minLength: Math.max(1, suggestionMinCharsState.value),
    maxLength: Math.max(suggestionMinCharsState.value, suggestionMaxCharsState.value),
  };
}

function runSuggestionSearch(query: string): CommandSuggestion[] {
  const bounds = suggestionSearchBounds();
  return searchCommands(query, { history: commandHistory.value, quickCommands: quickCommands.value }, { ...bounds, limit: 12 });
}

/** 单字符输入事件抽取：多字符粘贴 / 控制序列 / 回车返回 null。 */
function suggestionTypingChar(data: string): string | null {
  if (data.length !== 1) return null;
  const char = data.charAt(0);
  if (char < " " || char === "\u007f") return null;
  return char;
}

/**
 * onData 每次输入后调用：推进抑制门状态并按需刷新浮层。
 * lineBefore 是本次输入前的行缓冲快照（\r 清空后仍能取到被执行的命令行）。
 */
function refreshSuggestionsAfterInput(data: string, lineBefore: string) {
  const alternateActive = terminal?.buffer.active.type === "alternate";
  const typingChar = suggestionTypingChar(data);

  if (data.includes("\u0003")) {
    // Ctrl+C：打断当前行与跟随程序，锁存解除，浮层关闭。
    suggestionGuardState = canShowSuggestions({ alternateActive, lastCommand: null, typingChar: "\u0003" }, suggestionGuardState).state;
    lastTerminalCommand.value = null;
    closeSuggestions();
    return;
  }
  if (data.includes("\r") || data.includes("\n")) {
    const executed = lineBefore.trim();
    if (executed) lastTerminalCommand.value = executed;
    suggestionGuardState = canShowSuggestions({ alternateActive, lastCommand: lastTerminalCommand.value, typingChar: null }, suggestionGuardState).state;
    closeSuggestions();
    return;
  }
  if (data.includes("\u001b")) {
    // 方向键/控制序列：不当作输入，浮层保持原状之外直接隐藏（无法追踪行内容）。
    closeSuggestions();
    return;
  }

  const guard = canShowSuggestions(
    { alternateActive, lastCommand: lastTerminalCommand.value, typingChar, lineEmpty: lineBefore.length === 0 },
    suggestionGuardState,
  );
  suggestionGuardState = guard.state;
  if (!guard.show || !suggestionsEnabledState.value) {
    closeSuggestions();
    return;
  }
  // 结构化补全（线 2）优先：行缓冲命中 spec 且有候选时展示结构化菜单并
  // 跳过历史模糊建议；未命中回落下方历史建议浮层（两者并存、不替换）。
  if (completionSpecEnabled()) {
    const specMatch = matchSpecLine(pendingTerminalInput, COMPLETION_SPECS);
    if (specMatch && specMatch.rows.length) {
      suggestionOpen.value = false;
      suggestionItems.value = [];
      openCompletionMenu(specMatch.commandPath, specMatch.level, specMatch.rows);
      return;
    }
  }
  closeCompletionMenu();
  const query = pendingTerminalInput;
  const bounds = suggestionSearchBounds();
  if (!commandSuggestionQueryAcceptable(query, bounds.minLength, bounds.maxLength)) {
    closeSuggestions();
    return;
  }
  const items = runSuggestionSearch(query);
  if (!items.length) {
    closeSuggestions();
    return;
  }
  suggestionQuery.value = query;
  suggestionItems.value = items;
  suggestionActiveIndex.value = 0;
  suggestionAnchor.value = readTerminalSuggestionAnchor();
  suggestionOpen.value = true;
}

/**
 * 光标像素锚点：xterm 私有渲染尺寸（css.cell 宽高）× 光标缓冲坐标。
 * 读不到（渲染器未就绪/内部结构变化）返回 null，浮层降级贴终端底部。
 */
function readTerminalSuggestionAnchor(): { x: number; y: number } | null {
  if (!terminal || !terminalHost.value) return null;
  try {
    const core = (terminal as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const cellWidth = cell?.width ?? 0;
    const cellHeight = cell?.height ?? 0;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return null;
    const buffer = terminal.buffer.active;
    // cursorY 已是视口内相对行；旧式 `cursorY - viewportY` 在回滚区出现后为负，浮层画出画布。
    const visibleRow = cursorViewportRow(buffer);
    return { x: Math.round(buffer.cursorX * cellWidth), y: Math.round((visibleRow + 1) * cellHeight) };
  } catch {
    return null;
  }
}

/** 浮层开启时的按键消费：↑↓ 选择、Tab 填充、Enter 执行、Esc 关闭。 */
function handleSuggestionKey(event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || !suggestionOpen.value || !suggestionItems.value.length) return false;
  const items = suggestionItems.value;
  if (event.key === "ArrowDown") {
    suggestionActiveIndex.value = (suggestionActiveIndex.value + 1) % items.length;
    return true;
  }
  if (event.key === "ArrowUp") {
    suggestionActiveIndex.value = (suggestionActiveIndex.value - 1 + items.length) % items.length;
    return true;
  }
  if (event.key === "Tab") {
    fillSuggestion(items[suggestionActiveIndex.value]);
    return true;
  }
  if (event.key === "Enter") {
    executeSuggestion(items[suggestionActiveIndex.value]);
    return true;
  }
  if (event.key === "Escape") {
    closeSuggestions();
    return true;
  }
  return false;
}

/** 把当前输入行替换为建议命令（退格抹掉已敲字符后按键盘语义重新写入）。 */
function replaceTerminalLineWith(nextLine: string, pressEnter: boolean) {
  if (!terminal) return;
  const erase = "\u007f".repeat(pendingTerminalInput.length);
  const payload = erase + nextLine + (pressEnter ? "\r" : "");
  pendingTerminalInput = pressEnter ? "" : nextLine;
  if (pressEnter) {
    lastTerminalCommand.value = nextLine;
    commandHistory.value = pushCommandHistory(commandHistory.value, nextLine);
    persistCommandHistory();
  }
  sendTerminalBytes(new TextEncoder().encode(payload));
}

function fillSuggestion(item: CommandSuggestion) {
  replaceTerminalLineWith(item.command, false);
  // 填充后按新行内容刷新候选（可能只剩自身），保持浮层继续可微调。
  const items = runSuggestionSearch(item.command);
  if (items.length) {
    suggestionItems.value = items;
    suggestionActiveIndex.value = Math.max(0, items.findIndex((entry) => entry.command === item.command));
    suggestionQuery.value = item.command;
    suggestionAnchor.value = readTerminalSuggestionAnchor();
  } else {
    closeSuggestions();
  }
  terminal?.focus();
}

function executeSuggestion(item: CommandSuggestion) {
  replaceTerminalLineWith(item.command, true);
  closeSuggestions();
  terminal?.focus();
}

// ---------------------------------------------------------------------------
// 终端行内 ghost 自动建议（对标 Warp/fish autosuggest）：门状态机与前缀扩展
// 匹配在 lib/terminalGhostSuggest.ts，这里只做三件事——xterm buffer 行尾采样、
// overlay 锚点计算、接受时向 PTY 注入剩余字节（等价用户键入，无协议改动）。
// 渲染选 overlay DOM 而非 xterm decoration：ghost 逐键刷新，decoration 注册/
// 销毁生命周期重；overlay 与既有 action-link-hint 同机制，零 buffer 侵入，
// 不影响选区/搜索/屏幕阅读器。
// ---------------------------------------------------------------------------

/** 设置开关（SettingsDialog 自治持久化，经 update:ghost-suggest 即时上抛）。 */
function setGhostEnabled(next: boolean) {
  ghostEnabled.value = next;
  if (!next) hideGhostSuggestion();
}

function hideGhostSuggestion() {
  ghostMatch.value = null;
}

/** 会话切换/断开：门锁存与展示一并复位（与 closeSuggestions 同点调用）。 */
function resetGhostSuggestion() {
  ghostGate = createGhostState();
  ghostMatch.value = null;
}

/**
 * 光标行采样：光标右侧到行尾无字符、且逻辑行未向下折行时视为「光标在行尾」。
 * 纯 buffer 读取，与字宽无关；读不到 buffer（渲染器未就绪/备用屏）时保守返回
 * false——不出 ghost 优于错位注入。
 */
function terminalCursorAtLineEnd(): boolean {
  if (!terminal) return false;
  try {
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal") return false;
    // 光标行按缓冲绝对行号采样：baseY + cursorY（cursorY 是视口内相对行，
    // viewportY 随用户滚动偏移，`cursorY + viewportY` 上滚时会采到滚回区旧行）。
    const rowY = cursorAbsoluteRow(buffer);
    const row = buffer.getLine(rowY);
    if (!row) return false;
    for (let x = buffer.cursorX; x < terminal.cols; x += 1) {
      if (row.getCell(x)?.getChars()) return false;
    }
    // 折行命令的后续视觉行仍属同一逻辑行：光标在视觉行尾 ≠ 逻辑行尾。
    if (buffer.getLine(rowY + 1)?.isWrapped) return false;
    return true;
  } catch {
    return false;
  }
}

/** ghost 专用锚点：光标像素坐标（灰字从光标格起绘，y 取光标行行顶）。 */
function readGhostAnchor(): { x: number; y: number } | null {
  if (!terminal || !terminalHost.value) return null;
  try {
    const core = (terminal as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const cellWidth = cell?.width ?? 0;
    const cellHeight = cell?.height ?? 0;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return null;
    const buffer = terminal.buffer.active;
    // cursorY 已是视口内相对行；旧式 `cursorY - viewportY` 在回滚区出现后为负，ghost 画出画布。
    const visibleRow = cursorViewportRow(buffer);
    return { x: Math.round(buffer.cursorX * cellWidth), y: Math.round(visibleRow * cellHeight) };
  } catch {
    return null;
  }
}

/** onData 每次输入后调用：推进门状态并重算 ghost（与浮层建议同一采样点）。 */
function refreshGhostAfterInput(data: string) {
  ghostGate = nextGhostState(ghostGate, classifyGhostInput(data));
  updateGhostSuggestion();
}

function updateGhostSuggestion() {
  // 浮层建议/结构化补全菜单开着时不出 ghost：菜单占用 →/Enter/Esc，与
  // 「→ 仅在无菜单态下接受」一致，同屏叠两层建议也无法阅读。
  if (ghostMenuSuppressed(suggestionOpen.value, completionOpen.value)) {
    ghostMatch.value = null;
    return;
  }
  const evaluation = evaluateGhost({
    state: ghostGate,
    line: pendingTerminalInput,
    cursorAtLineEnd: terminalCursorAtLineEnd(),
    enabled: ghostEnabled.value,
    // 远端命令执行中 / zmodem、trzsz 传输占用流时不出建议（任务约束）。
    commandRunning: commandRunning.value || terminalTransferBusy.value,
    compositionActive: false,
    sources: { history: commandHistory.value, quickCommands: quickCommands.value },
    bounds: {
      minLength: Math.max(1, suggestionMinCharsState.value),
      maxLength: Math.max(suggestionMinCharsState.value, suggestionMaxCharsState.value),
      limit: 12,
    },
  });
  ghostMatch.value = evaluation.match;
  if (evaluation.match) ghostAnchor.value = readGhostAnchor();
}

/** → 接受：向 PTY 注入剩余字节（等价用户逐键键入；按键轨迹缓冲同步补齐）。 */
function acceptGhostSuggestion() {
  const match = ghostMatch.value;
  if (!match || !match.remainder) return;
  ghostMatch.value = null;
  pendingTerminalInput += match.remainder;
  sendTerminalBytes(new TextEncoder().encode(match.remainder));
  // 接受后按新行重算：更长同前缀历史可继续 → 扩展（fish 同款行为）。
  updateGhostSuggestion();
}

function sendTerminalBytes(data: Uint8Array) {
  // 串口会话优先：B1 主路径走 `serial/terminal/in/{id}` 二进制写通道（专用
  // 有序队列 + Stdin 流标签帧）；宿主报错（未知通道/旧 sidecar）一次性降级
  // serial/write JSON 兼容路径。
  if (serialSession.value) {
    // 上传进行中吞掉键入：X/Y/ZMODEM 的 ACK/NAK/CAN 控制字符窗口内，
    // 用户字节会污染协议流（进度状态在终端 overlay 上提示"传输中"）。
    // B1 互斥：二进制写帧与 JSON 键入共用这道前端闸门；sidecar 侧另有
    // 二进制帧拒收后盾。
    if (serialUploadBusy.value) return;
    if (serialBinaryInput.value) {
      serialInputQueue.enqueue(`serial:${serialSession.value.sessionId}`, normalizeTerminalInputBytes(data));
      return;
    }
    const dataBase64 = window.dbxPlugin.encodeBase64(normalizeTerminalInputBytes(data));
    void window.dbxPlugin.invoke("serial/write", { sessionId: serialSession.value.sessionId, dataBase64 }).catch((cause) => showError(cause, "terminal"));
    return;
  }
  // Telnet 会话优先：同一终端视图同一时刻只挂一个会话（SSH/本地/Telnet 互斥），
  // telnet: 前缀在队列 send 回调里拆成 telnet/terminal/in/{id} 通道。
  if (telnetSession.value) {
    terminalInputQueue.enqueue(`telnet:${telnetSession.value.sessionId}`, normalizeTerminalInputBytes(data));
    return;
  }
  const sessionId = localSession.value?.sessionId ?? session.value?.sessionId;
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
      if (telnetSession.value) {
        // Telnet NAWS：sidecar 发 SB NAWS 子协商，尽力而为。
        void window.dbxPlugin.notify("telnet/resize", { sessionId: telnetSession.value.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      } else if (localSession.value) {
        void window.dbxPlugin.notify("local/terminal/resize", { sessionId: localSession.value.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      } else if (session.value) {
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
  // 会话切换/断开：建议浮层与抑制门锁存一并复位（P1-1）；ghost 门同步复位。
  closeSuggestions();
  suggestionGuardState = createSuggestionGuardState();
  lastTerminalCommand.value = null;
  resetGhostSuggestion();
}

function applyCommandMarker(updates: Osc633StreamUpdates) {
  if (updates.shellIntegrationInstalled !== undefined) commandMarker.installed = updates.shellIntegrationInstalled;
  if (updates.commandActive !== undefined) commandMarker.active = updates.commandActive;
  if (updates.command !== undefined) commandMarker.command = updates.command;
  // A fresh "E" frame starts a new command: clear the previous result so the
  // strip flips to the running state. The "A" frame's lastExitCode=null reset
  // is ignored on purpose — the finished result stays visible at the prompt
  // until the next command starts.
  // 最近命令收集：仅 E 帧写 updates.command，故以其存在为准——不能挂在
  // commandActive 上，E 与 D 常在同一段输出里（命令快进快出时合并后的终值
  // 是 false），挂在 phase 上会漏采（与 D/A 退出码覆写同源的合并陷阱）。
  if (updates.command !== undefined && updates.command.trim()) {
    const command = updates.command.trim();
    lastTerminalCommand.value = command;
    // 命令历史采集（P1-1）：shell integration 会话（本地 + SSH）把 E 帧命令行
    // 写入 commandHistory 环形；持久化沿用 SECRET_LIKE/长度过滤，命令执行中
    // 顺带收起浮层。与 onData 回车行采集去重由 pushCommandHistory 保证。
    commandHistory.value = pushCommandHistory(commandHistory.value, command);
    persistCommandHistory();
    if (isLocalMode.value && command !== localRecentCommands.value[0]) {
      localRecentCommands.value = [command, ...localRecentCommands.value.filter((c) => c !== command)].slice(0, 20);
    }
    closeSuggestions();
  }
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
    if (updates.cwd) terminalCwd.value = updates.cwd;
    if (isLocalMode.value) localLastCwd.value = updates.cwd;
    // OSC 633 Cwd doubles as a directory-follow fallback when the backend could
    // not install OSC 7 tracking but the remote shell integration emits 633 frames.
    if (followDirectory.value && directoryTrackingSupported.value === false && updates.cwd) {
      void loadDirectory(updates.cwd, true);
    }
  }
}

function writeTerminalOutput(data: Uint8Array) {
  for (const path of directoryParser.push(data)) {
    terminalCwd.value = path;
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
  terminalMenuOpen.value = false;
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
  if (event.channel.startsWith("local/terminal/out/")) {
    const localId = event.channel.slice("local/terminal/out/".length);
    if (!localSession.value || localId !== localSession.value.sessionId) return;
    const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
    if (payload.length < 9) return;
    const sequence = readU64(payload, 1);
    if (sequence <= localLastSequence.value) return;
    localPendingFrames.set(sequence, { stream: payload[0], data: payload.slice(9) });
    drainLocalTerminalFrames();
    return;
  }
  if (event.channel.startsWith("telnet/terminal/out/")) {
    // Telnet 输出帧与 local/SSH 同形（9 字节 TerminalFrame 前缀），独立
    // sequence/pending 状态避免与 SSH/本地流互染。
    const telnetId = event.channel.slice("telnet/terminal/out/".length);
    if (!telnetSession.value || telnetId !== telnetSession.value.sessionId) return;
    const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
    if (payload.length < 9) return;
    const sequence = readU64(payload, 1);
    if (sequence <= telnetLastSequence.value) return;
    telnetPendingFrames.set(sequence, { stream: payload[0], data: payload.slice(9) });
    drainTelnetFrames();
    return;
  }
  if (event.channel.startsWith("serial/terminal/out/")) {
    // 串口输出帧与 local/SSH/Telnet 同形（9 字节 TerminalFrame 前缀，stream
    // 恒为 Stdout），独立 sequence/pending 状态避免与其它会话流互染。
    const serialId = event.channel.slice("serial/terminal/out/".length);
    if (!serialSession.value || serialId !== serialSession.value.sessionId) return;
    const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
    if (payload.length < 9) return;
    // B1 解码契约：未知流标签（> Stdin=3）一律静默丢帧并计数，不断连。
    if (!isKnownStreamTag(payload[0])) {
      serialUnknownStreamFrames += 1;
      return;
    }
    const sequence = readU64(payload, 1);
    if (sequence <= serialLastSequence.value) return;
    serialPendingFrames.set(sequence, { stream: payload[0], data: payload.slice(9) });
    drainSerialFrames();
    return;
  }
  if (event.channel.startsWith("vnc/frame/")) {
    // VNC 帧补丁（44 字节头 + RGBA payload，sidecar 单调递增 sequence）。
    // 交给 VncSurface 解码 + rAF 合帧绘制；乱序帧在组件内丢弃。
    const vncId = event.channel.slice("vnc/frame/".length);
    if (!vncSession.value || vncId !== vncSession.value.sessionId) return;
    const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
    if (vncState.value !== "running") vncState.value = "running";
    vncSurface.value?.acceptFrame(payload);
    return;
  }
  if (event.channel.startsWith("rdp/frame/")) {
    // RDP 帧补丁：与 vnc/frame 同一 44 字节 patch 头 + RGBA（解码复用
    // vncFrame），sequence 跨重连单调。首个桌面帧同时把状态推到 running。
    const rdpId = event.channel.slice("rdp/frame/".length);
    if (!rdpSession.value || rdpId !== rdpSession.value.sessionId) return;
    const payload = bridgeBinaryBytes(event, window.dbxPlugin.decodeBase64);
    if (rdpState.value.state !== "running") rdpState.value = { ...rdpState.value, state: "running" };
    rdpSurface.value?.acceptFrame(payload);
    return;
  }
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
    // A session-gone replay failure must resync and reconnect: the hole can
    // never be filled (the session object is gone server-side), so the
    // ssh-transport-disconnected state frame stuck behind it would otherwise
    // freeze the drain forever and the tab keeps claiming "connected".
    let sessionGone = false;
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
      .catch((cause) => {
        if (isSessionGoneError(cause) && firstPending > lastSequence) {
          sessionGone = true;
          lastSequence = firstPending - 1;
          replayNoProgress = 0;
          return;
        }
        showError(cause, "terminal");
      })
      .finally(() => {
        replayInFlight = false;
        drainTerminalFrames();
        // Run after the resync drain above delivered the buffered disconnect
        // state frame (it flips the state off "connected"); the ladder then
        // picks the reconnect up unless one is already pending.
        if (sessionGone && !reconnectPending.value && !disposed) scheduleSessionReconnect();
      });
  }
}

// 本地终端输出与 SSH 同一帧协议（stream + u64 sequence），复用乱序重组与
// 空洞补发；补发失败或 State 帧到来即落退出态——本地会话重启成本极低，
// 不需要 SSH 那套不可恢复横幅。
function drainLocalTerminalFrames() {
  let frame = localPendingFrames.get(localLastSequence.value + 1);
  while (frame) {
    localPendingFrames.delete(localLastSequence.value + 1);
    localLastSequence.value += 1;
    if (frame.stream === 2) {
      if (new TextDecoder().decode(frame.data) === "local-terminal-exited") markLocalExited(null);
    } else {
      dispatchTerminalOutput(frame.data);
    }
    frame = localPendingFrames.get(localLastSequence.value + 1);
  }
  if (localPendingFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    localPendingFrames.clear();
  }
  const firstPending = Math.min(...localPendingFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > localLastSequence.value + 1 && !localReplayInFlight && localSession.value) {
    const sessionId = localSession.value.sessionId;
    localReplayInFlight = true;
    const holeAt = localLastSequence.value;
    void window.dbxPlugin
      .invoke<ReplayResult>("local/terminal/replay", { sessionId, afterSequence: localLastSequence.value })
      .then((result) => {
        if (!result.complete) {
          markLocalExited(null);
          return;
        }
        if (localLastSequence.value === holeAt) {
          localReplayNoProgress += 1;
          if (localReplayNoProgress >= 3) {
            localLastSequence.value = firstPending - 1;
            localReplayNoProgress = 0;
          }
        } else {
          localReplayNoProgress = 0;
        }
      })
      .catch(() => markLocalExited(null))
      .finally(() => {
        localReplayInFlight = false;
        drainLocalTerminalFrames();
      });
  }
}

// 传输断开/会话被杀的统一入口：有界退避自动重连，梯子耗尽才落到
// disconnected 终态等待手动重连。
function scheduleSessionReconnect() {
  if (!disposed && reconnectAttempt < TERMINAL_RECONNECT_DELAYS.length) {
    const delay = terminalReconnectDelay(reconnectAttempt++);
    terminalState.value = "connecting";
    reconnectPending.value = true;
    reconnectTimer = window.setTimeout(() => {
      if (disposed) return;
      // 梯子第一级重试前先请宿主按最新配置重开连接（与手动 reconnect 同路径）：
      // 侧边栏编辑连接（改密码等）会让 sidecar 凭据过期，缺这步自动重连必撞
      // 旧凭据、落到红色错误态等手动自救——凭据已是新的时这是一次假错误。
      if (reconnectAttempt === 1) void requestHostReopenConnection().finally(() => { if (!disposed) void openSession(); });
      else void openSession();
    }, delay);
    return;
  }
  terminalState.value = "disconnected";
  reconnectPending.value = false;
  terminalError.value = t("transportDisconnected");
}

function handleEvent(event: DbxPluginEvent) {
  if (event.method === "ssh/terminal/inputAck") {
    terminalDiag.acks += 1;
    return;
  }
  if (event.method === "ssh/batchBar/state") {
    const params = event.params as { source?: string; draft?: string; quickPickId?: string; open?: boolean };
    if (params.source && params.source !== batchBarSourceId) applyRemoteBatchBarState(params);
    return;
  }
  if (event.method === "ssh/host-key/prompt" || event.method === "connection/challenge") {
    // RDP 证书确认（kind=rdp-certificate）路由到专属弹窗：SHA256 指纹 +
    // knownHostStatus + 120s 倒计时；其余挑战沿用 host-key 弹窗。
    const challengeParams = event.params as Record<string, unknown>;
    if (isRdpCertificateChallenge(challengeParams)) {
      rdpCertPrompt.value = {
        challengeId: String(challengeParams.challengeId),
        sessionId: String(challengeParams.sessionId || ""),
        host: String(challengeParams.host || ""),
        port: Number(challengeParams.port) || 3389,
        fingerprint: String(challengeParams.fingerprint || ""),
        knownHostStatus: String(challengeParams.knownHostStatus || "unknown"),
        receivedAt: Date.now(),
      };
      rdpCertRemember.value = false;
      return;
    }
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
      scheduleSessionReconnect();
    }
    return;
  }
  // Input hit a session the sidecar no longer has (host-pushed disconnect the
  // tab missed, sidecar restart): the terminal still looks alive but every
  // keystroke is swallowed. The sidecar mirrors binary-handler failures as
  // this event; treat it as the same transport-drop ladder. Guarded so a
  // reconnect already in flight is not double-scheduled.
  if (event.method === "ssh/terminal/error" && event.params.sessionId === session.value?.sessionId) {
    if (terminalState.value === "connected" && !reconnectPending.value) {
      scheduleSessionReconnect();
    }
    return;
  }
  if (event.method === "local/session/state" && event.params.sessionId === localSession.value?.sessionId) {
    if (event.params.state === "exited") {
      markLocalExited(typeof event.params.exitCode === "number" ? event.params.exitCode : null);
    }
    return;
  }
  // 输入打进已被 sidecar 回收的本地会话：立即落退出态（覆盖层给重开出口）。
  if (event.method === "local/terminal/error" && event.params.sessionId === localSession.value?.sessionId) {
    markLocalExited(null);
    return;
  }
  // Telnet 生命周期：connecting → connected → closed（error 附带原因文本，
  // 只在退出覆盖层展示）。侧边触发引擎反馈与 ssh/trigger 同构（无应答内容）。
  if (event.method === "telnet/session/state" && event.params.sessionId === telnetSession.value?.sessionId) {
    const state = String(event.params.state || "");
    if (state === "connected") {
      telnetState.value = "running";
      telnetError.value = "";
    } else if (state === "connecting") {
      telnetState.value = "connecting";
    } else if (state === "closed" || state === "error") {
      markTelnetClosed(state === "error" ? String(event.params.error || "") : "");
    }
    return;
  }
  if (event.method === "telnet/terminal/error" && event.params.sessionId === telnetSession.value?.sessionId) {
    markTelnetClosed(null);
    return;
  }
  // VNC 生命周期：connecting → connected → closed/error（error 附带原因）。
  // 远端剪贴板更新回写本地（iframe 沙箱可能拒绝剪贴板写，尽力而为）。
  if (event.method === "vnc/session/state" && event.params.sessionId === vncSession.value?.sessionId) {
    const state = String(event.params.state || "");
    if (state === "connected") {
      vncState.value = "running";
      vncError.value = "";
    } else if (state === "connecting") {
      vncState.value = "connecting";
    } else if (state === "closed" || state === "error") {
      markVncClosed(state === "error" ? String(event.params.error || "") : "");
    }
    return;
  }
  if (event.method === "vnc/clipboard" && event.params.sessionId === vncSession.value?.sessionId) {
    const text = typeof event.params.text === "string" ? event.params.text : "";
    if (text) {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          // 远端复制频繁时节流提示（8s 内只提示一次）。
          if (Date.now() - vncClipboardNoticeAt > 8000) {
            vncClipboardNoticeAt = Date.now();
            showNotice(t("vnc.clipboardReceived"));
          }
        })
        .catch(() => undefined);
    }
    return;
  }
  // RDP 生命周期（RDP-3 前端）：connecting → connected → (reconnecting →)
  // connected/closed，errorKind/error 文本在退出覆盖层展示；重连退避进度
  // （attempt/maxAttempts）驱动 reconnecting 状态条。状态折叠走纯 reducer。
  if (event.method === "rdp/session/state" && event.params.sessionId === rdpSession.value?.sessionId) {
    rdpState.value = reduceRdpSessionState(rdpState.value, event.params as Record<string, unknown>);
    return;
  }
  // 远端 → 本地剪贴板（text-only，CF_UNICODETEXT）：回写本地 + 节流提示，与 VNC 同款。
  if (event.method === "rdp/clipboard" && event.params.sessionId === rdpSession.value?.sessionId) {
    const text = typeof event.params.text === "string" ? event.params.text : "";
    if (text) {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          if (Date.now() - rdpClipboardNoticeAt > 8000) {
            rdpClipboardNoticeAt = Date.now();
            showNotice(t("rdp.clipboardReceived"));
          }
        })
        .catch(() => undefined);
    }
    return;
  }
  // 服务端光标形状（default/hidden/position/bitmap）：落到画布 CSS cursor。
  if (event.method === "rdp/pointer" && event.params.sessionId === rdpSession.value?.sessionId) {
    rdpSurface.value?.applyPointer(event.params as unknown as RdpPointerEvent);
    return;
  }
  // 串口生命周期：start 成功即 running；sidecar 只发 closed（主动关闭）与
  // error（读线程 IO 失败）两种状态事件。
  if (event.method === "serial/session/state" && event.params.sessionId === serialSession.value?.sessionId) {
    const state = String(event.params.state || "");
    if (state === "error") {
      markSerialClosed(String(event.params.error || ""));
    } else if (state === "closed") {
      markSerialClosed(null);
    }
    return;
  }
  // 串口文件上传进度（NyaTerm 对齐 P0-3）：sidecar 引擎事件 → overlay 状态。
  if (event.method === "serial/upload/progress" && event.params.sessionId === serialSession.value?.sessionId) {
    serialUpload.value = reduceSerialUpload(serialUpload.value, event.params as unknown as SerialUploadProgress);
    return;
  }
  if (event.method === "telnet/trigger" && event.params.sessionId === telnetSession.value?.sessionId) {
    const payload = event.params as { sessionId?: string; stage?: number; kind?: string };
    const stage = Math.max(1, Number(payload.stage) || 1);
    showNotice(t(payload.kind === "timeout" ? "telnet.triggerTimeout" : "telnet.triggerAnswered", { stage }));
    return;
  }
  // 声明式自动登录监督（P0-1）：sidecar 只带 status/attempt（无内容，
  // D6 语义），成功/重试文案在这里本地化；重试超限走既有退出覆盖层。
  if (event.method === "telnet/auto_login" && event.params.sessionId === telnetSession.value?.sessionId) {
    const payload = event.params as { status?: string; attempt?: number };
    if (payload.status === "success") {
      showNotice(t("telnet.declSuccessNotice"));
    } else if (payload.status === "retry") {
      showNotice(t("telnet.declRetryNotice", { attempt: Math.max(1, Number(payload.attempt) || 1) }));
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
  if (event.method === "watch/file-modified") {
    const payload = event.params as { watchId?: string };
    const watchId = String(payload.watchId || "");
    if (watchId && watchId === activeExternalWatch.value?.watchId) {
      handleWatchModified(watchId);
    }
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
  // sidecar 拒收上传分片（offset 失配/任务丢失/spool 写失败）时立即失败在途
  // ack 等待器，不再等满 30s 超时后才用一个含糊的 ack-timeout 收场（issue #60）。
  if (event.method === "sftp/upload/error") {
    const taskId = String(event.params.taskId || "");
    const waiter = uploadAckWaiters.get(taskId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      uploadAckWaiters.delete(taskId);
      waiter.reject(Object.assign(new Error(String(event.params.error || "upload rejected")), { code: "upload-append-failed" }));
    }
    return;
  }
  if (event.method === "sftp/transfer/progress") updateTransfer(event.params);
}

function updateTransfer(params: Record<string, unknown>) {
  const taskId = String(params.taskId || "");
  if (!taskId) return;
  const existing = transferTasks[taskId];
  const status = normalizeTransferStatus(params.status, existing?.status);
  const progress = mergeTransferProgress(existing, params);
  // 速度只采样真实网络推送（uploading 阶段）：staging 字节走本机内存/磁盘，
  // 计入会显示 20MB/s 级别的假速度（issue #60）。阶段切换时重置采样窗口。
  const phaseChanged = progress.phase !== existing?.phase;
  if (progress.phase === "staging") {
    transferSamples.delete(taskId);
    transferSpeeds[taskId] = 0;
  } else {
    const sample = sampleTransferSpeed(phaseChanged ? undefined : transferSamples.get(taskId), progress.transferred, performance.now());
    transferSamples.set(taskId, sample);
    transferSpeeds[taskId] = sample.speed;
  }
  // 目录下载事件附带的树内字段（fileCount/currentFile）有则透传；
  // 文件下载事件不带这些键，保持原有行为。（issue #46）
  const fileCount = params.fileCount !== undefined ? Number(params.fileCount) : existing?.fileCount;
  const currentFile = typeof params.currentFile === "string" ? params.currentFile : existing?.currentFile;
  transferTasks[taskId] = {
    taskId,
    sessionId: String(params.sessionId || existing?.sessionId || ""),
    direction: params.direction === "download" ? "download" : existing?.direction || "upload",
    fileName: String(params.fileName || existing?.fileName || ""),
    size: progress.size,
    transferred: progress.transferred,
    staged: progress.staged,
    phase: progress.phase,
    status,
    error: typeof params.error === "string" ? params.error : existing?.error,
    joinedAt: existing?.joinedAt ?? Date.now(),
    fileCount: Number.isFinite(fileCount) && fileCount! > 0 ? fileCount : undefined,
    currentFile: currentFile || undefined,
  };
  settleTransferCompletion(taskId, status);
  if (!existing && isLiveTransferStatus(transferTasks[taskId].status)) {
    // 面板已开时不得重开：openTransferPanel 的"先收口再开"会卸载弹层、
    // 复位滚动位置，用户正往下看历史时会被弹回顶部（issue #18）。互斥族
    // 保证面板开着时没有其他弹层，直接置 open 即可。
    if (!transferPanelOpen.value) transferPanelOpen.value = true;
  }
}

function normalizeTransferStatus(value: unknown, fallback: TransferTask["status"] = "running"): TransferTask["status"] {
  return ["queued", "running", "completed", "cancelled", "failed"].includes(String(value)) ? String(value) as TransferTask["status"] : fallback;
}

/** 终态事件结算 finish 之后的收尾等待器：completed 兑现，cancelled/failed 拒绝。 */
function settleTransferCompletion(taskId: string, status: TransferTask["status"]) {
  const waiter = transferCompletionWaiters.get(taskId);
  if (!waiter || (status !== "completed" && status !== "cancelled" && status !== "failed")) return;
  transferCompletionWaiters.delete(taskId);
  if (status === "completed") waiter.resolve();
  else waiter.reject(Object.assign(new Error(transferTasks[taskId]?.error || t(`transferStatus.${status}`)), { code: "transfer-terminal" }));
}

/** 挂起直到该任务收到终态 progress 事件（完成/取消/失败）；注册前已终态则立即结算。 */
function waitForTransferCompletion(taskId: string) {
  const existing = transferTasks[taskId];
  const status = existing?.status;
  if (status === "completed" || status === "cancelled" || status === "failed") {
    return status === "completed" ? Promise.resolve() : Promise.reject(Object.assign(new Error(existing?.error || t(`transferStatus.${status}`)), { code: "transfer-terminal" }));
  }
  return new Promise<void>((resolve, reject) => {
    transferCompletionWaiters.set(taskId, { resolve, reject });
  });
}

async function openSession(forceNew = false, bootRestore = false, isRetry = false) {
  if (!connectionId.value || !workbenchId.value) return;
  // 协议路由（对标 Tabby profile）：Telnet/VNC 连接不建 SSH 会话，直接驱动
  // 各自的会话启动；启动失败回落连接弹窗（预填 host/port，可改后重试）。
  if (connectionProtocol.value === "telnet") {
    if (!(await startTelnetFromConnection())) telnetDialogOpen.value = true;
    return;
  }
  if (connectionProtocol.value === "vnc") {
    if (!(await startVncFromConnection())) vncDialogOpen.value = true;
    return;
  }
  window.clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  // Boot-time tab restore can race the host's plugin activation and fail the
  // very first ssh/session/open; a bounded retry self-heals the restored
  // terminal instead of parking it on a manual reconnect button.
  // P1-1：重试计数只在"新入口"（用户动作 / 断线重连 / 初次打开）归零；
  // 重试定时器重入时必须保留计数，否则 OPEN_RETRY_MAX 永远打不满，
  // 认证失败等秒级永久错误会无限重试、错误文案永不呈现。
  if (!isRetry) openRetryAttempt = 0;
  // 重试重入保留等待提示；新入口（用户动作 / 断线重连 / 初次打开）重置。
  if (!isRetry) inactiveWaiting.value = false;
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
      ...sessionTransportOpenParams(transportReuseState),
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
    // Duplicate is an open-time intent, not a permanent reconnect policy.
    // Once its PTY exists, this tab owns an ordinary session; a later network
    // drop must be able to run a fresh login instead of replaying the old
    // source session id forever.
    markSessionTransportOpenSucceeded(transportReuseState, info.sessionId);
    activeTerminalSessionId = info.sessionId;
    lastSequence = 0;
    // A fresh session restarts sequence numbering: buffered frames from the
    // dead session belong to a different stream and must not poison the
    // in-order drain (a stale higher sequence would fake a permanent hole).
    pendingTerminalFrames.clear();
    replayNoProgress = 0;
    // 成功过渡（Termius 式）：先切 success 卡片——进度线填满到顶、终端图标变
    // 对号；replay 在动画期间并行拉取，hold 播完才置 connected 进终端，避免
    // 连接成功瞬间生硬跳变。reduced-motion 下不 hold，立即进终端。
    // Dock 面板（surface=panel）根本不渲染连接卡片（见模板 terminal-overlay
    // 的 v-if="!panelSurface"），hold 动画用户看不见——750ms 纯属白等，跳过。
    // 注意 session/directoryTrackingSupported 等响应式状态在 hold 结束后才写入：
    // 提前写入会让 SFTP/工具栏等 watcher 在动画播放期间就开始渲染（画面抖动）。
    connectSucceeded.value = true;
    inactiveWaiting.value = false;
    const successShownAt = Date.now();
    connectLog.push("info", t("connectCard.log.connected", { seconds: ((Date.now() - attemptStarted) / 1000).toFixed(1) }));
    const replay = await window.dbxPlugin.invoke<ReplayResult>("ssh/terminal/replay", {
      sessionId: info.sessionId,
      afterSequence: 0,
    });
    if (!replay.complete) throw new Error(t("sessionUnrecoverable"));
    const holdMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches || panelSurface.value ? 0 : CONNECT_SUCCESS_HOLD_MS;
    const remainMs = holdMs - (Date.now() - successShownAt);
    if (remainMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainMs));
    connectSucceeded.value = false;
    session.value = info;
    directoryTrackingSupported.value = info.directoryTrackingSupported ?? true;
    terminalState.value = "connected";
    await afterSessionConnected();
    // WKWebView（macOS 宿主）在"卡片遮盖 → 终端显示"过渡后可能漏一帧重绘，
    // 高亮装饰停留在过渡前状态直到首次交互（Mac 用户反馈"连接成功后 IP 高亮
    // 闪烁、点一下就好"）。状态落定为 connected 后下一帧主动全量刷新并重扫
    // 高亮，等价于那次点击；对 Chromium 是无害的一次多余重绘。
    window.requestAnimationFrame(() => {
      if (disposed || !terminal || terminalState.value !== "connected") return;
      terminal.refresh(0, terminal.rows - 1);
      rescanHighlightViewport();
    });
  } catch (cause) {
    if (disposed) return;
    connectSucceeded.value = false;
    // 用户已取消：不重试、不呈现错误，卡片停在已取消态等 Connect 重新发起。
    if (connectCancelled.value) return;
    // The selected source may close between opening the child workbench and
    // its first sidecar call. Downgrade once, explicitly, to a normal login;
    // subsequent failures follow the ordinary permanent-error policy.
    if (
      isDuplicatedTransportUnavailableError(cause)
      && fallbackToFreshTransport(transportReuseState)
    ) {
      connectLog.push("warn", t("connectCard.log.duplicateFallback"));
      await openSession(false, bootRestore, true);
      return;
    }
    const attemptMs = Date.now() - attemptStarted;
    // "Connection is not active"：sidecar 连接注册表还没有该连接。boot 恢复
    // 场景（宿主启动时为恢复的插件 tab 重放 connect 生命周期）这是暂时态，
    // 与其它快失败一起在窗口内重试即可自愈；非 boot 路径（手动重连等）宿主只在
    // 用户从侧边栏重开连接时才重放凭据，因此在有界窗口内轮询等待自愈（卡片
    // 显示等待文案），窗口耗尽再落错误态并指引从左侧连接重新打开。认证 /
    // host-key 拒绝是秒级永久错误，重试不可能自愈——跳过重试直接进 error 态，
    // 呈现 friendly 文案 + Reconnect 出口（P1-1）。决策细节见 connectRetry.ts。
    const inactive = isConnectionInactiveError(cause);
    // 预拨号面板的引导竞态：宿主在创建条目时已开始 connect，openSession 只
    // 是跑在了 connect 推送前面——用短间隔轮询等它落地，而不是 2s 退避梯子。
    const preconnect = bootRestore && panelSurface.value && hostContext.value.connectionPreconnected === true;
    const decision = decideConnectRetry({
      cause,
      attempt: openRetryAttempt,
      maxAttempts: OPEN_RETRY_MAX,
      attemptMs,
      inactive,
      bootRestore,
      preconnect,
    });
    if (decision.kind === "retry") {
      openRetryAttempt = decision.attempt;
      // 只有手动入口的 inactive 轮询需要"请在侧边栏重开"提示；boot 恢复由宿主自动重放。
      inactiveWaiting.value = inactive && !bootRestore;
      terminalState.value = "connecting";
      connectLog.push("warn", t("connectCard.log.retry", { seconds: decision.delayMs / 1000 }));
      reconnectTimer = window.setTimeout(() => {
        if (!disposed) void openSession(false, bootRestore, true);
      }, decision.delayMs);
      return;
    }
    inactiveWaiting.value = false;
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
  // 「在外部编辑器中打开」菜单项的可用性依赖本机落盘能力，连接后即探测
  // （结果按工作台生命周期缓存，web/docker 为 false → 菜单项保持禁用）。
  void probeLocalCapabilities();
  // 侧栏 tree tab 可见时补拉根节点（首连/重连后缓存仍为空的场景）。
  ensureSideTreeRoot();
  // After an auto-reconnect succeeds, tell the user the session is back and
  // which working directory context it resumed with (pure-function chosen).
  if (reconnectWasPending) {
    reconnectWasPending = false;
    const restored = describeReconnectRestoredNotice({ wasReconnecting: true, path: currentPath.value });
    // Dock panel surface：目录提示属 SFTP/目录跟随域，面板里不弹。
    if (restored && !panelSurface.value) showNotice(t(restored.key, restored.values));
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
  // 外部编辑器监听挂在会话上：断开前先停掉（后端 ssh/session/close 兜底）。
  if (sessionId) {
    void window.dbxPlugin.invoke("watch/stop-all", { sessionId }).catch(() => undefined);
    if (activeExternalWatch.value) activeExternalWatch.value = undefined;
    watchModifiedPrompt.value = null;
  }
  if (sessionId) await window.dbxPlugin.invoke("ssh/session/close", { sessionId }).catch(() => undefined);
  if (updateStatus) {
    terminalState.value = "disconnected";
    terminalError.value = t("disconnected");
  }
  persistState();
}

// —— 本地终端生命周期 ——
// 退出态统一入口：exitCode 为 null 表示 sidecar 未上报（进程被杀/会话已回收），
// 覆盖层对 null 只显示"已退出"，有值时显示退出码。
function markLocalExited(code: number | null) {
  if (!localSession.value || localState.value === "exited") return;
  localState.value = "exited";
  if (code !== null) localExitCode.value = code;
  stopCommandMarkerTick();
}

async function startLocalTerminal(shellOverride?: string) {
  if (localState.value === "starting" || isLocalMode.value) return;
  localState.value = "starting";
  try {
    const info = await window.dbxPlugin.invoke<{ sessionId: string; shell: string }>("local/terminal/start", {
      workbenchId: workbenchId.value,
      cols: terminal?.cols || 120,
      rows: terminal?.rows || 32,
      // Shell precedence: explicit dock choice > user preference > auto-detection.
      ...(shellOverride?.trim() ? { shell: shellOverride.trim() } : localShellPref.value ? { shell: localShellPref.value } : {}),
      ...(localShellIntegrationPref.value ? {} : { shellIntegration: false }),
      // 重开继承上次 cwd（目录可能已被删，sidecar 会回落家目录）。
      ...(localLastCwd.value ? { cwd: localLastCwd.value } : {}),
    });
    if (disposed) {
      void window.dbxPlugin.invoke("local/session/close", { sessionId: info.sessionId }).catch(() => undefined);
      return;
    }
    localSession.value = { sessionId: info.sessionId, shell: info.shell };
    localState.value = "running";
    // The restored shell ends here: the session was explicitly restarted.
    localShellRestored.value = false;
    localExitCode.value = null;
    localLastSequence.value = 0;
    localPendingFrames.clear();
    localReplayNoProgress = 0;
    resetCommandMarker();
    await nextTick();
    scheduleFit();
    terminal?.focus();
  } catch (cause) {
    localState.value = "exited";
    showError(cause, "terminal");
  }
}

async function closeLocalTerminal() {
  const sessionId = localSession.value?.sessionId;
  localSession.value = null;
  localState.value = "exited";
  localPendingFrames.clear();
  localOpenConfirmOpen.value = false;
  localMenuOpen.value = false;
  if (!sessionId) return;
  await window.dbxPlugin.invoke("local/session/close", { sessionId }).catch(() => undefined);
  terminal?.focus();
}

// —— Telnet 会话生命周期（P2-3，与本地终端同款互斥与补发机制）——
// 退出态统一入口：error 为 null 表示 sidecar 未带原因（会话已被回收），
// 非空时在退出覆盖层展示（连接失败/对端断开）。
function markTelnetClosed(error: string | null) {
  if (!telnetSession.value || telnetState.value === "closed") return;
  telnetState.value = "closed";
  if (error !== null) telnetError.value = error;
}

function drainTelnetFrames() {
  let frame = telnetPendingFrames.get(telnetLastSequence.value + 1);
  while (frame) {
    telnetPendingFrames.delete(telnetLastSequence.value + 1);
    telnetLastSequence.value += 1;
    if (frame.stream === 2) {
      if (new TextDecoder().decode(frame.data) === "telnet-session-closed") markTelnetClosed(null);
    } else {
      dispatchTerminalOutput(frame.data);
    }
    frame = telnetPendingFrames.get(telnetLastSequence.value + 1);
  }
  if (telnetPendingFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    telnetPendingFrames.clear();
  }
  const firstPending = Math.min(...telnetPendingFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > telnetLastSequence.value + 1 && !telnetReplayInFlight && telnetSession.value) {
    const sessionId = telnetSession.value.sessionId;
    telnetReplayInFlight = true;
    const holeAt = telnetLastSequence.value;
    void window.dbxPlugin
      .invoke<ReplayResult>("telnet/replay", { sessionId, afterSequence: telnetLastSequence.value })
      .then((result) => {
        if (!result.complete) {
          markTelnetClosed(null);
          return;
        }
        if (telnetLastSequence.value === holeAt) {
          telnetReplayNoProgress += 1;
          if (telnetReplayNoProgress >= 3) {
            telnetLastSequence.value = firstPending - 1;
            telnetReplayNoProgress = 0;
          }
        } else {
          telnetReplayNoProgress = 0;
        }
      })
      .catch(() => markTelnetClosed(null))
      .finally(() => {
        telnetReplayInFlight = false;
        drainTelnetFrames();
      });
  }
}

async function startTelnetSession(options: TelnetConnectOptions): Promise<boolean> {
  // 同一终端视图互斥：残留的 closed 会话先清场再开新连接。
  if (telnetSession.value && telnetState.value !== "closed") await closeTelnetSession();
  // 自动登录两种形态互斥：声明式（提示正则 + 凭据，sidecar 落内置默认正则）
  // 优先；否则走 Expect 规则 + 密文槽。凭据只进 start 载荷与发送计划，
  // sidecar 侧不落日志/事件。
  const autoLogin = options.declarative
    ? { declarative: options.declarative }
    : options.rules
      ? {
          rules: options.rules,
          secrets: [options.secret1 ?? "", options.secret2 ?? ""],
        }
      : undefined;
  try {
    const info = await window.dbxPlugin.invoke<{ sessionId: string; host: string; port: number }>("telnet/start", {
      workbenchId: workbenchId.value,
      host: options.host,
      port: options.port,
      enterMode: options.enterMode,
      backspaceMode: options.backspaceMode,
      cols: terminal?.cols || 120,
      rows: terminal?.rows || 32,
      ...(autoLogin ? { autoLogin } : {}),
    });
    if (disposed) {
      void window.dbxPlugin.invoke("telnet/close", { sessionId: info.sessionId }).catch(() => undefined);
      return false;
    }
    telnetSession.value = { sessionId: info.sessionId, host: info.host, port: info.port };
    telnetState.value = "connecting";
    telnetError.value = "";
    telnetLastSequence.value = 0;
    telnetPendingFrames.clear();
    telnetReplayNoProgress = 0;
    await nextTick();
    scheduleFit();
    terminal?.focus();
    return true;
  } catch (cause) {
    showError(cause, "terminal");
    return false;
  }
}

async function closeTelnetSession() {
  const sessionId = telnetSession.value?.sessionId;
  telnetSession.value = null;
  telnetState.value = "idle";
  telnetError.value = "";
  telnetPendingFrames.clear();
  telnetConfirmOpen.value = false;
  if (!sessionId) return;
  await window.dbxPlugin.invoke("telnet/close", { sessionId }).catch(() => undefined);
  terminal?.focus();
}

// —— VNC 会话生命周期（nyaterm-parity P2 2d，与 Telnet 同款互斥展示）——
// 画面走 VncSurface 画布；帧/输入/剪贴板各走独立通道。退出覆盖层展示
// sidecar 带回的原因文本（认证失败/服务端强制 Tight 等）。
function markVncClosed(error: string | null) {
  if (!vncSession.value || vncState.value === "closed") return;
  vncState.value = "closed";
  if (error !== null) vncError.value = error;
}

async function startVncSession(options: VncConnectOptions): Promise<boolean> {
  // 同一终端视图互斥：残留的 closed 会话先清场再开新连接。
  if (vncSession.value && vncState.value !== "closed") await closeVncSession();
  try {
    const info = await window.dbxPlugin.invoke<{ sessionId: string; host: string; port: number }>("vnc/start", {
      workbenchId: workbenchId.value,
      host: options.host,
      port: options.port,
      scaleMode: options.scaleMode,
      ...(options.password ? { password: options.password } : {}),
    });
    if (disposed) {
      void window.dbxPlugin.invoke("vnc/close", { sessionId: info.sessionId }).catch(() => undefined);
      return false;
    }
    vncSession.value = { sessionId: info.sessionId, host: info.host, port: info.port };
    vncScaleMode.value = options.scaleMode;
    vncState.value = "connecting";
    vncError.value = "";
    vncSurface.value?.reset();
    await nextTick();
    vncSurface.value?.$el?.querySelector("canvas")?.focus();
    return true;
  } catch (cause) {
    showError(cause, "terminal");
    return false;
  }
}

// —— 连接驱动的会话启动（对标 Tabby profile 打开）：非 SSH 连接从宿主
// 连接表单直启各自会话；参数 = 连接 host/port + 上次使用记忆的偏好。
// 凭据不随连接持久化，需要自动登录/VNC 密码时从工具栏弹窗进入；直启
// 失败回落弹窗（预填 host/port，可改后重试）。
async function startTelnetFromConnection(): Promise<boolean> {
  const conn = connection.value;
  if (!conn.host) return false;
  const last = loadLastConnectParams<TelnetConnectOptions>("telnet-connect-last");
  return startTelnetSession({
    host: conn.host,
    port: conn.port && conn.port > 0 ? conn.port : 23,
    enterMode: last.enterMode === "cr" || last.enterMode === "lf" ? last.enterMode : "crlf",
    backspaceMode: last.backspaceMode === "ctrl_h" ? "ctrl_h" : "del",
  });
}

async function startVncFromConnection(): Promise<boolean> {
  const conn = connection.value;
  if (!conn.host) return false;
  const last = loadLastConnectParams<VncConnectOptions>("vnc-connect-last");
  return startVncSession({
    host: conn.host,
    port: conn.port && conn.port > 0 ? conn.port : 5900,
    scaleMode: last.scaleMode === "stretch" || last.scaleMode === "actual" ? last.scaleMode : "fit",
  });
}

async function closeVncSession() {
  const sessionId = vncSession.value?.sessionId;
  vncSession.value = null;
  vncState.value = "idle";
  vncError.value = "";
  vncConfirmOpen.value = false;
  if (!sessionId) return;
  await window.dbxPlugin.invoke("vnc/close", { sessionId }).catch(() => undefined);
  terminal?.focus();
}

function sendVncInput(event: VncInputEvent) {
  const sessionId = vncSession.value?.sessionId;
  if (!sessionId) return;
  void window.dbxPlugin.invoke("vnc/input", { sessionId, ...event }).catch(() => undefined);
}

function sendVncClipboard(text: string) {
  const sessionId = vncSession.value?.sessionId;
  if (!sessionId || !text) return;
  void window.dbxPlugin.invoke("vnc/set-clipboard", { sessionId, text }).catch(() => undefined);
  showNotice(t("vnc.clipboardSent"));
}

// 工具栏 VNC 入口：SSH/本地/Telnet/串口/RDP 占用终端视图时先经确认。
function requestVnc() {
  if (isVncMode.value) return;
  if (session.value || reconnectPending.value || terminalState.value === "connecting" || localSession.value || telnetSession.value || serialSession.value || rdpSession.value) {
    vncConfirmOpen.value = true;
    return;
  }
  vncDialogOpen.value = true;
}

// 确认后：关掉占用终端视图的会话，再弹 VNC 连接表单。
async function confirmVncOpen() {
  vncConfirmOpen.value = false;
  await closeSession();
  if (localSession.value) await closeLocalTerminal();
  if (telnetSession.value) await closeTelnetSession();
  if (serialSession.value) await closeSerialSession();
  if (rdpSession.value) await closeRdpSession();
  vncDialogOpen.value = true;
}

// —— RDP 会话生命周期（nyaterm-parity P3-4，与 VNC 同款互斥展示）——
// 画面走 RdpSurface 画布；帧/输入/剪贴板/指针各走独立通道，断线重连由
// sidecar 退避梯子驱动（reconnecting 态展示进度），graceful close/终态错误
// 落退出覆盖层（带 errorKind 友好文案 + 手动 rdp/reconnect 出口）。

/** 退出覆盖层主文案：errorKind 友好化（raw error 作细节行展示）。 */
const rdpClosedTitle = computed(() => {
  const kind = rdpErrorKindKey(rdpState.value.errorKind);
  return kind ? t(`rdp.error.${kind}`) : t("rdp.closed");
});

async function startRdpSession(options: RdpConnectOptions): Promise<boolean> {
  // 同一终端视图互斥：残留的 closed 会话先清场再开新连接。
  if (rdpSession.value && rdpState.value.state !== "closed") await closeRdpSession();
  try {
    const info = await window.dbxPlugin.invoke<{ sessionId: string; host: string; port: number }>("rdp/start", {
      workbenchId: workbenchId.value,
      host: options.host,
      port: options.port,
      username: options.username,
      width: options.width,
      height: options.height,
      certificatePolicy: options.certificatePolicy,
      clipboard: options.clipboard,
      ...(options.password ? { password: options.password } : {}),
      ...(options.domain ? { domain: options.domain } : {}),
    });
    if (disposed) {
      void window.dbxPlugin.invoke("rdp/close", { sessionId: info.sessionId }).catch(() => undefined);
      return false;
    }
    rdpSession.value = { sessionId: info.sessionId, host: info.host, port: info.port };
    rdpScaleMode.value = options.scaleMode;
    rdpState.value = { state: "connecting", error: "", errorKind: "", attempt: 0, maxAttempts: 0 };
    rdpSurface.value?.reset();
    await nextTick();
    rdpSurface.value?.$el?.querySelector("canvas")?.focus();
    return true;
  } catch (cause) {
    showError(cause, "terminal");
    return false;
  }
}

async function closeRdpSession() {
  const sessionId = rdpSession.value?.sessionId;
  rdpSession.value = null;
  rdpState.value = initialRdpSessionState();
  rdpConfirmOpen.value = false;
  dismissRdpCertPrompt();
  if (!sessionId) return;
  await window.dbxPlugin.invoke("rdp/close", { sessionId }).catch(() => undefined);
  terminal?.focus();
}

function sendRdpInput(event: RdpInputEvent) {
  const sessionId = rdpSession.value?.sessionId;
  if (!sessionId) return;
  void window.dbxPlugin.invoke("rdp/input", { sessionId, ...event }).catch(() => undefined);
}

function sendRdpClipboard(text: string) {
  const sessionId = rdpSession.value?.sessionId;
  if (!sessionId || !text) return;
  void window.dbxPlugin.invoke("rdp/set-clipboard", { sessionId, text }).catch(() => undefined);
  showNotice(t("rdp.clipboardSent"));
}

// 手动重连（graceful disconnect / 终态错误后的出口）：generation 递增由
// sidecar 负责，前端只触发并让 rdp/session/state 事件驱动状态条。
async function reconnectRdpSession() {
  const sessionId = rdpSession.value?.sessionId;
  if (!sessionId) return;
  try {
    await window.dbxPlugin.invoke("rdp/reconnect", { sessionId });
  } catch (cause) {
    showError(cause, "terminal");
  }
}

// 工具栏 RDP 入口：SSH/本地/Telnet/串口/VNC 占用终端视图时先经确认。
function requestRdp() {
  if (isRdpMode.value) return;
  if (session.value || reconnectPending.value || terminalState.value === "connecting" || localSession.value || telnetSession.value || serialSession.value || vncSession.value) {
    rdpConfirmOpen.value = true;
    return;
  }
  rdpDialogOpen.value = true;
}

// 确认后：关掉占用终端视图的会话，再弹 RDP 连接表单。
async function confirmRdpOpen() {
  rdpConfirmOpen.value = false;
  await closeSession();
  if (localSession.value) await closeLocalTerminal();
  if (telnetSession.value) await closeTelnetSession();
  if (serialSession.value) await closeSerialSession();
  if (vncSession.value) await closeVncSession();
  rdpDialogOpen.value = true;
}

// —— 串口会话生命周期（P3，与 Telnet 同款互斥展示；无 replay，掉帧仅按
// pending 上限清空兜底）——
// 退出态统一入口：error 为 null 表示 sidecar 未带原因（主动关闭），
// 非空时在退出覆盖层展示（读线程 IO 失败/设备拔线）。
function markSerialClosed(error: string | null) {
  if (!serialSession.value || serialState.value === "closed") return;
  serialState.value = "closed";
  if (error !== null) serialError.value = error;
}

function drainSerialFrames() {
  let frame = serialPendingFrames.get(serialLastSequence.value + 1);
  while (frame) {
    serialPendingFrames.delete(serialLastSequence.value + 1);
    serialLastSequence.value += 1;
    dispatchTerminalOutput(frame.data);
    frame = serialPendingFrames.get(serialLastSequence.value + 1);
  }
  if (serialPendingFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    serialPendingFrames.clear();
  }
  // 序号缺口 → serial/replay（序号制回放）：重发帧从既有二进制通道到货后
  // 由同一 drain 消费；缺口永不可填（缓冲绕回/会话重建）时按无进度上限
  // resync 游标，避免 replay 循环空转冻结工作台。
  const firstPending = Math.min(...serialPendingFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > serialLastSequence.value + 1 && !serialReplayInFlight && serialSession.value) {
    serialReplayInFlight = true;
    const holeAt = serialLastSequence.value;
    void window.dbxPlugin
      .invoke<ReplayResult>("serial/replay", { sessionId: serialSession.value.sessionId, afterSequence: serialLastSequence.value })
      .then((result) => {
        // complete: false = 缓冲已绕回、回放不完整（设计稿 §3）——提示截断。
        if (!result.complete) showNotice(t("serial.replayTruncated"));
        if (serialLastSequence.value === holeAt) {
          serialReplayNoProgress += 1;
          if (serialReplayNoProgress >= 3) {
            serialLastSequence.value = firstPending - 1;
            serialReplayNoProgress = 0;
          }
        } else {
          serialReplayNoProgress = 0;
        }
      })
      .catch(() => {
        // 会话不存在（已关闭/未重建）：resync 过缺口放出后续帧。
        if (firstPending > serialLastSequence.value) {
          serialLastSequence.value = firstPending - 1;
          serialReplayNoProgress = 0;
        }
      })
      .finally(() => {
        serialReplayInFlight = false;
        drainSerialFrames();
      });
  }
}

async function startSerialSession(options: SerialConnectOptions) {
  // 同一终端视图互斥：残留的 closed 会话先清场再开新连接。
  if (serialSession.value && serialState.value !== "closed") await closeSerialSession();
  try {
    // 线上字段为 snake_case：SerialStartRequest 未启用 camelCase rename；
    // 响应则由 sidecar 手拼 json!，sessionId/port/baudRate 为 camelCase，
    // binaryInput 为 B1 能力字段（旧 sidecar 缺失 → JSON 兼容路径）。
    const info = await window.dbxPlugin.invoke<{ sessionId: string; port: string; baudRate: number; binaryInput?: boolean }>("serial/start", {
      workbenchId: workbenchId.value,
      port_name: options.portName,
      baud_rate: options.baudRate,
      data_bits: options.dataBits,
      parity: options.parity,
      stop_bits: options.stopBits,
      backspace_mode: options.backspaceMode,
    });
    if (disposed) {
      void window.dbxPlugin.invoke("serial/close", { sessionId: info.sessionId }).catch(() => undefined);
      return;
    }
    serialSession.value = { sessionId: info.sessionId, port: info.port, baudRate: info.baudRate };
    serialState.value = "running";
    serialError.value = "";
    serialLastSequence.value = 0;
    serialPendingFrames.clear();
    serialUnknownStreamFrames = 0;
    // 能力探测降级（设计稿 §2）：未声明 binaryInput 的 sidecar 走 JSON
    // serial/write；通道报错时再一次性降级（send 回调）。
    serialBinaryInput.value = supportsBinaryInput(info);
    serialInputQueue.reset();
    // 从 A4 恢复外壳 tab 直接起串口时清掉外壳态，退出覆盖层随即让位。
    localShellRestored.value = false;
    await nextTick();
    scheduleFit();
    terminal?.focus();
  } catch (cause) {
    showError(cause, "terminal");
  }
}

async function closeSerialSession() {
  const sessionId = serialSession.value?.sessionId;
  serialSession.value = null;
  serialState.value = "idle";
  serialError.value = "";
  serialPendingFrames.clear();
  serialUnknownStreamFrames = 0;
  serialBinaryInput.value = true;
  serialInputQueue.reset();
  serialConfirmOpen.value = false;
  // 上传挂在会话上：随会话关闭一并终止（sidecar cancel 幂等）。
  if (serialUpload.value.phase !== "idle") {
    serialUploadAbortRequested = true;
    if (sessionId) void window.dbxPlugin.invoke("serial/upload/cancel", { sessionId }).catch(() => undefined);
    serialUpload.value = initialSerialUploadState();
  }
  if (!sessionId) return;
  await window.dbxPlugin.invoke("serial/close", { sessionId }).catch(() => undefined);
  terminal?.focus();
}

// —— 串口文件上传（NyaTerm 对齐 P0-3）——————————————————————————
// 起点：SerialUploadDialog 选好文件/协议；文件字节经 File API 分块
// （≤64KiB）送入 sidecar，协议时序完全由 sidecar 引擎驱动。
async function startSerialUpload(request: { file: File; protocol: SerialUploadProtocol }) {
  const sessionId = serialSession.value?.sessionId;
  if (!sessionId || serialUploadBusy.value) return;
  serialUploadAbortRequested = false;
  serialUpload.value = {
    phase: "running",
    fileName: request.file.name,
    protocol: request.protocol,
    sent: 0,
    total: request.file.size,
    reason: "",
  };
  try {
    await streamSerialUploadFile(request.file, {
      sessionId,
      protocol: request.protocol,
      fileName: request.file.name,
      bridge: window.dbxPlugin,
      readChunk: async (start, end) => new Uint8Array(await request.file.slice(start, end).arrayBuffer()),
      shouldAbort: () => serialUploadAbortRequested,
    });
  } catch (cause) {
    if ((cause as Error)?.message === "tooLarge") {
      showError(t("serial.upload.tooLarge"), "terminal");
    } else {
      showError(cause, "terminal");
    }
    serialUpload.value = { ...initialSerialUploadState(), phase: "failed", reason: String((cause as Error)?.message ?? cause) };
  }
}

// overlay 上的取消：中断本地送数并让 sidecar 发协议取消序列（X/Y: CAN×8，
// Z: ZDLE×5+BS×5），引擎落 Failed 事件后由 progress 归并到 overlay。
function cancelSerialUpload() {
  if (!serialUploadBusy.value) return;
  const sessionId = serialSession.value?.sessionId;
  serialUploadAbortRequested = true;
  if (sessionId) void window.dbxPlugin.invoke("serial/upload/cancel", { sessionId }).catch(() => undefined);
  serialUpload.value = { ...serialUpload.value, phase: "failed", reason: "cancelled" };
}

// 工具栏串口入口：SSH 会话仍在（或连接中/本地终端/Telnet 占用）时先经确认，
// 与 Telnet 入口同款流程。
function requestSerial() {
  if (isSerialMode.value) return;
  if (session.value || reconnectPending.value || terminalState.value === "connecting" || localSession.value || telnetSession.value || vncSession.value || rdpSession.value) {
    serialConfirmOpen.value = true;
    return;
  }
  serialDialogOpen.value = true;
}

// 确认后：关掉占用终端视图的 SSH/本地/Telnet/VNC/RDP 会话，再弹串口连接表单。
async function confirmSerialOpen() {
  serialConfirmOpen.value = false;
  await closeSession();
  if (localSession.value) await closeLocalTerminal();
  if (telnetSession.value) await closeTelnetSession();
  if (vncSession.value) await closeVncSession();
  if (rdpSession.value) await closeRdpSession();
  serialDialogOpen.value = true;
}

// 工具栏 Telnet 入口：SSH 会话仍在（或连接中/本地终端占用）时先经确认，
// 与本地终端入口同款流程。
function requestTelnet() {
  if (isTelnetMode.value) return;
  if (session.value || reconnectPending.value || terminalState.value === "connecting" || localSession.value || vncSession.value || serialSession.value || rdpSession.value) {
    telnetConfirmOpen.value = true;
    return;
  }
  telnetDialogOpen.value = true;
}

// 确认后：关掉占用终端视图的 SSH/本地/VNC/串口/RDP 会话，再弹 Telnet 连接表单。
// 串口与 requestTelnet 的占用判定同链：漏关会留下孤儿串口会话占用 sidecar PTY。
async function confirmTelnetOpen() {
  telnetConfirmOpen.value = false;
  await closeSession();
  if (localSession.value) await closeLocalTerminal();
  if (vncSession.value) await closeVncSession();
  if (serialSession.value) await closeSerialSession();
  if (rdpSession.value) await closeRdpSession();
  telnetDialogOpen.value = true;
}

// HOST_PLUGIN_UI_SPEC §8.3/§7.4 workbench/close 两段式关闭：宿主拆除 panel/tab webview
// 前先通知本 workbench 释放自己的 sidecar scope（PTY 会话），避免孤儿 PTY 活到 sidecar
// 退出。特 性探测：旧宿主不发 workbench/close，也无此 API。置 disposed 拦住在途的
// 异步启动流程（startLocalTerminal 会据此回收刚开的会话）。
if (window.dbxPlugin.workbench?.onClose) {
  window.dbxPlugin.workbench.onClose(async () => {
    disposed = true;
    const ownedSessions = [
      ["local/session/close", localSession.value?.sessionId],
      ["ssh/session/close", session.value?.sessionId],
      ["telnet/close", telnetSession.value?.sessionId],
      ["serial/close", serialSession.value?.sessionId],
      ["vnc/close", vncSession.value?.sessionId],
      ["rdp/close", rdpSession.value?.sessionId],
    ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && !!pair[1]);
    await Promise.allSettled(ownedSessions.map(([method, sessionId]) => window.dbxPlugin.notify(method, { sessionId })));
    localSession.value = null;
    session.value = undefined;
    telnetSession.value = null;
    serialSession.value = null;
    vncSession.value = null;
    rdpSession.value = null;
  });
}

// "Close" on a restored shell: there is no session to close — fall into the same disconnected state as an SSH restored tab
// (no connection replay, spec §7.6) and the exit overlay steps aside.
function dismissRestoredLocalShell() {
  localShellRestored.value = false;
  localState.value = "exited";
  terminalState.value = "disconnected";
  terminalError.value = t("restartDisconnected");
}

// Toolbar local-terminal button: running -> close; restored shell -> reopen directly (nothing to close, skipping
// SSH confirm flow); serial/telnet mode -> close that session; an SSH state walks the existing confirm flow.
function toggleLocalTerminal() {
  if (isRdpMode.value) {
    void closeRdpSession();
    return;
  }
  if (isVncMode.value) {
    void closeVncSession();
    return;
  }
  if (isSerialMode.value) {
    void closeSerialSession();
    return;
  }
  if (isTelnetMode.value) {
    void closeTelnetSession();
    return;
  }
  if (localShellRestored.value) {
    void restartLocalTerminal();
    return;
  }
  if (isLocalMode.value) {
    void closeLocalTerminal();
    return;
  }
  requestLocalTerminal();
}

// 右键菜单"重跑最近命令"：把命令写入本地 PTY（危险命令复用粘贴确认），
// 补回车立即执行；多行命令归一为回车分隔。
async function rerunLocalCommand(command: string) {
  if (!localSession.value) return;
  const payload = command.replace(/\r\n|\r|\n/g, "\r") + "\r";
  trackPendingInput(payload);
  await sendConfirmedPaste(payload);
}

async function restartLocalTerminal() {
  await closeLocalTerminal();
  await startLocalTerminal();
}

// SSH 会话在连/连接中/重连中时先经确认关闭（本地模式与 SSH 会话互斥展示，
// connecting 途中放行会让在途 ssh/session/open 成功后与本地会话抢同一终端
// 视图），再开本地终端。
function requestLocalTerminal() {
  // 串口/Telnet/VNC/RDP 会话占用终端视图时不开本地终端（互斥展示）。
  if (isSerialMode.value || isTelnetMode.value || isVncMode.value || isRdpMode.value) return;
  if (isLocalMode.value || localState.value === "starting") return;
  if (session.value || reconnectPending.value || terminalState.value === "connecting") {
    localOpenConfirmOpen.value = true;
    return;
  }
  void startLocalTerminal();
}

async function confirmLocalTerminal() {
  localOpenConfirmOpen.value = false;
  await closeSession();
  await startLocalTerminal();
}

// —— shell 选择器：多平台 shell 发现 + 偏好（VS Code terminal profiles 简化版）——
async function openLocalMenu() {
  localMenuOpen.value = true;
  if (localShellsLoading.value || localShells.value.length) return;
  localShellsLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ shells: typeof localShells.value }>("local/shells/list", {}, { timeoutMs: 10_000 });
    localShells.value = result.shells || [];
  } catch {
    // 旧 sidecar 无发现方法：菜单退化为仅注入开关（start 仍走自动探测）。
  } finally {
    localShellsLoading.value = false;
  }
}

// Dock panel "+": opens another dock entry with the selected shell type via the bridge openWorkbench
// (the host owns the surface: inside a panel webview -> a new dock entry; inside a tab -> a new tab).
const localShellSurfaceOpen = ref(false);
// host.listConnections (PR-A4 generic extension point): a read-only, secret-free list of the plugin's own connections,
// for in-panel connection switching; hosts without it degrade to a hidden connection section.
const dockConnections = ref<Array<{ id: string; name: string; providerId: string; connectionType?: string; readOnly?: boolean }>>([]);
async function openLocalShellSurfaceMenu() {
  localShellSurfaceOpen.value = true;
  if (localShellsLoading.value || localShells.value.length) return;
  localShellsLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ shells: typeof localShells.value }>("local/shells/list", {}, { timeoutMs: 10_000 });
    localShells.value = result.shells || [];
  } catch {
    // Legacy sidecars without discovery: the menu degrades to the auto-detect entry.
  } finally {
    localShellsLoading.value = false;
  }
  try {
    const listed = await window.dbxPlugin.request<{ connections?: typeof dockConnections.value }>("host.listConnections");
    dockConnections.value = listed?.connections ?? [];
  } catch {
    // Legacy hosts without the listConnections extension point: the connection section stays hidden.
    dockConnections.value = [];
  }
}
function openConnectionSurface(connection: (typeof dockConnections.value)[number]) {
  localShellSurfaceOpen.value = false;
  void window.dbxPlugin.openWorkbench?.(
    "io.dbx.ssh.workbench",
    {
      connectionId: connection.id,
      providerId: connection.providerId,
      connectionType: connection.connectionType,
      connection: { id: connection.id, name: connection.name, readOnly: connection.readOnly === true },
    },
    { forceNew: true },
  );
}
function openLocalShellSurface(program?: string) {
  localShellSurfaceOpen.value = false;
  void window.dbxPlugin.openWorkbench?.(
    "io.dbx.ssh.workbench",
    { plugin: { mode: "local-terminal", ...(program ? { shell: program } : {}) } },
    { forceNew: true },
  );
}

async function setLocalShellPref(program: string) {
  localShellPref.value = program;
  try {
    await window.dbxPlugin.invoke("local/preferences/set", { localShell: program });
  } catch {
    // 旧 sidecar：会话内存态兜底。
  }
}

async function setLocalShellIntegrationPref(enabled: boolean) {
  localShellIntegrationPref.value = enabled;
  try {
    await window.dbxPlugin.invoke("local/preferences/set", { localShellIntegration: enabled });
  } catch {
    // 旧 sidecar：会话内存态兜底。
  }
}

// P0.2 self-open: opens a separate connectionless local-terminal tab through the host openWorkbench bridge.
// A4 target contract (spec §4/§11): the plugin payload lives only in context.plugin and the instance identity
// (workbenchId) is generated by the host — when a legacy host omits it, the workbenchId fallback covers it.
// The menu item is hidden on hosts without this bridge.
const canOpenLocalTab = computed(() => Boolean(window.dbxPlugin?.openWorkbench));

async function openLocalTerminalTab() {
  const api = window.dbxPlugin;
  if (!api.openWorkbench) return;
  await api.openWorkbench(
    "io.dbx.ssh.workbench",
    { plugin: { mode: "local-terminal" } },
    { forceNew: true },
  );
}

// webview 重建后接回 sidecar 里仍活着的本地 shell（workbench/close 才回收）。
async function reattachLocalSession(): Promise<boolean> {
  try {
    const result = await window.dbxPlugin.invoke<{ sessions?: Array<{ sessionId: string; workbenchId: string; shell: string }> }>(
      "local/session/list",
      {},
      { timeoutMs: 10_000 },
    );
    const match = (result?.sessions || []).find((session) => session.workbenchId === workbenchId.value);
    if (!match) return false;
    localSession.value = { sessionId: match.sessionId, shell: match.shell };
    localState.value = "running";
    localExitCode.value = null;
    localLastSequence.value = 0;
    localPendingFrames.clear();
    const replay = await window.dbxPlugin.invoke<ReplayResult>("local/terminal/replay", { sessionId: match.sessionId, afterSequence: 0 });
    if (!replay.complete) markLocalExited(null);
    await nextTick();
    scheduleFit();
    return true;
  } catch {
    return false;
  }
}

// 手动重连前请宿主按当前最新配置重开连接：连接在侧边栏被编辑（如改密码）后，
// 宿主会摘掉 connected 标记且不回推插件，sidecar 里存的凭据就此过期——不先
// 重开的话 openSession 只会拿旧凭据反复失败。宿主以打开连接的同款流程重新
// 下发配置（含 vault 里的最新凭据）。旧宿主无 host.reopenConnection：请求
// 报错静默忽略，行为退化为原样。
async function requestHostReopenConnection() {
  if (!connectionId.value) return;
  try {
    const api = window.dbxPlugin;
    if (api.reopenConnection) await api.reopenConnection(connectionId.value);
    else await api.request("host.reopenConnection", { connectionId: connectionId.value });
  } catch {
    // 旧宿主无此方法。
  }
}

async function reconnect() {
  terminal?.clear();
  resetGutterTimestamps();
  await closeSession(false);
  await requestHostReopenConnection();
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

/** 已取消态的 Connect 出口：与错误态 reconnect 同路径——先请宿主按最新配置
 * 重开连接（侧边栏改密码/连接信息后 sidecar 凭据已过期，缺这步会拿旧凭据
 * 反复失败、把 inactive 重试梯子耗尽才落错误态），再走完整 openSession
 * 流程（入口会重置取消标记）。 */
async function startConnect() {
  connectCancelled.value = false;
  await requestHostReopenConnection();
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

// 新建会话（同连接再开一个 tab）：context 复制当前一份并换发新 workbenchId——
// 后端按 workbenchId 开独立 PTY（#41 会话隔离），多个 tab 互不干扰、boot 恢复
// 各回各的会话。克隆的 workbenchState 摘掉 sessionId/terminalSequence，避免新
// tab 尝试回附旧会话。forceNew 让宿主跳过"同 connectionId 复用已有 tab"的查重
// （桥路径不传 connectionId，按钮开的 tab 会互相查重，导致只能多开一个）；
// 旧宿主忽略第三参，退化为原查重行为。connectionId 显式写入 context：宿主的
// 重推凭据（reinit re-push）与 hostContext 合并都键在 context.connectionId 上，
// 不能依赖宿主已把它合进 context（旧宿主没有那层合并）。
function sessionTabContext(reuseAuthenticatedTransport: boolean): Record<string, unknown> {
  const context: Record<string, unknown> = {
    ...hostContext.value,
    connectionId: connectionId.value,
    workbenchId: randomUUID(),
    reuseAuthenticatedTransport,
    reuseAuthenticatedSessionId: reuseAuthenticatedTransport ? session.value?.sessionId : undefined,
  };
  const persisted = context.workbenchState;
  if (persisted && typeof persisted === "object") {
    const { sessionId: _sessionId, terminalSequence: _terminalSequence, ...rest } = persisted as Record<string, unknown>;
    context.workbenchState = rest;
  }
  return context;
}

function openNewSessionTab() {
  const api = window.dbxPlugin;
  if (!api.openWorkbench || !connectionId.value) return;
  void api.openWorkbench("io.dbx.ssh.workbench", sessionTabContext(false), { forceNew: true });
}

// 复制会话：新 tab 仍拥有独立 PTY、回放缓冲和 workbenchId，但后端在当前
// 已认证 SSH transport 上另开 channel，因此堡垒机不会再次发起 MFA。这里不
// 复制或缓存 OTP；若原 transport 已失效，后端会要求走“新建会话”重新连接。
function openCopiedSessionTab() {
  const api = window.dbxPlugin;
  if (!api.openWorkbench || !connectionId.value || !connected.value) return;
  void api.openWorkbench("io.dbx.ssh.workbench", sessionTabContext(true), { forceNew: true });
}

async function restoreTransfers() {
  if (!session.value) return;
  const result = await window.dbxPlugin.invoke<{ tasks: TransferTask[] }>("sftp/transfer/list", { sessionId: session.value.sessionId }).catch(() => ({ tasks: [] }));
  for (const task of result.tasks) {
    // 后端 list 的 staging 行把 spool 字节放在 transferred 里；恢复到本地
    // 状态时归位到 staged，避免重挂后进度条展示阶段计数（issue #60）。
    if (task.phase === "staging") {
      task.staged = task.transferred;
      task.transferred = 0;
    }
    const existing = transferTasks[task.taskId];
    // joinedAt 只在首次见到时落一次：后端返回序（HashMap 迭代序）不再影响
    // 活跃区排序（issue #18）。
    transferTasks[task.taskId] = { ...task, joinedAt: existing?.joinedAt ?? Date.now() };
  }
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
      const status = await window.dbxPlugin.invoke<{ transferred?: number; status: string; phase?: string }>("sftp/transfer/status", { taskId: task.taskId });
      const normalized = normalizeTransferStatus(status.status, "running");
      // task.status 此处必为 queued/running（上方守卫），终态即差异。
      if (normalized !== "queued" && normalized !== "running") {
        task.status = normalized;
        if (status.transferred != null) {
          // staging 阶段的 transferred 字段是 spool 字节数，不能覆盖真实推送计数。
          if (status.phase === "staging") task.staged = status.transferred;
          else task.transferred = status.transferred;
        }
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

// 应用内弹窗确认：宿主沙箱 iframe 无 allow-modals，window.confirm 恒 false
const transferHistoryClearOpen = ref(false);
async function confirmTransferHistoryClear() {
  try {
    await window.dbxPlugin.invoke("sftp/transfer/history/clear", {});
    transferHistory.value = [];
    transferHistoryFailed.value = false;
    transferHistoryClearOpen.value = false;
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

// 打开传输面板或任一任务转为终态时拉取历史：终态卡从活跃区消失的同一拍
// 进入历史区，不等最后一个任务结束（issue #18：有传输任务时历史也要可查）。
// 打开面板的同时对账活跃任务，防止错过终态事件的行永远卡在 running。
watch(transferPanelOpen, (open) => {
  if (open) {
    void refreshTransferPanel();
  }
});
const liveTransferIds = computed(() =>
  transferList.value.map((task) => task.taskId).join("|"),
);
watch(liveTransferIds, (current, previous) => {
  if (!transferPanelOpen.value) return;
  const before = new Set((previous ?? "").split("|").filter(Boolean));
  const after = new Set(current.split("|").filter(Boolean));
  // 只有任务离开活跃集合（转终态）才刷新；新任务加入由面板打开路径负责。
  const departed = [...before].some((taskId) => !after.has(taskId));
  if (departed) void refreshTransferHistory();
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

// —— RDP 证书确认（rdp-certificate challenge）：120s 倒计时 + fail-closed ——
// 倒计时基于队首 receivedAt + 120s 绝对期限（与 AI 审批弹窗同一 tick 模式），
// 到 0 仅关弹窗——sidecar 侧超时同样拒绝该挑战，两侧语义一致。
watch(rdpCertPrompt, (prompt) => {
  if (rdpCertTimer) {
    window.clearInterval(rdpCertTimer);
    rdpCertTimer = 0;
  }
  if (!prompt) {
    rdpCertRemaining.value = 0;
    return;
  }
  const tick = () => {
    const current = rdpCertPrompt.value;
    if (!current) return;
    rdpCertRemaining.value = rdpCertRemainingSecs(current.receivedAt, Date.now());
    if (rdpCertRemaining.value <= 0) dismissRdpCertPrompt();
  };
  tick();
  rdpCertTimer = window.setInterval(tick, 250);
});

// 挑战一次性：先出弹窗再 resolve（超时/取消/未知 id 一律按拒绝处理）。
function dismissRdpCertPrompt() {
  if (rdpCertTimer) {
    window.clearInterval(rdpCertTimer);
    rdpCertTimer = 0;
  }
  rdpCertPrompt.value = null;
  rdpCertRemaining.value = 0;
}

async function resolveRdpCertificate(accept: boolean) {
  const prompt = rdpCertPrompt.value;
  if (!prompt) return;
  const remember = accept && rdpCertRemember.value;
  dismissRdpCertPrompt();
  try {
    await window.dbxPlugin.invoke("rdp/certificate/resolve", {
      challengeId: prompt.challengeId,
      accept,
      remember,
    });
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

// 端口映射（-L/-R）管理弹窗：全部逻辑在 components/PortForwardDialog.vue，
// 这里只保留工具栏入口的开关状态。
const forwardsOpen = ref(false);

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
// ToggleGroup（multiple）以字符串数组建模；这里桥接到 draft 的两个布尔标志位。
const highlightFlagValues = computed<string[]>({
  get: () => [highlightDraft.isRegex ? "regex" : "", highlightDraft.caseSensitive ? "case" : ""].filter(Boolean),
  set: (values) => {
    highlightDraft.isRegex = values.includes("regex");
    highlightDraft.caseSensitive = values.includes("case");
  },
});
const compiledHighlightRules = computed(() => compileRules(highlightRules.value));

function loadHighlightEnabled(): boolean {
  try {
    return pluginStore.getItem(HIGHLIGHT_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

// 总开关：关闭时摘掉 onRender 挂子并全量清理 decoration（零挂钩子语义）。
const highlightEnabled = ref(loadHighlightEnabled());

function toggleHighlightEnabled() {
  highlightEnabled.value = !highlightEnabled.value;
  try {
    pluginStore.setItem(HIGHLIGHT_ENABLED_KEY, highlightEnabled.value ? "true" : "false");
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
// onRender({start,end}) 给的是"本帧实际重绘的行区间"（输入时常常只有光标一行），
// 不是整个视口：合并进 pending 区间，经 setTimeout 节流（≤30fps）后统一扫描；
// 扫描时装饰去留按 buffer.viewportY 的真实视口判定（见 scanHighlightRange）。
// alt buffer 与 normal buffer 走同一路径（buffer.active 直接扫描）。
let highlightRenderDisposable: { dispose(): void } | undefined;
// 每行一个组（marker + decorations + 该行登记时的文本）；行滚出视口整组 dispose。
// text 用于"文本未变则整组保留"：xterm 在装饰 dispose/注册后自身会再触发整幅
// 重绘（实测 30fps 持续循环），无脑拆建会让空闲终端陷入"重绘→扫描→拆建→重绘"
// 的自激回路，高亮层反复摘挂即是用户看到的闪烁。
const highlightDecorationsByRow = new Map<number, { text: string; dispose(): void }>();
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
  // 大输出保护生效期挂起扫描，恢复时由 onOutputGateRelease 补扫视口。
  if (outputGate.mode === "strained") return;
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
  // onRender 的 start/end 是视口相对行号，这里的 row / viewportY 是缓冲绝对行号
  // （换算与裁剪见 toAbsoluteRowRange：漏了这步，滚过一屏后脏行判定永不命中）。
  const dirty = toAbsoluteRowRange(start, end, buffer.viewportY, buffer.length);
  // onRender 给的是"本帧重绘的行"（输入时常常只有光标行），不是视口——装饰的
  // 去留必须按视口判定，否则每次击键都把整屏高亮 dispose 掉再异步补回（可见闪烁）。
  const vpFrom = Math.max(0, Math.min(buffer.viewportY, buffer.length - 1));
  const vpTo = Math.min(buffer.length - 1, vpFrom + term.rows - 1);
  for (const [row, entry] of highlightDecorationsByRow) {
    // 拆组条件（视口外 / 本帧重绘且文本变了）见 shouldRebuildHighlightRow；
    // "重绘但文本没变就保留"是掐断"拆建→重绘"自激回路的关键。
    const dirtyRow = row >= dirty.from && row <= dirty.to;
    const currentText = dirtyRow ? buffer.getLine(row)?.translateToString(true) ?? "" : entry.text;
    if (!shouldRebuildHighlightRow({ row, viewportFrom: vpFrom, viewportTo: vpTo, dirty: dirtyRow, previousText: entry.text, currentText })) continue;
    entry.dispose();
    highlightDecorationsByRow.delete(row);
  }
  const compiled = compiledHighlightRules.value;
  if (!compiled.length) return;
  // registerMarker 的 offset 相对光标绝对行（baseY + cursorY）；marker dispose 时
  // xterm 会连带 dispose 挂在其上的 decoration。
  const base = buffer.baseY + buffer.cursorY;
  for (let row = vpFrom; row <= vpTo; row++) {
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
      text: lineText,
      decorations: 0,
      dispose() {
        for (const disposable of disposables.splice(0)) disposable.dispose();
        // 计数只增不减会顶到全局上限、高亮逐渐不再出现（看起来像闪烁后消失）。
        highlightDecorationCount -= entry.decorations;
        entry.decorations = 0;
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
        entry.decorations++;
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
// 动作链接 + 行号/时间戳 gutter（IMPL_PLAN Task P1-2 / P1-3，均默认关闭）。
// 偏好权威态在此，经 sidecar preferences.json（backend/src/preferences.rs 的
// 固定 allowlist，local/preferences/get|set）持久化；设置页控件在
// SettingsDialog「终端」分类，经 update:* 增量上抛。
// ---------------------------------------------------------------------------

async function persistTerminalFeaturePrefs(patch: Record<string, unknown>) {
  try {
    await window.dbxPlugin.invoke("local/preferences/set", patch);
  } catch {
    // 旧 sidecar 无这些键位：与 localShell 等同款，当前会话内存态兜底。
  }
}

// ---- 动作链接（P1-2）----
const actionLinksSettings = ref<ActionLinksSettings>(sanitizeActionLinksSettings(undefined));
const actionLinksEnabled = computed(() => actionLinksSettings.value.enabled);
// 与关键词高亮同帧率上限 / 同量级装饰总数护栏。
const ACTION_LINK_SCAN_MIN_INTERVAL_MS = 33;
const ACTION_LINK_DECORATION_LIMIT = 400;
let actionLinkProviderDisposable: { dispose(): void } | undefined;
let actionLinkRenderDisposable: { dispose(): void } | undefined;
let actionLinkScanScheduled = false;
let actionLinkLastScanAt = 0;
let actionLinkPendingRange: { start: number; end: number } | undefined;
// 每行一组（marker + 虚线 decorations + 登记文本）；去留条件复用关键词高亮的
// shouldRebuildHighlightRow——"本帧重绘且文本未变则整组保留"是防自激回路的
// 关键（xterm 在装饰注册/销毁后会再触发整幅重绘）。
const actionLinkDecorationsByRow = new Map<number, { text: string; dispose(): void }>();
let actionLinkDecorationCount = 0;
// 悬停 / Alt+点击的命令预览浮签（terminal-pane 内绝对定位，pointer-events 关）。
const actionLinkHint = ref<{ x: number; y: number; text: string } | null>(null);

function clearActionLinkDecorations() {
  for (const entry of actionLinkDecorationsByRow.values()) entry.dispose();
  actionLinkDecorationsByRow.clear();
  actionLinkDecorationCount = 0;
}

function attachActionLinks() {
  if (!terminal || actionLinkProviderDisposable || !actionLinksEnabled.value) return;
  actionLinkProviderDisposable = terminal.registerLinkProvider(
    createActionLinkProvider(terminal, {
      matchers: actionLinksSettings.value.matchers,
      callbacks: {
        onActivate: handleActionLinkActivate,
        onHover: showActionLinkHintAt,
        onLeave: hideActionLinkHint,
      },
    }),
  );
  actionLinkRenderDisposable = terminal.onRender(({ start, end }) => scheduleActionLinkScan(start, end));
  scheduleActionLinkScan(0, terminal.rows - 1);
}

function detachActionLinks() {
  actionLinkProviderDisposable?.dispose();
  actionLinkProviderDisposable = undefined;
  actionLinkRenderDisposable?.dispose();
  actionLinkRenderDisposable = undefined;
  clearActionLinkDecorations();
  hideActionLinkHint();
}

// 点击 = 把建议命令送进现有 PTY 输入通路（不含换行：shell 输入行停在原地，
// 用户可补改后再回车执行）。Alt+点击 = 仅预览命令文本，不向 PTY 写入。
function handleActionLinkActivate(match: ActionLinkMatch, event: MouseEvent) {
  if (event.altKey) {
    showActionLinkHintAt(match, event);
    return;
  }
  const sessionId = localSession.value?.sessionId ?? session.value?.sessionId;
  if (!sessionId) return;
  sendTerminalBytes(new TextEncoder().encode(match.command));
  terminal?.focus();
}

// ---- Docker 面板「在终端打开」（M3 遗留 6）----
// DockerPanel 挂在 SideNavPanel 内（后者不透传事件且不在本次改动范围），面板经
// window 自定义事件把命令字符串直达这里；走与建议浮层同款的「填入输入行不回车」
// 通道（replaceTerminalLineWith）：命令落在 shell 输入行原地，用户确认后自行回车。
// 无终端会话时 toast 提示先连接，不静默丢弃。
function handleDockerOpenInTerminal(event: Event) {
  const command = (event as CustomEvent<{ command?: string }>).detail?.command ?? "";
  if (!command) return;
  const hasTerminalSession = Boolean(
    localSession.value ?? session.value ?? serialSession.value ?? telnetSession.value,
  );
  if (!terminal || !hasTerminalSession) {
    showNotice(t("docker.terminalNeedSession"));
    return;
  }
  replaceTerminalLineWith(command, false);
  terminal.focus();
}

function showActionLinkHintAt(match: ActionLinkMatch, event: MouseEvent) {
  const host = terminalHost.value;
  if (!host) return;
  const bounds = host.getBoundingClientRect();
  actionLinkHint.value = {
    x: Math.min(Math.max(event.clientX - bounds.left + 10, 4), Math.max(4, bounds.width - 280)),
    y: Math.max(4, event.clientY - bounds.top - 34),
    text: match.command,
  };
}

function hideActionLinkHint() {
  actionLinkHint.value = null;
}

function scheduleActionLinkScan(start: number, end: number) {
  if (!terminal || !actionLinksEnabled.value) return;
  // 大输出保护生效期挂起扫描，恢复时由 onOutputGateRelease 补扫视口。
  if (outputGate.mode === "strained") return;
  actionLinkPendingRange = actionLinkPendingRange
    ? { start: Math.min(actionLinkPendingRange.start, start), end: Math.max(actionLinkPendingRange.end, end) }
    : { start, end };
  if (actionLinkScanScheduled) return;
  actionLinkScanScheduled = true;
  const wait = Math.max(0, ACTION_LINK_SCAN_MIN_INTERVAL_MS - (performance.now() - actionLinkLastScanAt));
  window.setTimeout(runActionLinkScan, wait);
}

function runActionLinkScan() {
  actionLinkScanScheduled = false;
  actionLinkLastScanAt = performance.now();
  const range = actionLinkPendingRange;
  actionLinkPendingRange = undefined;
  if (!range || !terminal || !actionLinksEnabled.value) return;
  scanActionLinkRange(range.start, range.end);
}

function scanActionLinkRange(start: number, end: number) {
  const term = terminal;
  if (!term) return;
  const buffer = term.buffer.active;
  // onRender 的视口相对行号 → 缓冲绝对行号 + 视口判定，与关键词高亮同款换算。
  const dirty = toAbsoluteRowRange(start, end, buffer.viewportY, buffer.length);
  const vpFrom = Math.max(0, Math.min(buffer.viewportY, buffer.length - 1));
  const vpTo = Math.min(buffer.length - 1, vpFrom + term.rows - 1);
  for (const [row, entry] of actionLinkDecorationsByRow) {
    // 防自激：仅"滚出视口"或"本帧重绘且文本确实变化"才拆组重建。
    const dirtyRow = row >= dirty.from && row <= dirty.to;
    const currentText = dirtyRow ? buffer.getLine(row)?.translateToString(true) ?? "" : entry.text;
    if (!shouldRebuildHighlightRow({ row, viewportFrom: vpFrom, viewportTo: vpTo, dirty: dirtyRow, previousText: entry.text, currentText })) continue;
    entry.dispose();
    actionLinkDecorationsByRow.delete(row);
  }
  const matchers = actionLinksSettings.value.matchers;
  const keywordRules = compiledHighlightRules.value;
  const base = buffer.baseY + buffer.cursorY;
  for (let row = vpFrom; row <= vpTo; row++) {
    if (actionLinkDecorationsByRow.has(row)) continue;
    if (actionLinkDecorationCount >= ACTION_LINK_DECORATION_LIMIT) return;
    const lineText = buffer.getLine(row)?.translateToString(true) ?? "";
    if (!lineText) continue;
    const matches = matchActionLinks(lineText, matchers);
    if (!matches.length) continue;
    // 让位：与用户关键词高亮同段命中的范围跳过（高亮是用户显式配置的规则）。
    const keywordSpans = keywordRules.length ? matchesInLine(lineText, keywordRules) : [];
    const visible = keywordSpans.length
      ? matches.filter((match) => !keywordSpans.some((span) => match.start < span.end && match.end > span.start))
      : matches;
    if (!visible.length) continue;
    const marker = term.registerMarker(row - base);
    if (!marker) continue;
    const disposables: Array<{ dispose(): void }> = [marker];
    const entry = {
      text: lineText,
      decorations: 0,
      dispose() {
        for (const disposable of disposables.splice(0)) disposable.dispose();
        actionLinkDecorationCount -= entry.decorations;
        entry.decorations = 0;
      },
    };
    for (const match of visible) {
      if (actionLinkDecorationCount >= ACTION_LINK_DECORATION_LIMIT) break;
      const decoration = term.registerDecoration({ marker, x: match.start, width: match.end - match.start });
      if (!decoration) continue;
      // 虚线下划线画在装饰元素下缘（装饰层在文字层上方，无填充不遮字形）。
      decoration.onRender((element) => {
        element.style.borderBottom = "1px dashed var(--primary)";
      });
      disposables.push(decoration);
      entry.decorations++;
      actionLinkDecorationCount++;
    }
    actionLinkDecorationsByRow.set(row, entry);
  }
}

// 设置变化（总开关或三类匹配器）：即时生效——provider 构造时快照 matchers，
// 任何变化都重建；关闭时零挂钩子（摘 provider + 清 decoration）。
watch(actionLinksSettings, (next) => {
  if (!terminal) return;
  if (next.enabled) {
    actionLinkProviderDisposable?.dispose();
    actionLinkProviderDisposable = undefined;
    clearActionLinkDecorations();
    attachActionLinks();
  } else {
    detachActionLinks();
  }
}, { deep: true });

// ---- 行号 / 时间戳 gutter（P1-3）----
const gutterSettings = ref<GutterSettings>(sanitizeGutterSettings(undefined));
const gutterRows = ref<GutterRow[]>([]);
const gutterCellHeight = ref<number | null>(null);
// 大输出写入期挂起重算（terminalWriteThrottle 积压 > 256KiB 即跳帧，落定后由
// 下一次 onRender/onScroll 事件跟上），避免 gutter 追帧放大 strained 场景开销。
const GUTTER_SUSPEND_PENDING_BYTES = 256 * 1024;
let gutterRafId = 0;
let gutterScreenOffsetTop = 0;
// 逻辑行首绝对行号 → 写入时刻。裁剪保留视口顶端前 3000 行。
const gutterTimestamps = new Map<number, number>();
let gutterLastStampedRow = -1;
let gutterRenderDisposable: { dispose(): void } | undefined;
let gutterScrollDisposable: { dispose(): void } | undefined;
let gutterResizeDisposable: { dispose(): void } | undefined;
let gutterEnterDisposable: { dispose(): void } | undefined;

const gutterPaneVisible = computed(() => gutterSettings.value.showLineNumbers || gutterSettings.value.showTimestamps);
// gutter 只占终端左 padding 环带：两种开关组合给固定宽度（行号 5 位 + 余量）。
const gutterWidth = computed(() => {
  if (!gutterPaneVisible.value) return 0;
  if (gutterSettings.value.showLineNumbers && gutterSettings.value.showTimestamps) return 132;
  return gutterSettings.value.showLineNumbers ? 56 : 88;
});
// 渲染尺寸读不到（渲染器未就绪/WebGL 恢复中）时整体隐藏降级，不报错。
const gutterVisible = computed(() => gutterPaneVisible.value && gutterCellHeight.value !== null && gutterRows.value.length > 0);
const gutterPaneStyle = computed(() => ({ "--dbx-gutter-width": `${gutterWidth.value}px` }));

function isGutterActive() {
  return gutterPaneVisible.value;
}

function attachGutterListeners() {
  if (!terminal || gutterRenderDisposable || !isGutterActive()) return;
  gutterRenderDisposable = terminal.onRender(() => scheduleGutterRecompute());
  gutterScrollDisposable = terminal.onScroll(() => scheduleGutterRecompute());
  gutterResizeDisposable = terminal.onResize(() => scheduleGutterRecompute());
  // 回车重盖光标逻辑行：独立 onData 挂子（routeTerminalData 输入路由不动）。
  gutterEnterDisposable = terminal.onData((data) => {
    if (!gutterSettings.value.showTimestamps) return;
    if (!data.includes("\r") && !data.includes("\n")) return;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    stampLogicalLineContaining(buffer.baseY + buffer.cursorY, Date.now());
    scheduleGutterRecompute();
  });
  scheduleGutterRecompute();
}

function detachGutterListeners() {
  gutterRenderDisposable?.dispose();
  gutterRenderDisposable = undefined;
  gutterScrollDisposable?.dispose();
  gutterScrollDisposable = undefined;
  gutterResizeDisposable?.dispose();
  gutterResizeDisposable = undefined;
  gutterEnterDisposable?.dispose();
  gutterEnterDisposable = undefined;
  if (gutterRafId) {
    cancelAnimationFrame(gutterRafId);
    gutterRafId = 0;
  }
  gutterRows.value = [];
  gutterCellHeight.value = null;
}

function scheduleGutterRecompute() {
  if (!isGutterActive()) return;
  // 大输出保护生效期挂起重算（与下方积压跳帧同一目标，口径更早介入）。
  if (outputGate.mode === "strained") return;
  if (gutterRafId) return;
  gutterRafId = window.requestAnimationFrame(runGutterRecompute);
}

function runGutterRecompute() {
  gutterRafId = 0;
  const term = terminal;
  if (!term || !isGutterActive()) return;
  if (terminalWriteThrottle.pendingBytes > GUTTER_SUSPEND_PENDING_BYTES) return;
  if (outputGate.mode === "strained") return;
  gutterCellHeight.value = getRenderCellHeight(term);
  const buffer = term.buffer.active;
  // 首视口行的像素起点 = xterm 元素的 padding-top（gutter 文本与画布行对齐）。
  const paddingTop = term.element ? Number.parseFloat(window.getComputedStyle(term.element).paddingTop) : Number.NaN;
  gutterScreenOffsetTop = Number.isFinite(paddingTop) ? paddingTop : 0;
  gutterRows.value = computeGutterRows({
    cellHeight: gutterCellHeight.value,
    screenOffsetTop: gutterScreenOffsetTop,
    scrollTop: buffer.viewportY,
    buffer: { type: buffer.type, length: buffer.length, getLine: (y) => buffer.getLine(y) },
    rows: term.rows,
    timestamps: gutterTimestamps,
    showLineNumbers: gutterSettings.value.showLineNumbers,
    showTimestamps: gutterSettings.value.showTimestamps,
    timestampFormat: gutterSettings.value.timestampFormat,
  });
  trimTimestampMap(gutterTimestamps, Math.max(0, buffer.viewportY - GUTTER_TIMESTAMP_RETENTION_ROWS));
}

// 时间戳采集挂点：写入节流 sink 的 terminal.write 完成回调（xterm 解析完这批
// 合并字节后触发）。对新写入的逻辑行首盖 Date.now()；原地重写（进度条）只重盖
// 底行；buffer 变短（clear/重连）时整表重置。
function stampGutterWrittenRows() {
  if (!gutterSettings.value.showTimestamps) return;
  if (!terminal) return;
  const buffer = terminal.buffer.active;
  if (buffer.type === "alternate") return;
  const last = buffer.length - 1;
  if (last < 0) return;
  if (last < gutterLastStampedRow) resetGutterTimestamps();
  const now = Date.now();
  const from = Math.max(0, gutterLastStampedRow);
  for (let row = from; row <= last; row++) {
    if (buffer.getLine(row)?.isWrapped) continue;
    gutterTimestamps.set(row, now);
  }
  gutterLastStampedRow = last;
}

// 回车重盖：光标所在逻辑行（含 wrapped 向上回溯）整体盖为回车时刻。
function stampLogicalLineContaining(absoluteRow: number, atMs: number) {
  if (!terminal) return;
  const buffer = terminal.buffer.active;
  if (buffer.type === "alternate") return;
  let row = Math.max(0, Math.min(absoluteRow, buffer.length - 1));
  let scanned = 0;
  while (row > 0 && scanned < 2048 && buffer.getLine(row)?.isWrapped) {
    row -= 1;
    scanned += 1;
  }
  gutterTimestamps.set(row, atMs);
}

function resetGutterTimestamps() {
  gutterTimestamps.clear();
  gutterLastStampedRow = -1;
}

// gutter 设置变化：挂/摘挂子 + 宽度变化后重算终端列宽（xterm 左 padding 随
// --dbx-gutter-width 变化，FitAddon 需要重新 fit）。
watch(gutterSettings, () => {
  if (terminal && isGutterActive()) attachGutterListeners();
  else detachGutterListeners();
  scheduleGutterRecompute();
  scheduleFit();
}, { deep: true });

// 设置页增量上抛：归一化 → sidecar 持久化（watcher 即时挂/摘）。
function updateActionLinksSettings(patch: { enabled?: boolean; matchers?: Partial<ActionLinkMatcherToggles> }) {
  const next = sanitizeActionLinksSettings({
    enabled: patch.enabled ?? actionLinksSettings.value.enabled,
    matchers: { ...actionLinksSettings.value.matchers, ...(patch.matchers ?? {}) },
  });
  actionLinksSettings.value = next;
  void persistTerminalFeaturePrefs({
    action_links_enabled: next.enabled,
    action_links_matchers: { ipv4: next.matchers.ipv4, host_port: next.matchers.hostPort, archive: next.matchers.archive },
  });
}

function updateGutterSettings(patch: { showLineNumbers?: boolean; showTimestamps?: boolean; timestampFormat?: string }) {
  const next = sanitizeGutterSettings({ ...gutterSettings.value, ...patch });
  gutterSettings.value = next;
  void persistTerminalFeaturePrefs({
    terminal_show_line_numbers: next.showLineNumbers,
    terminal_show_timestamps: next.showTimestamps,
    terminal_timestamp_format: next.timestampFormat,
  });
}

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

/** showHidden 切换后侧栏树缓存失效——下次展开节点时重新拉取、按新可见性过滤。 */
watch(sftpShowHidden, () => {
  markTreeStale(sftpTree.value);
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

// 应用内弹窗确认：宿主沙箱 iframe 无 allow-modals，window.confirm 恒 false
const auditClearOpen = ref(false);
const auditClearSubmitting = ref(false);
async function confirmAuditClear() {
  auditClearSubmitting.value = true;
  try {
    await window.dbxPlugin.invoke("ssh/audit/clear", {});
    auditClearOpen.value = false;
  } catch {
    // 清空失败静默：保留现列表，用户可再次尝试或刷新。
  } finally {
    auditClearSubmitting.value = false;
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
      applyTreeChildren(sftpTree.value, node.path, result.entries.map((entry) => ({ path: pathFromUri(entry.uri), name: entry.name, kind: entry.kind })), sftpShowHidden.value);
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

/** 侧栏（目录树/快捷路径）行右键：打开 / 复制路径 / 复制文件名 / 压缩。
 *  行处理器只记录负载并互斥收口；定位/打开由包裹侧栏的 reka ContextMenuTrigger
 *  从冒泡上来的原生 contextmenu 事件完成（DirTree/SideNavPanel 不能再 prevent/stop）。 */
function openSideMenu(payload: { path: string }) {
  terminalMenuOpen.value = false;
  fileMenu.value = undefined;
  blankMenu.value = false;
  sideMenu.value = { path: payload.path };
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

/** 空白处右键：新建文件夹 / 新建文件 / 上传文件 / 刷新（与行菜单共用同一 ContextMenu 根；
 *  行右键已由 showFileMenu 先行接管，这里按事件目标兜底空白区）。 */
function onFileAreaContextMenu(event: MouseEvent) {
  if ((event.target as HTMLElement).closest(".file-row")) return;
  terminalMenuOpen.value = false;
  fileMenu.value = undefined;
  sideMenu.value = undefined;
  blankMenu.value = true;
}

function blankMenuAction(action: "mkdir" | "newFile" | "upload" | "refresh" | "symlink") {
  const menu = blankMenu.value;
  blankMenu.value = false;
  if (!menu) return;
  if (action === "refresh") {
    void loadDirectory();
    return;
  }
  if (action === "mkdir") {
    operationDraft.value = "";
    operationDialog.value = "mkdir";
  } else if (action === "symlink") {
    beginSymlinkCreate();
  } else if (action === "upload") {
    void chooseUpload();
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
  if (!fromTerminal) { sftpError.value = ""; sftpErrorOpen.value = false; }
  try {
    const result = await window.dbxPlugin.invoke<{ entries: SftpEntry[] }>(sudoMode.value ? "sudo/listDir" : "sftp/list", {
      sessionId: session.value.sessionId,
      path: normalized,
      // 属主/属组列开启时才要 owner/group 数据（sudo/listDir 恒定附带）。
      includeOwner: visibleColumns.value.includes("owner") || visibleColumns.value.includes("group"),
    });
    if (!listEpoch.isCurrent(epochId)) return;
    // R3-P2-3：响应容错——非数组/畸形行走 sanitize（null entries → 空数组、
    // 缺 kind 的行降级为 file），单行坏数据不再让列表僵死或抛 pageerror。
    entries.value = sanitizeSftpEntries(result.entries);
    linkTargets.value = {};
    void hydrateLinkTargets(entries.value);
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
    else { sftpError.value = message; sftpErrorKey.value += 1; sftpErrorOpen.value = true; }
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
    pluginStore.setItem(SFTP_PANE_OPEN_KEY, sftpPaneDefaultOpen.value ? "true" : "false");
  } catch {
    // localStorage 不可用时偏好仅对当前会话生效。
  }
}

function loadSftpPaneDefaultOpen(): boolean {
  try {
    return sanitizeSftpPaneDefaultOpen(pluginStore.getItem(SFTP_PANE_OPEN_KEY));
  } catch {
    return false;
  }
}

// 下载偏好（保存目录 + 每次询问 + 终端字体来源）：权威存储在 sidecar
// preferences.json——工作台 iframe 是 sandbox="allow-scripts"（opaque
// origin），localStorage 直接抛 SecurityError；localStorage 仅作 web
// 浏览器直连场景的同步缓存。
let prefsHydrated: Promise<void> | null = null;

function loadDownloadDir(): string {
  return downloadDirState.value;
}

function persistDownloadDir(value: string) {
  downloadDirState.value = value.trim();
  void syncPrefs();
}

function loadDownloadUseDefaultDir(): boolean {
  return downloadUseDefaultState.value;
}

function persistDownloadUseDefaultDir(value: boolean) {
  downloadUseDefaultState.value = value;
  void syncPrefs();
}

function loadDownloadConflictPolicy(): DownloadConflictPolicy {
  return downloadConflictState.value;
}

function persistDownloadConflictPolicy(value: DownloadConflictPolicy) {
  downloadConflictState.value = sanitizeConflictPolicy(value);
  void syncPrefs();
}

// 上传并发 / 重复目标策略（P1-5）：设置弹窗经适配器读写，权威态在此。
function loadTransferConcurrency(): number {
  return transferConcurrencyState.value;
}

function persistTransferConcurrency(value: number) {
  transferConcurrencyState.value = clampTransferConcurrency(value);
  void syncPrefs();
}

function loadTransferDuplicatePolicy(): TransferDuplicatePolicy {
  return transferDuplicateState.value;
}

function persistTransferDuplicatePolicy(value: TransferDuplicatePolicy) {
  transferDuplicateState.value = sanitizeTransferDuplicatePolicy(value);
  void syncPrefs();
}

// 命令输入建议（P1-1）：设置弹窗经适配器读写，权威态在此。
function loadSuggestionsEnabled(): boolean {
  return suggestionsEnabledState.value;
}

function persistSuggestionsEnabled(value: boolean) {
  suggestionsEnabledState.value = value;
  void syncPrefs();
}

function loadSuggestionMinChars(): number {
  return suggestionMinCharsState.value;
}

function persistSuggestionMinChars(value: number) {
  suggestionMinCharsState.value = clampSuggestionMinChars(value);
  void syncPrefs();
}

function loadSuggestionMaxChars(): number {
  return suggestionMaxCharsState.value;
}

function persistSuggestionMaxChars(value: number) {
  suggestionMaxCharsState.value = clampSuggestionMaxChars(value);
  void syncPrefs();
}

function cachePrefs() {
  try {
    if (downloadDirState.value) window.localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDirState.value);
    else window.localStorage.removeItem(DOWNLOAD_DIR_KEY);
    // 默认开：只在关闭时落键（"0"），未来默认策略变化时老用户不被钉死。
    if (!downloadUseDefaultState.value) window.localStorage.setItem(DOWNLOAD_USE_DEFAULT_KEY, "0");
    else window.localStorage.removeItem(DOWNLOAD_USE_DEFAULT_KEY);
    if (downloadConflictState.value !== "rename") window.localStorage.setItem(DOWNLOAD_CONFLICT_KEY, downloadConflictState.value);
    else window.localStorage.removeItem(DOWNLOAD_CONFLICT_KEY);
    if (transferConcurrencyState.value !== 3) window.localStorage.setItem(TRANSFER_CONCURRENCY_KEY, String(transferConcurrencyState.value));
    else window.localStorage.removeItem(TRANSFER_CONCURRENCY_KEY);
    if (transferDuplicateState.value !== "rename") window.localStorage.setItem(TRANSFER_DUPLICATE_KEY, transferDuplicateState.value);
    else window.localStorage.removeItem(TRANSFER_DUPLICATE_KEY);
    if (!suggestionsEnabledState.value) window.localStorage.setItem(SUGGESTIONS_ENABLED_KEY, "0");
    else window.localStorage.removeItem(SUGGESTIONS_ENABLED_KEY);
    if (suggestionMinCharsState.value !== 2) window.localStorage.setItem(SUGGESTIONS_MIN_CHARS_KEY, String(suggestionMinCharsState.value));
    else window.localStorage.removeItem(SUGGESTIONS_MIN_CHARS_KEY);
    if (suggestionMaxCharsState.value !== 64) window.localStorage.setItem(SUGGESTIONS_MAX_CHARS_KEY, String(suggestionMaxCharsState.value));
    else window.localStorage.removeItem(SUGGESTIONS_MAX_CHARS_KEY);
  } catch {
    // opaque origin：缓存跳过，内存态仍支撑本次会话。
  }
}

async function syncPrefs() {
  cachePrefs();
  try {
    await window.dbxPlugin.invoke("local/preferences/set", {
      downloadDir: downloadDirState.value,
      downloadUseDefaultDir: downloadUseDefaultState.value,
      downloadConflictPolicy: downloadConflictState.value,
      transfer_concurrency: transferConcurrencyState.value,
      transfer_duplicate_policy: transferDuplicateState.value,
      history_suggestions_enabled: suggestionsEnabledState.value,
      history_suggestion_min_chars: suggestionMinCharsState.value,
      history_suggestion_max_chars: suggestionMaxCharsState.value,
    });
  } catch {
    // 旧 sidecar 无此方法：本次会话内存态兜底。
  }
}

function hydratePrefs(): Promise<void> {
  // Promise 记忆而非布尔：并发调用（onMounted 与本地终端直通分支）共享同一
  // 次加载，直通分支 await 它时偏好保证已就绪。
  prefsHydrated ??= hydratePrefsOnce();
  return prefsHydrated;
}

async function hydratePrefsOnce() {
  try {
    downloadDirState.value = window.localStorage.getItem(DOWNLOAD_DIR_KEY)?.trim() || "";
    downloadUseDefaultState.value = window.localStorage.getItem(DOWNLOAD_USE_DEFAULT_KEY) !== "0";
    downloadConflictState.value = sanitizeConflictPolicy(window.localStorage.getItem(DOWNLOAD_CONFLICT_KEY));
    transferConcurrencyState.value = clampTransferConcurrency(window.localStorage.getItem(TRANSFER_CONCURRENCY_KEY) ?? undefined);
    transferDuplicateState.value = sanitizeTransferDuplicatePolicy(window.localStorage.getItem(TRANSFER_DUPLICATE_KEY));
    suggestionsEnabledState.value = window.localStorage.getItem(SUGGESTIONS_ENABLED_KEY) !== "0";
    suggestionMinCharsState.value = clampSuggestionMinChars(window.localStorage.getItem(SUGGESTIONS_MIN_CHARS_KEY));
    suggestionMaxCharsState.value = clampSuggestionMaxChars(window.localStorage.getItem(SUGGESTIONS_MAX_CHARS_KEY));
  } catch {
    // 同上：等待 sidecar 权威值。
  }
  try {
    const prefs = await window.dbxPlugin.invoke<{
      downloadDir?: unknown;
      downloadUseDefaultDir?: unknown;
      downloadConflictPolicy?: unknown;
      localShell?: unknown;
      localShellIntegration?: unknown;
      action_links_enabled?: unknown;
      action_links_matchers?: unknown;
      terminal_show_line_numbers?: unknown;
      terminal_show_timestamps?: unknown;
      terminal_timestamp_format?: unknown;
      transfer_concurrency?: unknown;
      transfer_duplicate_policy?: unknown;
      history_suggestions_enabled?: unknown;
      history_suggestion_min_chars?: unknown;
      history_suggestion_max_chars?: unknown;
      ctx_search_engines?: unknown;
      wallpaper_enabled?: unknown;
      wallpaper_opacity?: unknown;
    }>("local/preferences/get", {});
    // 背景图本体与偏好同拉（旧 sidecar 无 wallpaper/* 时静默缺席）。
    void loadWallpaperImage();
    if (typeof prefs.downloadDir === "string") downloadDirState.value = prefs.downloadDir.trim();
    if (typeof prefs.downloadUseDefaultDir === "boolean") downloadUseDefaultState.value = prefs.downloadUseDefaultDir;
    if (prefs.downloadConflictPolicy !== undefined) downloadConflictState.value = sanitizeConflictPolicy(prefs.downloadConflictPolicy);
    if (typeof prefs.localShell === "string") localShellPref.value = prefs.localShell;
    if (typeof prefs.localShellIntegration === "boolean") localShellIntegrationPref.value = prefs.localShellIntegration;
    // 动作链接 / gutter：键位缺省时保持内存默认（功能关闭），不无谓覆写。
    if (prefs.action_links_enabled !== undefined || prefs.action_links_matchers !== undefined) {
      actionLinksSettings.value = sanitizeActionLinksSettings({ enabled: prefs.action_links_enabled, matchers: prefs.action_links_matchers });
    }
    if (prefs.terminal_show_line_numbers !== undefined || prefs.terminal_show_timestamps !== undefined || prefs.terminal_timestamp_format !== undefined) {
      gutterSettings.value = sanitizeGutterSettings({
        showLineNumbers: prefs.terminal_show_line_numbers,
        showTimestamps: prefs.terminal_show_timestamps,
        timestampFormat: prefs.terminal_timestamp_format,
      });
    }
    if (prefs.transfer_concurrency !== undefined) transferConcurrencyState.value = clampTransferConcurrency(prefs.transfer_concurrency);
    if (prefs.transfer_duplicate_policy !== undefined) transferDuplicateState.value = sanitizeTransferDuplicatePolicy(prefs.transfer_duplicate_policy);
    if (prefs.history_suggestions_enabled !== undefined) suggestionsEnabledState.value = prefs.history_suggestions_enabled === true;
    if (prefs.history_suggestion_min_chars !== undefined) suggestionMinCharsState.value = clampSuggestionMinChars(prefs.history_suggestion_min_chars);
    if (prefs.history_suggestion_max_chars !== undefined) suggestionMaxCharsState.value = clampSuggestionMaxChars(prefs.history_suggestion_max_chars);
    // 在线搜索引擎表：键缺省保持默认 Google（ctxSearchEngines 解析对空/非法行鲁棒）。
    if (typeof prefs.ctx_search_engines === "string") ctxSearchEnginesText.value = prefs.ctx_search_engines;
    // 背景图偏好：键缺省保持内存默认（关 / 45%）。
    if (typeof prefs.wallpaper_enabled === "boolean") wallpaperEnabled.value = prefs.wallpaper_enabled;
    if (prefs.wallpaper_opacity !== undefined) wallpaperOpacity.value = Math.min(90, Math.max(10, Math.round(Number(prefs.wallpaper_opacity) || 45)));
    cachePrefs();
  } catch {
    // 旧 sidecar：保留 localStorage 种子或默认。
  }
}

// 建议长度上下限钳制：min 1..=16（默认 2），max 8..=512（默认 64），且 max 不低于 min。
function clampSuggestionMinChars(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(16, Math.max(1, Math.floor(parsed)));
}

function clampSuggestionMaxChars(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 64;
  return Math.min(512, Math.max(8, Math.floor(parsed)));
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
    settingsDialog.value?.setDownloadDirDraft(normalized);
  }
  persistDownloadUseDefaultDir(true);
  settingsDialog.value?.setDownloadUseDefaultDraft(true);
}

// 「浏览」按钮打开应用内目录选择器（FolderPickerDialog，sidecar 列本机
// 目录）：沙箱 iframe 没有目录选择 API，原生系统对话框有窗口层级问题。
// target 记录选中值回填到哪——下载询问弹窗还是设置页草稿。
const folderPickerTarget = ref<"prompt" | "settings" | null>(null);

function onFolderPicked(path: string) {
  if (folderPickerTarget.value === "prompt" && downloadPrompt.value) {
    downloadPrompt.value.dir = path;
  } else if (folderPickerTarget.value === "settings") {
    settingsDialog.value?.setDownloadDirDraft(path);
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

// 侧栏形态偏好：pluginStore 全局持久化（不可用时仅当前会话生效，默认 tree/展开）。
function loadSftpSideTab(): "tree" | "quick" {
  try {
    return pluginStore.getItem(SFTP_SIDE_TAB_KEY) === "quick" ? "quick" : "tree";
  } catch {
    return "tree";
  }
}

function loadSftpSideCollapsed(): boolean {
  try {
    return pluginStore.getItem(SFTP_SIDE_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSftpSideShape() {
  try {
    pluginStore.setItem(SFTP_SIDE_TAB_KEY, sftpSideTab.value);
    pluginStore.setItem(SFTP_SIDE_COLLAPSED_KEY, sftpSideCollapsed.value ? "true" : "false");
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

/**
 * 终端行为落地：把行为偏好写进 xterm 选项。字体/行高/字间距等外观项不在此处
 * （见 applyTerminalAppearance），这里只管行为类选项。
 */
function applyTerminalBehavior() {
  if (!terminal) return;
  const patch = terminalBehaviorOptionPatch(terminalBehavior.value);
  terminal.options.scrollback = patch.scrollback;
  terminal.options.scrollOnUserInput = patch.scrollOnUserInput;
  terminal.options.wordSeparator = patch.wordSeparator;
  terminal.options.ignoreBracketedPasteMode = patch.ignoreBracketedPasteMode;
  terminal.options.macOptionIsMeta = patch.macOptionIsMeta;
}

/** 行为设置局部更新（设置页控件）：归一化 → 持久化 → 即时生效。 */
function updateTerminalBehavior(patch: Partial<TerminalBehaviorSettings>) {
  const next = sanitizeTerminalBehavior({ ...terminalBehavior.value, ...patch });
  const copyChanged = next.copyOnSelect !== terminalBehavior.value.copyOnSelect;
  terminalBehavior.value = next;
  persistTerminalBehavior(next);
  applyTerminalBehavior();
  // 选中复制沿用既有即时反馈文案。
  if (copyChanged) {
    showNotice(t(next.copyOnSelect ? "terminalSelectCopy.enabledNotice" : "terminalSelectCopy.disabledNotice"));
  }
}

/** 快捷键绑定更新：归一化 → 持久化。派发每次按键实时读表，无需重挂钩子。 */
function updateTerminalHotkeys(bindings: TerminalHotkeyBindings) {
  const next = sanitizeTerminalHotkeys(bindings, applePlatform);
  terminalHotkeys.value = next;
  persistTerminalHotkeys(next);
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
  const hadOwnerData = visibleColumns.value.includes("owner") || visibleColumns.value.includes("group");
  visibleColumns.value = visibleColumns.value.includes(column) ? visibleColumns.value.filter((value) => value !== column) : [...visibleColumns.value, column];
  persistState();
  // 属主/属组列从关到开：当前列表可能没有 owner/group 数据（此前请求没带
  // includeOwner），重拉一次目录；关列不需要重拉。
  if ((column === "owner" || column === "group") && !hadOwnerData && session.value && !sudoMode.value) {
    void loadDirectory();
  }
}

// —— SFTP 列宽拖拽 ——
// 名称列（弹性填充）从 DOM 实时宽度起算；固定列从记录宽度起算。
function onColResizeStart(column: SftpColumn | "name", event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  (event.target as Element).setPointerCapture?.(event.pointerId);
  let startWidth: number;
  if (column === "name") {
    const cell = (event.target as Element).closest(".col-wrap");
    startWidth = cell ? Math.round(cell.getBoundingClientRect().width) : (sftpNameWidth.value ?? NAME_COLUMN_MIN);
  } else {
    startWidth = sftpColumnWidths[column];
  }
  sftpResizing = { column, startX: event.clientX, startWidth };
  document.body.classList.add("resizing-col");
  document.addEventListener("pointermove", onColResizeMove);
  document.addEventListener("pointerup", onColResizeEnd);
}
function onColResizeMove(event: PointerEvent) {
  if (!sftpResizing) return;
  const delta = event.clientX - sftpResizing.startX;
  const next = Math.round(sftpResizing.startWidth + delta);
  if (sftpResizing.column === "name") {
    sftpNameWidth.value = Math.max(NAME_COLUMN_MIN, Math.min(NAME_COLUMN_MAX, next));
  } else {
    sftpColumnWidths[sftpResizing.column] = Math.max(COLUMN_MIN_WIDTHS[sftpResizing.column], Math.min(COLUMN_WIDTH_MAX, next));
  }
}
function onColResizeEnd() {
  if (!sftpResizing) return;
  sftpResizing = null;
  document.body.classList.remove("resizing-col");
  document.removeEventListener("pointermove", onColResizeMove);
  document.removeEventListener("pointerup", onColResizeEnd);
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
    const raw = pluginStore.getItem(SFTP_PATH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return sanitizePathHistories(parsed, SFTP_PATH_HISTORY_LIMIT);
  } catch {
    return {};
  }
}

function persistPathHistories() {
  try {
    pluginStore.setItem(SFTP_PATH_HISTORY_KEY, JSON.stringify(pathHistories));
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

// #54 路径栏分段回跳：非编辑态把路径渲染成一串分段 chip（根目录 / 也可点击
// 回根），点击任一分段经 goToPath 直接回到对应前缀；点击分段以外区域或导航
// 框聚焦后 Enter 进入编辑态，输入行为与原先完全一致（复用 submitPathInput）。
const pathBarEditing = ref(false);
const pathBarInputEl = ref<HTMLInputElement | null>(null);
// 进入编辑瞬间的路径快照：Esc 是显式取消手势，把草稿还原成编辑前的显示值
// （失焦仍保留草稿，与输入框既有语义一致——只有 Esc 回滚）。
const pathBarDraft = ref("");
const pathCrumbs = computed(() => splitRemotePathSegments(currentPath.value));

function beginPathBarEdit() {
  if (pathBarEditing.value) return;
  pathBarDraft.value = currentPath.value;
  pathBarEditing.value = true;
  void nextTick(() => pathBarInputEl.value?.focus());
}

function cancelPathBarEdit() {
  currentPath.value = pathBarDraft.value;
  pathBarEditing.value = false;
}

// R3-P2-4：路径栏提交统一入口——`~`（home 已探测时）展开、`.`/`..` 段消解
// 及基础归一，下游 joinRemote/exists 拼接与路径历史不再携带未规范路径。
function submitPathInput() {
  if (!connected.value) return;
  const target = resolveRemotePath(currentPath.value, sftpHomePath.value || undefined);
  currentPath.value = target;
  pathBarEditing.value = false;
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
    // 宿主文件桥失败（pick 或读盘，如 unknown plugin file handle，issue #83/#79）
    // 时不再直接终止：回退到 webview 原生文件选择（File API），上传仍可继续。
    if (isHostBridgeReadFailure(cause)) {
      fallbackToNativeUploadPicker();
      return;
    }
    showError(cause);
  }
}

async function uploadHandleFiles(files: Array<{ handleId: string; name: string; size: number }>, targetDir?: string) {
  if (!window.dbxPlugin.fileTransfer || !files.length) return;
  uploadDuplicateBatchDecision = undefined;
  await runTransfers(files, loadTransferConcurrency(), {
    id: (file) => file.handleId,
    run: async (file) => {
      try {
        await uploadSource(file.name, file.size, async (offset, length) => {
          const result = await window.dbxPlugin.fileTransfer!.read(file.handleId, offset, length);
          return window.dbxPlugin.decodeBase64(result.dataBase64);
        }, undefined, targetDir);
      } catch (cause) {
        // 桥接读盘错误转成可理解的提示；uploadSource 已补 upload-read-failed 代码，
        // 终端拖入路径（同函数）的 showError 也会显示这条友好文案。
        if (isHostBridgeReadFailure(cause)) {
          const code = (cause as Error & { code?: unknown }).code;
          throw Object.assign(new Error(t("uploadBridgeReadFailed", { name: file.name })), { code, cause });
        }
        throw cause;
      } finally {
        await window.dbxPlugin.fileTransfer!.cancel(file.handleId).catch(() => undefined);
      }
    },
  });
}

function isHostBridgeReadFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const code = (cause as Error & { code?: unknown }).code;
  return code === "upload-read-failed" || /file handle/i.test(cause.message);
}

// 桥接不可用时的兜底（对标 dbx-plugin-files PR #47）：提示后自动打开 webview
// 原生文件选择器（File API，不依赖宿主句柄），上传仍可完成。
function fallbackToNativeUploadPicker() {
  showNotice(t("uploadBridgeFallback"));
  uploadInput.value?.click();
}

// 宿主 fileTransfer 桥的拖入链路（桌面端）：OS 级拖放由宿主 webview 捕获并路由
// 到本工作台。与其他两条链路共用同一道门禁：只读连接/断连时拒绝并提示，不能
// 成为绕过 readOnly 的旁路。落点按面板状态分流（planHostFileDrop）：SFTP 面板
// 打开 → 当前目录；终端独占 → 走落点询问；否则忽略。桥故障时与工具栏上传一致
// 回退原生选择器重挑，而不是只报错走死。
async function handleHostFileDrop(files: Array<{ handleId: string; name: string; size: number; contentType: string }>) {
  dragActive.value = false;
  if (!canAcceptFileDrop({ connected: connected.value, canWrite: canWrite.value })) {
    showNotice(t("dropRefused"));
    return;
  }
  const plan = planHostFileDrop({
    files: files.length,
    connected: connected.value,
    canWrite: canWrite.value,
    sftpPaneOpen: sftpPaneOpen.value,
    terminalTransferBusy: terminalTransferBusy.value,
  });
  if (plan.kind === "ignore") return;
  openTransferPanel();
  try {
    if (plan.kind === "terminal") {
      const choice = await askDropUploadTarget(files);
      terminal?.focus();
      if (choice === "cancel") return;
      await uploadHandleFiles(files, choice === "cwd" ? dropCwdTarget.value : choice.dir);
    } else {
      await uploadHandleFiles(files);
      await loadDirectory();
    }
    if (files.length) showNotice(t("uploaded", { count: files.length }));
  } catch (cause) {
    if (isHostBridgeReadFailure(cause)) fallbackToNativeUploadPicker();
    else showError(cause);
  }
}

async function uploadLocalFiles(files: readonly File[], targetDir?: string) {
  openTransferPanel();
  uploadDuplicateBatchDecision = undefined;
  // File 对象没有稳定 id：包一层带序号的 key 再交给调度器。
  const entries = files.map((file, index) => ({ file, key: `local-${index}` }));
  await runTransfers(entries, loadTransferConcurrency(), {
    id: (entry) => entry.key,
    run: (entry) => uploadSource(entry.file.name, entry.file.size, async (offset, length) => new Uint8Array(await entry.file.slice(offset, offset + length).arrayBuffer()), undefined, targetDir),
  });
  await loadDirectory();
  if (files.length) showNotice(t("uploaded", { count: files.length }));
}

async function uploadSource(name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string) {
  if (!session.value) return;
  // resume 携带原 taskId/remotePath：后端校验 spool meta 后从已传前缀续接。
  // targetDir 仅新上传生效（终端拖入的自定义目标目录）；缺省仍是 SFTP 当前目录。
  const dir = targetDir ?? currentPath.value;
  // 重复目标预检（P1-5）：仅新上传生效；rename 可能改写最终远端文件名，
  // 后续 remotePath 与传输面板展示名都用解析后的名字。
  let uploadName = name;
  if (!resume) {
    const resolved = await resolveUploadDuplicateName(name, dir);
    if (!resolved.proceed) return;
    uploadName = resolved.name;
  }
  const info = await window.dbxPlugin.invoke<{ taskId: string; chunkSize: number; resumeOffset?: number }>("sftp/upload/start", resume
    ? { sessionId: session.value.sessionId, remotePath: resume.remotePath, size, resumeTaskId: resume.taskId }
    : { sessionId: session.value.sessionId, remotePath: joinRemote(dir, uploadName), size });
  const startOffset = info.resumeOffset ?? 0;
  transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "upload", fileName: uploadName, size, transferred: startOffset, status: startOffset > 0 ? "running" : "queued", joinedAt: Date.now() };
  try {
    let offset = startOffset;
    while (offset < size) {
      await waitWhilePaused(info.taskId);
      let chunk: Uint8Array;
      try {
        chunk = await readChunk(offset, info.chunkSize);
      } catch (cause) {
        throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { code: "upload-read-failed" });
      }
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
    // finish RPC 只把远端推送交给 sidecar 后台任务就返回（多 GB 文件的推送
    // 可达数十分钟，长持 RPC 会被桥上任何一端的 deadline 判死并"自动取消"，
    // issue #60）；真正的完成/失败由终态 progress 事件回传，这里等它落地。
    try {
      await window.dbxPlugin.invoke("sftp/upload/finish", { taskId: info.taskId }, { timeoutMs: 60_000 });
    } catch (cause) {
      throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { code: "upload-start-failed" });
    }
    await waitForTransferCompletion(info.taskId);
  } catch (cause) {
    await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId, reason: transferCancelReason(cause) }).catch(() => undefined);
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
        else reject(Object.assign(new Error(t("errors.uploadAckTimeout")), { code: "upload-ack-timeout" }));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }, 30_000);
    uploadAckWaiters.set(taskId, { nextOffset, resolve, reject, timer });
  });
}

// —— 外部编辑器回传（P2-5）——
// watch/file-modified 的确认策略：「总是上传」的记忆命中直接推回，否则弹
// 确认框让用户逐次决定（上传一次 / 总是上传 / 取消）。
function handleWatchModified(watchId: string) {
  const name = activeExternalWatch.value?.name || "";
  if (alwaysUploadWatches.has(watchId)) {
    void uploadWatchedFile(watchId);
    return;
  }
  watchModifiedPrompt.value = { watchId, name };
}

// watch/upload 由 sidecar 从 remote-edit 下载路径读字节、经 sftp/write 同款
// 原子提交写回远端（写门禁 ensure_writable 在后端强制）。完成后刷新当前
// 目录，让大小/修改时间立即反映编辑后的内容。
async function uploadWatchedFile(watchId: string) {
  if (externalEditBusy.value) return;
  externalEditBusy.value = true;
  watchModifiedPrompt.value = null;
  try {
    await window.dbxPlugin.invoke<{ remotePath: string; size: number }>("watch/upload", { watchId });
    showNotice(t("sftpEdit.uploaded", { name: activeExternalWatch.value?.name || "" }));
    // 刷新当前目录，让大小/修改时间立即反映编辑后的内容。
    await loadDirectory();
  } catch (cause) {
    showError(cause, "sftp");
  } finally {
    externalEditBusy.value = false;
  }
}

function dismissWatchModified() {
  watchModifiedPrompt.value = null;
}

// 「总是上传」：记住本次监听的 watchId 后直接推回当前内容。
function uploadWatchedFileAlways() {
  const prompt = watchModifiedPrompt.value;
  if (!prompt) return;
  alwaysUploadWatches.add(prompt.watchId);
  void uploadWatchedFile(prompt.watchId);
}

/** 本地路径拼接（下载目录 + remote-edit 子目录），兼容结尾分隔符。 */
function joinLocalPath(dir: string, suffix: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

/** 精简单文件下载（外部编辑专用）：saveToLocal 直落 `downloadDir`，冲突直接
 * 覆盖（目录带时间戳不会撞名），完成后返回 sidecar 落盘的绝对路径。 */
async function downloadForExternalEdit(entry: SftpEntry, downloadDir: string): Promise<string | undefined> {
  if (!session.value || entry.kind !== "file") return undefined;
  openTransferPanel();
  const info = await window.dbxPlugin.invoke<DownloadInfo>("sftp/download/start", {
    sessionId: session.value.sessionId,
    remotePath: pathFromUri(entry.uri),
    saveToLocal: true,
    downloadDir,
    conflict: "overwrite",
  });
  transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "download", fileName: info.fileName, size: info.size, transferred: 0, status: "queued", joinedAt: Date.now() };
  try {
    let offset = 0;
    while (offset < info.size) {
      await waitWhilePaused(info.taskId);
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // 取消经 chunk waiter 中断；吞掉在途请求的 rejection 以免变成 unhandled。
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      await chunkPromise;
      offset += result.length;
      const task = transferTasks[info.taskId];
      if (task) {
        task.status = "running";
        task.transferred = offset;
      }
      if (result.eof) break;
    }
    const finish = await window.dbxPlugin.invoke<{ localPath?: string }>("sftp/download/finish", { taskId: info.taskId });
    cancelledTransferTasks.delete(info.taskId);
    const task = transferTasks[info.taskId];
    if (task) {
      task.status = "completed";
      task.transferred = info.size;
      if (finish?.localPath) task.localPath = finish.localPath;
    }
    return finish?.localPath;
  } catch (cause) {
    const waiter = downloadChunkWaiters.get(info.taskId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      downloadChunkWaiters.delete(info.taskId);
    }
    await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
    throw cause;
  }
}

/** 「在外部编辑器中打开」：下载 → watch/start → 系统默认程序打开 → 通知。
 * 仅桌面端可用（web/docker 的 sidecar 不在本机，无法监听也无法回传）。 */
async function openInExternalEditor(entry: SftpEntry) {
  fileMenu.value = undefined;
  if (!session.value || externalEditBusy.value) return;
  const local = await probeLocalCapabilities();
  if (!local?.canSaveLocal) {
    showNotice(t("sftpEdit.desktopOnly"));
    return;
  }
  externalEditBusy.value = true;
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dir = joinLocalPath(loadDownloadDir() || local.downloadsDir, `remote-edit/${stamp}`);
    const localPath = await downloadForExternalEdit(entry, dir);
    if (!localPath || !session.value) return;
    const remotePath = pathFromUri(entry.uri);
    const watch = await window.dbxPlugin.invoke<{ watchId: string }>("watch/start", {
      sessionId: session.value.sessionId,
      remotePath,
      localPath,
    });
    alwaysUploadWatches.delete(watch.watchId);
    activeExternalWatch.value = { watchId: watch.watchId, name: entry.name, remotePath };
    // 宿主 local/open 校验该路径确为本插件完成的下载（防任意路径打开）。
    try {
      await window.dbxPlugin.invoke("local/open", { path: localPath });
    } catch {
      await window.dbxPlugin.invoke("local/reveal", { path: localPath });
    }
    copyTextToClipboard(localPath, "sftpEdit.pathCopied");
    showNotice(t("sftpEdit.watching", { name: entry.name }));
  } catch (cause) {
    showError(cause, "sftp");
  } finally {
    externalEditBusy.value = false;
  }
}

// —— 符号链接（P2-6）——
function beginSymlinkCreate() {
  if (!session.value) return;
  symlinkDraft.value = "";
  symlinkTargetDraft.value = "";
  symlinkDialog.value = { mode: "create", linkPath: "", name: "" };
}

function beginSymlinkEdit(entry: SftpEntry) {
  if (!session.value) return;
  symlinkDraft.value = linkTargets.value[entry.uri] || "";
  symlinkDialog.value = { mode: "edit", linkPath: pathFromUri(entry.uri), name: entry.name };
}

/** 新建/改指向共用提交：create 走 sftp/symlink-create（target 允许相对路径），
 * edit 先 readlink 比对避免无谓的删建（后端也会 no-op 兜底）。 */
async function commitSymlink() {
  const dialog = symlinkDialog.value;
  const isCreate = dialog?.mode === "create";
  const name = isCreate ? symlinkDraft.value.trim() : dialog?.name || "";
  const target = (isCreate ? symlinkTargetDraft.value : symlinkDraft.value).trim();
  if (!session.value || !dialog || !target || symlinkSubmitting.value) return;
  if (isCreate && !name) return;
  symlinkSubmitting.value = true;
  try {
    if (isCreate) {
      await window.dbxPlugin.invoke("sftp/symlink-create", {
        sessionId: session.value.sessionId,
        target,
        linkPath: joinRemote(currentPath.value, name),
      });
    } else {
      await window.dbxPlugin.invoke("sftp/symlink-update", {
        sessionId: session.value.sessionId,
        linkPath: dialog.linkPath,
        target,
      });
      linkTargets.value = { ...linkTargets.value, [`sftp:${dialog.linkPath}`]: target };
    }
    symlinkDialog.value = null;
    await loadDirectory();
  } catch (cause) {
    showError(cause, "sftp");
  } finally {
    symlinkSubmitting.value = false;
  }
}

/** symlink 行的 tooltip：`→ target`（target 由列表加载后的只读解析填充）。 */
function linkTargetTitle(entry: SftpEntry): string | undefined {
  if (entry.kind !== "symlink") return undefined;
  const target = linkTargets.value[entry.uri];
  return target ? `→ ${target}` : undefined;
}

/** 列表加载后解析 symlink 条目的指向（只读 readlink，并发、失败静默——
 * 悬空链接也照常显示，tooltip 缺失只是没有 target 文案）。 */
async function hydrateLinkTargets(list: SftpEntry[]) {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  const links = list.filter((entry) => entry.kind === "symlink").slice(0, 50);
  if (!links.length) return;
  const next = { ...linkTargets.value };
  await Promise.allSettled(
    links.map(async (entry) => {
      const result = await window.dbxPlugin.invoke<{ target?: string }>("sftp/symlink-read", {
        sessionId,
        linkPath: pathFromUri(entry.uri),
      });
      if (result?.target) next[entry.uri] = result.target;
    }),
  );
  linkTargets.value = next;
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
  // 目录条目走递归文件夹下载（tree/start + 同一分块管线）；文件沿用单文件管线。
  if (entry.kind === "directory") {
    await downloadDirectoryEntry(entry);
    return;
  }
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
    transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "download", fileName: info.fileName, size: info.size, transferred: 0, status: "queued", joinedAt: Date.now() };
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

// —— 递归文件夹下载（issue #46）：目录条目 → sftp/download/tree/start ——
// 复用单文件下载的分块循环（saveToLocal 语义：字节留在 sidecar 落盘，前端
// 只跟进度）；与文件下载的差异：必须本机落盘（web/docker 无本地文件系统时
// 不可用），循环跑到 eof 为止（空树也会先收到一次空 eof 块），根名撞车由
// sidecar 自动让位（无「覆盖」语义），取消/未完成时 sidecar 整树删除。
async function downloadDirectoryEntry(entry: SftpEntry) {
  fileMenu.value = undefined;
  openTransferPanel();
  if (!session.value || entry.kind !== "directory") return;
  const local = await probeLocalCapabilities();
  if (!local?.canSaveLocal) {
    showError(new Error(t("folderDownload.unsupported")));
    return;
  }
  // 「使用默认地址」关闭时先选保存目录；取消则整次下载不发生。
  let dirOverride = "";
  let setDefaultAfter = false;
  if (!loadDownloadUseDefaultDir()) {
    const chosen = await askDownloadTarget(entry.name);
    if (chosen === undefined) return;
    dirOverride = chosen.dir.trim();
    setDefaultAfter = chosen.setDefault;
  }
  let info: DownloadInfo | undefined;
  try {
    // start 里做远端递归扫描（有界）：树很大时这一步本身耗时，给足超时。
    info = await window.dbxPlugin.invoke<DownloadInfo>("sftp/download/tree/start", {
      sessionId: session.value.sessionId,
      remotePath: pathFromUri(entry.uri),
      downloadDir: dirOverride || loadDownloadDir() || undefined,
    }, { timeoutMs: 10 * 60 * 1000 });
    transferTasks[info.taskId] = {
      taskId: info.taskId,
      sessionId: session.value.sessionId,
      direction: "download",
      fileName: info.fileName,
      size: info.size,
      transferred: 0,
      status: "running",
      fileCount: info.fileCount,
    };
    let offset = 0;
    while (true) {
      await waitWhilePaused(info.taskId);
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // 取消会通过分块等待器中断；吞掉在途请求的拒绝避免 unhandled rejection。
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      const chunk = await chunkPromise;
      if (!result.eof && result.length === 0) throw new Error(t("errors.downloadEmptyChunk"));
      offset += result.length;
      if (chunk.byteLength && chunk.byteLength !== result.length) throw new Error(t("errors.downloadChunkLength"));
      const task = transferTasks[info.taskId];
      if (task) {
        task.status = "running";
        task.transferred = offset;
      }
      if (result.eof) break;
    }
    const finish = await window.dbxPlugin.invoke<FolderDownloadFinish>("sftp/download/finish", { taskId: info.taskId }, { timeoutMs: 30 * 60 * 1000 });
    cancelledTransferTasks.delete(info.taskId);
    const outcome = folderDownloadOutcome(finish);
    const task = transferTasks[info.taskId];
    if (task) {
      task.status = "completed";
      task.transferred = info.size;
      if (outcome.localPath) task.localPath = outcome.localPath;
      task.failedCount = outcome.failedCount || undefined;
      task.failureSample = outcome.failureSample || undefined;
      task.currentFile = undefined;
    }
    const revealActions = outcome.localPath
      ? [
          {
            label: t("revealInFolder"),
            run: () => {
              const savedPath = outcome.localPath;
              if (savedPath) void revealTransferTarget(savedPath);
            },
          },
        ]
      : [];
    let message: string;
    if (outcome.partial) {
      message = t("folderDownload.completedWithFailures", { path: outcome.localPath, count: outcome.failedCount, total: outcome.fileCount });
    } else {
      message = t("downloadedToDir", { count: outcome.fileCount, path: outcome.localPath });
    }
    if (outcome.skippedCount) message += t("folderDownload.skippedNote", { count: outcome.skippedCount });
    showNotice(message, revealActions);
    if (setDefaultAfter) applyChosenDirAsDefault(dirOverride);
  } catch (cause) {
    if (info) {
      const waiter = downloadChunkWaiters.get(info.taskId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        downloadChunkWaiters.delete(info.taskId);
      }
      await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
      if (cancelledTransferTasks.delete(info.taskId)) {
        const task = transferTasks[info.taskId];
        if (task) task.status = "cancelled";
        showNotice(t("transferStatus.cancelled"));
      } else {
        showError(cause, "sftp", () => void downloadDirectoryEntry(entry));
      }
    } else {
      showError(cause, "sftp", () => void downloadDirectoryEntry(entry));
    }
  }
}

// 多选批量下载：文件与目录混选，逐项走各自管线（单项失败不阻断剩余项）。
async function batchDownload() {
  const menu = fileMenu.value;
  fileMenu.value = undefined;
  if (!menu) return;
  const uris = menu.selection.length ? menu.selection : [menu.entry.uri];
  const targets = entries.value.filter((entry) => uris.includes(entry.uri));
  for (const entry of targets) {
    if (entry.kind !== "file" && entry.kind !== "directory") continue;
    await downloadEntry(entry);
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
  // reason=user 让后端账本把"用户主动取消"与异常清理区分开（issue #60）。
  await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: task.taskId, reason: "user" }).catch((cause) => showError(cause));
}

// —— 上传重复目标策略（P1-5）：上传前 sftp/exists 预检，按 transfer_duplicate_policy
// 决定重命名 / 覆盖 / 询问。询问弹窗支持「应用到全部」（批次内生效）。——

/** 批次级「应用到全部」决策：undefined = 尚未决定（逐个询问）。 */
let uploadDuplicateBatchDecision: "overwrite" | "rename" | undefined;

interface UploadDuplicatePrompt {
  fileName: string;
  path: string;
  resolve: (choice: "overwrite" | "rename" | undefined) => void;
}
const uploadDuplicatePrompt = ref<UploadDuplicatePrompt | null>(null);
const uploadDuplicateApplyAll = ref(false);

function resolveUploadDuplicate(choice: "overwrite" | "rename" | undefined) {
  if (choice !== undefined && uploadDuplicateApplyAll.value) uploadDuplicateBatchDecision = choice;
  uploadDuplicatePrompt.value?.resolve(choice);
  uploadDuplicatePrompt.value = null;
  uploadDuplicateApplyAll.value = false;
}

function askUploadDuplicate(fileName: string, path: string): Promise<"overwrite" | "rename" | undefined> {
  return new Promise((resolve) => {
    uploadDuplicatePrompt.value = { fileName, path, resolve };
  });
}

/**
 * 解析上传的最终远端文件名：目标已存在时按策略返回 proceed=false（放弃）或
 * 调整后的名字（rename 经后端 sftp/rename-unique 探测 name(1)..name(999)）。
 * 预检/重命名失败不阻断上传，回落现有覆盖语义。
 */
async function resolveUploadDuplicateName(name: string, targetDir: string): Promise<{ name: string; proceed: boolean }> {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return { name, proceed: true };
  const targetPath = joinRemote(targetDir, name);
  let exists = false;
  try {
    const probe = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", { sessionId, path: targetPath });
    exists = probe.exists === true;
  } catch {
    // 预检不可用时保持原语义直接下发。
    return { name, proceed: true };
  }
  if (!exists) return { name, proceed: true };
  const policy = transferDuplicateState.value;
  if (policy === "overwrite") return { name, proceed: true };
  if (policy === "ask" && uploadDuplicateBatchDecision === undefined) {
    const choice = await askUploadDuplicate(name, targetPath);
    if (!choice) return { name, proceed: false };
    uploadDuplicateBatchDecision = choice;
  }
  if (policy === "ask" && uploadDuplicateBatchDecision === "overwrite") return { name, proceed: true };
  // rename（或 ask 选了重命名）：后端探测不冲突新名；旧 sidecar 无该方法时回落原名覆盖。
  try {
    const result = await window.dbxPlugin.invoke<{ name: string }>("sftp/rename-unique", { sessionId, dir: targetDir, name });
    return { name: result.name || name, proceed: true };
  } catch {
    return { name, proceed: true };
  }
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
  // 与终端侧共用同一道门禁；拒绝时给提示而不是无声吞掉拖入。
  if (!canAcceptFileDrop({ connected: connected.value, canWrite: canWrite.value })) {
    showNotice(t("dropRefused"));
    return;
  }
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) void uploadLocalFiles(files).catch(showError);
}

function onSftpDragEnter(event: DragEvent) {
  // 只对文件拖拽点亮高亮：拖文本/元素路过不应给出可放置暗示（终端侧同款预检）。
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragActive.value = true;
}

function onTerminalDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value, sftpPaneOpen: sftpPaneOpen.value })) return;
  terminalDragActive.value = true;
}

function onTerminalDrop(event: DragEvent) {
  terminalDragActive.value = false;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value, sftpPaneOpen: sftpPaneOpen.value })) {
    // 拒绝不再静默：面板打开时指引拖到面板（那里目录可见），其余（断连/
    // 只读/传输占用）给同一条提示。
    showNotice(t(sftpPaneOpen.value ? "terminalDropToPanel" : "dropRefused"));
    return;
  }
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
    await uploadLocalFiles(files, choice === "cwd" ? dropCwdTarget.value : choice.dir);
  } catch (cause) {
    showError(cause);
  }
}

function askDropUploadTarget(files: Array<{ name: string }>): Promise<"cancel" | "cwd" | { dir: string }> {
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
  terminalCopyCache.set(text);
  try {
    await writeClipboardText(text, clipboardDeps());
    showNotice(t("terminalCopied"));
  } catch {
    showError(new Error(t("terminalCopyUnavailable")), "terminal");
  }
  terminalMenuOpen.value = false;
  terminal?.focus();
}

async function pasteTerminal() {
  terminalMenuOpen.value = false;
  let clipboardText: string | null = null;
  let clipboardReadBlocked = false;
  try {
    clipboardText = await readClipboardText(clipboardDeps());
  } catch {
    // 宿主桥缺失 + 沙箱拒绝读：降级到插件视图内的复制副本（选中复制、
    // 菜单复制、远端 OSC 52 都会写入），XShell 式「选中→右键」因此闭环。
    clipboardReadBlocked = true;
  }
  const text = clipboardReadBlocked
    ? resolveTerminalPasteText({ cachedText: terminalCopyCache.get(), selectionText: terminal?.getSelection() || null })
    : clipboardText || null;
  if (!text) {
    // 无任何可用来源：引导走原生 paste 快捷键（Ctrl+V 走 paste 事件，不依赖读权限）。
    showError(new Error(t("terminalPasteUseShortcut")), "terminal");
    terminal?.focus();
    return;
  }
  await sendConfirmedPaste(text);
}

function interceptTerminalPaste(event: ClipboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  // 粘贴路径不出 ghost：立即消除（onData 不经手粘贴正文，下一次可打印键入重算）。
  hideGhostSuggestion();
  const text = event.clipboardData?.getData("text/plain") || "";
  if (!text) return;
  void sendConfirmedPaste(text);
}

// —— 右键菜单「在线搜索」（IMPL_PLAN Task P2-8）——
// 引擎表以原始文本持久化（sidecar preferences，allowlist 键 ctx_search_engines，
// 每行 name|url 模板）；解析收口在 TerminalContextMenu.vue 的纯函数，非法行静默
// 丢弃、解析永不失败（空表只是隐藏 Search online 项）。
const ctxSearchEnginesText = ref(DEFAULT_CTX_SEARCH_ENGINES_TEXT);
const ctxSearchEngines = computed(() => parseCtxSearchEnginesText(ctxSearchEnginesText.value));
function updateCtxSearchEngines(text: string) {
  ctxSearchEnginesText.value = text;
  void persistTerminalFeaturePrefs({ ctx_search_engines: text });
}
function searchSelectionOnline(engine: CtxSearchEngine) {
  terminalMenuOpen.value = false;
  const query = terminal?.getSelection() || "";
  if (!query) return;
  const url = buildSearchUrl(engine, query);
  if (!url) return;
  // TODO(host): 宿主尚未提供 openExternal；待宿主开放后改为直接唤起系统浏览器。
  // 当前兜底：把搜索链接复制进剪贴板并提示（失败走 sftp 错误条）。
  copyTextToClipboard(url, "ctxSearch.linkCopied");
  terminal?.focus();
}

// —— 背景图（IMPL_PLAN Task P2-9，对标 NyaTerm；MVP 简化）——
// 图源权威态在 sidecar（local/wallpaper/get|set|clear，桌面端落盘
// <plugin_data_dir>/wallpaper，≤8MiB png/jpeg/webp）；web/docker 形态 set 失败
// （sidecar 存储不在本机）或旧 sidecar 无此方法时降级为仅本次会话内存态，
// UI 有说明且不持久化。开关/透明度经 preferences allowlist 键持久化。
const wallpaperEnabled = ref(false);
// 百分比 10..=90（sidecar 侧钳制同口径），渲染时 /100。
const wallpaperOpacity = ref(45);
const wallpaperDataUrl = ref("");
const wallpaperSessionOnly = ref(false);
const wallpaperActive = computed(() => wallpaperEnabled.value && !!wallpaperDataUrl.value);
async function loadWallpaperImage() {
  try {
    const result = await window.dbxPlugin.invoke<{ dataUrl?: string }>("local/wallpaper/get", {});
    if (typeof result.dataUrl === "string") wallpaperDataUrl.value = result.dataUrl;
  } catch {
    // 旧 sidecar：背景图缺席，保持内存态。
  }
}
async function setWallpaperImage(image: { base64: string; mime: string }) {
  try {
    const result = await window.dbxPlugin.invoke<{ dataUrl?: string }>("local/wallpaper/set", { imageBase64: image.base64 });
    if (typeof result.dataUrl === "string") wallpaperDataUrl.value = result.dataUrl;
    wallpaperSessionOnly.value = false;
  } catch {
    // web/docker 形态或旧 sidecar：仅本次会话内存态（mime 来自上传文件读取）。
    wallpaperDataUrl.value = `data:${image.mime || "image/png"};base64,${image.base64}`;
    wallpaperSessionOnly.value = true;
  }
}
async function clearWallpaperImage() {
  wallpaperSessionOnly.value = false;
  wallpaperDataUrl.value = "";
  try {
    await window.dbxPlugin.invoke("local/wallpaper/clear", {});
  } catch {
    // 同 set：会话内存态已清，落盘态留待桌面形态下次清除。
  }
}
function updateWallpaperEnabled(enabled: boolean) {
  wallpaperEnabled.value = enabled;
  void persistTerminalFeaturePrefs({ wallpaper_enabled: enabled });
}
function updateWallpaperOpacity(percent: number) {
  wallpaperOpacity.value = Math.min(90, Math.max(10, Math.round(percent)));
  void persistTerminalFeaturePrefs({ wallpaper_opacity: wallpaperOpacity.value });
}
// 背景图生效期强制 DOM 渲染器（P2-9）：WebGL 画布不透明，盖死背景层；关闭
// 背景图后按用户 WebGL 开关恢复。复用现有 syncWebglRenderer 切换点。
// （注册点必须在 wallpaperActive 定义之后：watch 首次求值会沿依赖链触达它。）
watch(rendererWebglEffective, (next) => {
  if (!terminal) return;
  webglRenderer.value = syncWebglRenderer(terminal, next, webglRenderer.value, () => new WebglAddon(), webglRecoveryOptions());
});

async function sendConfirmedPaste(text: string) {
  // 粘贴文本变换的唯一收口：所有粘贴路径（原生 Ctrl+V、右键/菜单粘贴、中键粘贴）
  // 都经这里，保证「去首尾空白 / 换行折空格」只实现一次、不会分叉。
  // 默认两开关均为关闭，因此这里的默认行为与改动前逐字节一致。
  const payload = transformPasteText(text, terminalBehavior.value);
  if (!payload) return;
  const accepted = await confirmRiskyPaste(payload);
  if (!accepted) {
    terminal?.focus();
    return;
  }
  if (!session.value || terminalTransferBusy.value) return;
  trackPendingInput(payload);
  sendTerminalBytes(new TextEncoder().encode(payload));
  terminal?.focus();
}

function confirmRiskyPaste(text: string): Promise<boolean> {
  // 多行/超长粘贴警告可关（对标 Tabby「Clipboard → Warn on multi-line paste」）；
  // 危险命令（rm -rf 等）的确认是安全兜底，不受该开关约束，永远要确认。
  const confirmation = buildPasteConfirmation(text, { warnOnMultiline: terminalBehavior.value.warnOnMultilinePaste });
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
  terminalMenuOpen.value = false;
  terminal?.focus();
}

function clearTerminal() {
  terminal?.clear();
  resetGutterTimestamps();
  terminalMenuOpen.value = false;
  terminal?.focus();
}

function chooseZmodem() {
  terminalMenuOpen.value = false;
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
    return sanitizeCommandHistory(JSON.parse(pluginStore.getItem(COMMAND_HISTORY_KEY) || "null"));
  } catch {
    return [];
  }
}

function persistCommandHistory() {
  try {
    // 疑似内嵌凭据 / 超长 / 多行的命令只留在内存，不写持久层。
    pluginStore.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory.value.filter(isPersistableCommand)));
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
  const execId = randomUUID();
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

/** 命令条开关：持久化（pluginStore），打开时顺带刷新目标列表。 */
function toggleBatchBar() {
  batchBarOpen.value = !batchBarOpen.value;
  try {
    pluginStore.setItem(BATCH_BAR_OPEN_KEY, batchBarOpen.value ? "1" : "0");
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
      pluginStore.setItem(BATCH_BAR_OPEN_KEY, batchBarOpen.value ? "1" : "0");
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
    // 批量目标包含本地终端：同是"向 PTY 键盘写入"，发送阶段按通道分流。
    let targets = normalizeBatchTargets(response.sessions);
    try {
      const local = await window.dbxPlugin.invoke<{ sessions?: unknown }>("local/session/list", {}, { timeoutMs: 5000 });
      targets = [...targets, ...normalizeLocalBatchTargets(local?.sessions)];
    } catch {
      // 旧 sidecar 无本地会话能力：只保留 SSH 目标。
    }
    batchTargets.value = targets;
    // 剔除已关闭会话；选择为空时默认只预选当前会话（本地面板预选本地会话；
    // 批量写入影响所有被选主机，宁缺毋滥）。
    const known = new Set(batchTargets.value.map((target) => target.sessionId));
    batchSelected.value = batchSelected.value.filter((id) => known.has(id));
    const currentSessionId = session.value?.sessionId ?? localSession.value?.sessionId;
    if (!batchSelected.value.length) {
      batchSelected.value = currentSessionId && known.has(currentSessionId) ? [currentSessionId] : [];
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
function onBatchQuickPick(value: unknown) {
  batchQuickPickId.value = value == null ? "" : String(value);
  applyBatchQuickPick();
}

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
    // 目标按通道分流：SSH 走 sidecar 批量写入；本地终端复用输入队列（同一
    // 序号框架，保持与键入一致的顺序语义），命令补 \r 回车与键入等价。
    const selectedSet = new Set(batchSelected.value);
    const sshIds = batchTargets.value.filter((target) => !target.local && selectedSet.has(target.sessionId)).map((target) => target.sessionId);
    const localIds = batchTargets.value.filter((target) => target.local && selectedSet.has(target.sessionId)).map((target) => target.sessionId);
    const results: unknown[] = [];
    if (sshIds.length) {
      const response = await window.dbxPlugin.invoke<{ results: unknown }>("ssh/terminal/batchInput", { sessionIds: sshIds, command });
      if (Array.isArray(response.results)) results.push(...response.results);
    }
    for (const sessionId of localIds) {
      try {
        terminalInputQueue.enqueue(sessionId, new TextEncoder().encode(`${command}\r`));
        results.push({ sessionId, success: true });
      } catch (cause) {
        results.push({ sessionId, success: false, error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    batchSummary.value = summarizeBatchResults(results);
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

// 列宽要放得下 7 位 PID、常见用户名与带天数的 etime（单元格 ellipsis 会截断关键值）；
// 浮层同步放宽到 448px，满宽时命令列不窄于加宽前；终端面板窄于约 464px 时浮层被
// calc 钳制、命令列会被压缩，属已接受行为。管理表总宽仍超浮层，横向滚动是既有状态。
const metricsProcGridStyle = { gridTemplateColumns: "64px 80px 56px 56px minmax(0, 1fr)" };
const procGridStyle = { gridTemplateColumns: "64px 80px 56px 56px 96px minmax(0, 1fr) 132px" };

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
      // 回放终端跟随终端外观（配色/字体/字号/字重/行高/字间距），
      // 不再是默认纯黑 xterm，也不与主终端产生字形差异。
      const font = resolveTerminalFont(terminalFontOverride.value, {
        fontFamily: hostTerminalFontFamily(appearance.value),
        fontSize: appearance.value.terminal.fontSize,
      });
      const optionPatch = terminalOptionPatch(terminalAppearance.value.settings);
      replayTerminal = new Terminal({
        cols: 100,
        rows: 26,
        convertEol: false,
        theme: terminalTheme(),
        fontFamily: font.fontFamily,
        fontSize: font.fontSize,
        fontWeight: optionPatch.fontWeight,
        fontWeightBold: optionPatch.fontWeightBold,
        lineHeight: optionPatch.lineHeight,
        letterSpacing: optionPatch.letterSpacing,
        drawBoldTextInBrightColors: optionPatch.drawBoldTextInBrightColors,
      });
      replayTerminal.open(replayHost.value);
      // 与主终端同用 Unicode 11 宽度表：emoji/宽字符行在回放里保持相同折行。
      replayTerminal.loadAddon(new Unicode11Addon());
      replayTerminal.unicode.activeVersion = "11";
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
    // 离屏终端与主终端同款外观（配色/字体/字重/行高）：导出的 GIF 必须和用户
    // 屏幕上看到的一致，否则「导出」就失去意义。
    const exportFont = resolveTerminalFont(terminalFontOverride.value, {
      fontFamily: hostTerminalFontFamily(appearance.value),
      fontSize: appearance.value.terminal.fontSize,
    });
    const exportPatch = terminalOptionPatch(terminalAppearance.value.settings);
    term = new Terminal({
      cols: COLS,
      rows: ROWS,
      theme: terminalTheme(),
      fontFamily: exportFont.fontFamily,
      fontSize: exportFont.fontSize,
      fontWeight: exportPatch.fontWeight,
      fontWeightBold: exportPatch.fontWeightBold,
      lineHeight: exportPatch.lineHeight,
      letterSpacing: exportPatch.letterSpacing,
      drawBoldTextInBrightColors: exportPatch.drawBoldTextInBrightColors,
    });
    term.open(host);
    // xterm 6 移除了 canvas 渲染器：DOM 渲染器不产出 canvas，逐帧取像素必须
    // 挂 WebGL renderer。两个此前就存在的坑在此一并修掉：screenElement 下第
    // 一块 canvas 是链接下划线的 2d renderLayer（透明，querySelector 会抓错），
    // 真画布按「能取到 webgl2 上下文」选中（getContext 幂等无副作用）；
    // preserveDrawingBuffer 是 WebglAddon 的构造参数（0.20 beta 起改为 options
    // 对象；默认 false，关闭时合成后回读全零像素），导出终端显式开启——主终端
    // 不取像素，维持默认。GPU 被
    // 禁/context 耗尽挂不上 renderer（DOM 渲染无 canvas）时，走 !screen 分支
    // 给出 replayExportFailed 明确错误，而不是永远空帧。
    attachWebglRenderer(term, () => new WebglAddon({ preserveDrawingBuffer: true }));
    const screen =
      (Array.from(host.querySelectorAll("canvas")) as HTMLCanvasElement[])
        .find((c) => c.getContext("webgl2")) ?? null;
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

function openSettings() {
  settingsOpen.value = true;
  void probeLocalCapabilities();
}

function openProfilesManager() {
  profilesOpen.value = true;
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
  // 右键四档（对标 Tabby「Mouse → Right click」）：off / menu / paste / clipboard。
  // clipboard 档按有无选区决定复制还是粘贴；Shift+右键恒出菜单，是 off 与 paste
  // 档下唯一回到菜单的逃生口（与既有行为一致）。
  // preventDefault 只给非菜单分支：reka 触发器据此跳过开菜单（同时也压住系统菜单）；
  // 菜单分支一旦 preventDefault，ContextMenuTrigger 自己就打不开了。
  const target = resolveRightClickBehavior(terminalBehavior.value, {
    hasSelection: terminal?.hasSelection() ?? false,
    shiftKey: event.shiftKey,
  });
  if (target === "menu") {
    terminalMenuOpen.value = true;
    fileMenu.value = undefined;
    return;
  }
  event.preventDefault();
  terminalMenuOpen.value = false;
  fileMenu.value = undefined;
  if (target === "paste") void pasteTerminal();
  else if (target === "copy") void copyTerminalSelection();
}

function showFileMenu(event: MouseEvent, entry: SftpEntry) {
  // 不再 preventDefault/stopPropagation：事件要冒泡到包裹 .file-rows 的
  // ContextMenuTrigger 完成定位与打开；空白区与行共用同一菜单根，由容器处理器
  // onFileAreaContextMenu 按事件目标区分（行内目标直接返回）。
  selectedPath.value = entry.uri;
  fileMenu.value = {
    entry,
    selection: [...selectedUris.value],
  };
  terminalMenuOpen.value = false;
  blankMenu.value = false;
  sideMenu.value = undefined;
  transferHistoryMenu.value = undefined;
}

function showTransferHistoryMenu(event: MouseEvent, entry: TransferHistoryEntry) {
  // 浏览器下载、上传及旧记录都可能没有可验证的本机路径：拦截系统菜单与
  // reka 触发器（preventDefault 后 reka 跳过打开），但不展示无效操作。
  if (!entry.localPath) {
    event.preventDefault();
    transferHistoryMenu.value = undefined;
    return;
  }
  transferHistoryMenu.value = { taskId: entry.taskId };
  terminalMenuOpen.value = false;
  fileMenu.value = undefined;
  blankMenu.value = false;
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
  terminalMenuOpen.value = false;
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
  localMenuOpen.value = false;
  localShellSurfaceOpen.value = false;
}

function closeMenus() {
  terminalMenuOpen.value = false;
  fileMenu.value = undefined;
  blankMenu.value = false;
  sideMenu.value = undefined;
  transferHistoryMenu.value = undefined;
  closeToolbarPopovers();
}

/** document click 收口：reka 菜单/弹层内容 portal 到 body，内部点击会冒泡到
 *  document——旧实现面板上有 @click.stop，内部点击从不触发这里的清扫，保持语义一致。 */
function onDocumentClickCloseMenus(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest?.('[data-slot="context-menu-content"], [data-slot="popover-content"]')) return;
  closeMenus();
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
 * 弹层焦点管理（P1-2）：打开时焦点进入弹层首控件、关闭后归还触发元素。
 * 原生 autofocus 在 Vue 动态插入时不生效，改为显式驱动；Tab 圈定已移交
 * reka Dialog 的 FocusScope（Phase 6），Esc 关闭链沿用下方
 * onDocumentKeydown 的分层退出。
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
  // 批量目标/高亮规则两个 popover 的点空白收起已移交 reka DismissableLayer
  // （pointerdown-outside → update:open(false)），capture 手动清扫移除。
}
function onDocumentClickCapture(event: MouseEvent) {
  if (!ghostClickGuard.shouldSuppress()) return;
  event.preventDefault();
  event.stopPropagation();
}
function trackStableFocus(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest('[data-slot="dialog-content"]') || target.closest('[data-slot="context-menu-content"]')) return;
  lastStableFocus = target;
}
// 与 Esc 关闭链同源的弹层在开状态（hostKey/agent 审批属安全弹窗：
// 参与聚焦与 Tab 陷阱，但不参与 Esc 关闭）。按模板出现顺序排列，
// 计数变化驱动聚焦/归还；同层互斥由交互保证。
const modalOpenStates = computed(() => [
  localOpenConfirmOpen.value,
  telnetConfirmOpen.value,
  telnetDialogOpen.value,
  serialConfirmOpen.value,
  serialDialogOpen.value,
  serialUploadDialogOpen.value,
  vncConfirmOpen.value,
  vncDialogOpen.value,
  rdpConfirmOpen.value,
  rdpDialogOpen.value,
  rdpCertPrompt.value !== null,
  folderPickerTarget.value !== null,
  previewOpen.value,
  pasteConfirm.value,
  dropUploadPrompt.value,
  downloadPrompt.value !== null,
  downloadConflictPrompt.value !== null,
  uploadDuplicatePrompt.value !== null,
  attrsTarget.value,
  deleteTarget.value,
  batchDeleteOpen.value,
  recordingDeleteTarget.value !== null,
  recordingClearAllOpen.value,
  transferHistoryClearOpen.value,
  chmodTarget.value,
  newFileDialog.value,
  operationDialog.value,
  symlinkDialog.value !== null,
  watchModifiedPrompt.value !== null,
  commandOpen.value,
  profilesOpen.value,
  auditOpen.value,
  auditClearOpen.value,
  settingsOpen.value,
  alertTriageOpen.value,
  hostKeyPrompt.value,
  agentPromptHead.value,
]);
const modalOpenCount = computed(() => modalOpenStates.value.filter(Boolean).length);

/** 当前最顶层弹层容器；无弹层时返回 null（嵌套时取首个命中即最外层——焦点回落语义）。 */
function topModalContainer(): HTMLElement | null {
  if (!modalOpenCount.value) return null;
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
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
  // Tab 焦点陷阱已移交 reka Dialog 的 FocusScope（每个弹层独立圈定，嵌套时顶层
  // 生效）；此处不再拦截 Tab。注意 FocusScope 的 keydown 挂在内容元素上，冒泡先于
  // 本 document 处理器，若恢复自制陷阱会与 reka 双步进，勿回退。
  if (event.key === "Tab") return;
  if (event.key !== "Escape") return;
  // reka Select/ContextMenu/Popover 弹层打开时 Esc 由 reka 消费（关弹层），不落入下方
  // 弹窗关闭链。本处理器注册早于 DismissableLayer，先跑时弹层 DOM 仍在。
  if (document.querySelector('[data-slot="select-content"], [data-slot="context-menu-content"], [data-slot="popover-content"]')) return;
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
  if (uploadDuplicatePrompt.value) {
    resolveUploadDuplicate(undefined);
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
  if (transferHistoryClearOpen.value) {
    transferHistoryClearOpen.value = false;
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
    if (auditClearOpen.value) {
      if (!auditClearSubmitting.value) auditClearOpen.value = false;
      return;
    }
    auditOpen.value = false;
    return;
  }
  if (settingsOpen.value) {
    // 内联 profile 管理（设置弹窗内）沿用 profilesOpen→settingsOpen 的逐层
    // 退出语义：先关编辑表单，再收起配置档 section，最后关弹窗
    // （表单/section 状态在 SettingsDialog 内部，经组件实例询问是否已消费）。
    if (settingsDialog.value?.consumeInlineEsc()) return;
    settingsOpen.value = false;
    return;
  }
  // 右键菜单与九个工具栏 popover 均已迁移 reka（ContextMenu/Popover）：Esc 与外点
  // 由 reka 自行消费（见上方 content 守卫），不再占 Esc 链一层。本层只剩
  // 指标浮层（.metrics-float 非 reka）与批量保存态（带草稿清理）。
  if (metricsOpen.value || batchSaveMode.value) {
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

/** staging 阶段进度条走不定态（推送计数尚未开始），uploading 用真实百分比。 */
function transferBarValue(task: TransferTask): number | undefined {
  return task.phase === "staging" ? undefined : transferPercent(task);
}

/** staging 行展示的字节数：spool 进度；其余阶段是已推送/已接收计数。 */
function transferShownBytes(task: TransferTask): number {
  return task.phase === "staging" ? task.staged ?? 0 : task.transferred;
}

/** 精确字节数 tooltip：化解 5.9GB(十进制) vs 5.49GiB(二进制) 的口径困惑（issue #60）。 */
function transferBytesTitle(task: TransferTask): string | undefined {
  if (!(task.size > 0)) return undefined;
  return `${transferShownBytes(task).toLocaleString()} / ${task.size.toLocaleString()} bytes`;
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
  transportReuseState = createSessionTransportReuseState(hostContext.value);
  locale.value = api.locale || "zh-CN";
  restoreUiState();
  const appearanceAppliedAtBoot = Boolean(api.appearance || api.theme);
  // 外观偏好的 CSS 部分（终端内边距变量）与宿主是否推送 appearance 无关，
  // 开机先落一次，否则用户设了内边距要等下次主题推送才生效。
  applyTerminalPaddingVars();
  if (api.appearance) applyAppearance(api.appearance);
  else if (isDbxPluginTheme(api.theme)) applyAppearance(themeToAppearance(api.theme));
  // 宿主可能在 init 前先应答 host.getContext（如重推连接期间 init 被延迟）：
  // 此时 api.locale/appearance 仍是 bootstrap 默认值。init 落地后重读一次，
  // 否则会话会停在默认英文/默认主题。ready 已解决时 then 立即执行，是幂等重读。
  void api.ready.then(() => {
    if (api.locale) locale.value = api.locale;
    if (!appearanceAppliedAtBoot) {
      if (api.appearance) applyAppearance(api.appearance);
      else if (isDbxPluginTheme(api.theme)) applyAppearance(themeToAppearance(api.theme));
    }
  });
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
    void handleHostFileDrop(files);
  });
  // §8.3 面板加载生命周期：探活与终端创建并行。探活只是一次 sidecar 往返，
  // 串行执行会把真正耗时的 openSession 压到整个引导的最后。
  const reattachLookup = readPluginMode(hostContext.value) !== "local-terminal" && connectionId.value && workbenchId.value && !restored.value
    ? findReattachSession()
    : Promise.resolve("");
  await nextTick();
  createTerminal();
  // P0 connectionless local-terminal passthrough (HOST_PLUGIN_UI_SPEC §4/§7.1): when the host opens this workbench with
  // the workbench is opened with the command context (plugin.mode="local-terminal") (command
  // panel / toolbar entry / self-open bridge), the SSH connection flow is skipped and the local terminal opens directly.
  if (readPluginMode(hostContext.value) === "local-terminal") {
    if (!workbenchId.value) throw new Error(t("errors.hostBridgeMissing"));
    await hydratePrefs();
    // Bottom dock / webview rebuild reopen: first reattach the live shell still bound to this workbenchId in the
    // live shell (reopening never leaks a new PTY; spec §10 leaves no PTY behind on close).
    if (await reattachLocalSession()) return;
    // A4 restore semantics (spec §7.6/§8.4): restoring is not re-running the command — a restored tab
    // no automatic shell — just the exit shell until the user explicitly hits "Reopen".
    if (restored.value) {
      localSession.value = null;
      localState.value = "exited";
      localShellRestored.value = true;
      return;
    }
    // Dock "+" creates with the selected shell type (context.plugin.shell); when unset the preference applies.
    await startLocalTerminal(readPluginShell(hostContext.value) || undefined);
    return;
  }
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
    const reattach = await reattachLookup;
    if (reattach) await attachSession(reattach, reattach);
    // 上一轮本地终端还活着（webview 重建但 sidecar 未退出）：接回并补发，
    // 避免孤儿 shell 挂在 sidecar 里。
    else if (await reattachLocalSession()) {
      // 本地模式接管终端。
    }
    // 上来直接连（§8.3 面板加载生命周期）：宿主已在点击创建条目时
    // ensureConnected 预拨（connectionPreconnected 旗标），这里跳过 force
    // 重开（force 会复位共享连接），直接 openSession——拨号未完成时由
    // preconnect 短间隔轮询自愈（250ms 固定节奏，不再是 2s 退避梯子），
    // 拨号失败/永久错误走既有分类报错。
    // 旧宿主无旗标：保留原有 force 重开路径。
    else {
      if (panelSurface.value && !hostContext.value.connectionPreconnected) await requestHostReopenConnection();
      await openSession(false, true);
    }
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
  document.addEventListener("click", onDocumentClickCloseMenus);
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("mousedown", onDocumentMouseDownCapture, true);
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("focusin", trackStableFocus);
  document.addEventListener("mouseover", onTooltipOver);
  document.addEventListener("mouseout", onTooltipOut);
  document.addEventListener("focusin", onTooltipFocusIn);
  document.addEventListener("focusout", onTooltipFocusOut);
  document.addEventListener("pointerdown", hideTooltip, true);
  document.addEventListener("wheel", hideTooltip, true);
  window.addEventListener("dbx:docker-open-in-terminal", handleDockerOpenInTerminal);
  hostFontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  void hydrateQuickCommands();
  void hydrateHighlightRules();
  void hydratePrefs();
  void initialize().catch((cause) => {
    terminalState.value = "error";
    showError(cause, "terminal");
  });
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("dbx:docker-open-in-terminal", handleDockerOpenInTerminal);
  document.removeEventListener("mouseover", onTooltipOver);
  document.removeEventListener("mouseout", onTooltipOut);
  document.removeEventListener("focusin", onTooltipFocusIn);
  document.removeEventListener("focusout", onTooltipFocusOut);
  document.removeEventListener("pointerdown", hideTooltip, true);
  document.removeEventListener("wheel", hideTooltip, true);
  hostFontObserver.disconnect();
  hideTooltip();
  window.clearTimeout(persistTimer);
  window.clearInterval(recordCountdownTimer);
  void writeWorkbenchState();
  window.clearTimeout(resizeTimer);
  window.clearTimeout(reconnectTimer);
  window.clearInterval(reconnectCountdownTimer);
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
  document.removeEventListener("click", onDocumentClickCloseMenus);
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
  resizeObserver?.disconnect();
  for (const disposable of oscColorQueryDisposables) disposable.dispose();
  oscColorQueryDisposables = [];
  for (const disposable of modeQueryDisposables) disposable.dispose();
  modeQueryDisposables = [];
  osc52Disposable?.dispose();
  osc52Disposable = undefined;
  disposeInput?.dispose();
  disposeWebkitInputFallback?.();
  disposeWebkitInputFallback = undefined;
  disposeSelectionCopy?.dispose();
  disposeTerminalBell?.dispose();
  disposeTerminalBell = undefined;
  window.clearTimeout(terminalBellFlashTimer);
  terminalBellFlash.value = false;
  terminalWriteThrottle.dispose();
  // 终端重建/会话关闭：在途写入回调整体作废，保护态复位，避免旧积压误判。
  outputInFlightBytes = 0;
  outputGate.reset();
  detachHighlightRender();
  detachActionLinks();
  detachGutterListeners();
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
  <main class="workbench" :class="{ 'panel-surface': panelSurface }">
    <header class="toolbar" :style="toolbarStyle">
      <!-- 连接信息入口：Info 图标按钮紧跟标识区（状态徽章右侧），弹层左对齐锚定 -->
      <div class="identity-side">
        <div class="identity">
          <span v-if="connection.color" class="connection-color" :style="{ backgroundColor: connection.color }" />
          <strong>{{ connectionIdentity }}</strong>
          <span v-if="connection.readOnly || connectionReadOnly" class="read-only-badge">{{ t("readOnly") }}</span>
          <span class="session-pill" :class="`session-${sessionStatus}`"><span class="session-dot" aria-hidden="true" />{{ sessionPillText }}<span v-if="sessionStatus === 'reconnecting' && reconnectCountdown" class="session-pill-countdown mono">{{ t("sessionStatus.reconnectCountdown", { seconds: reconnectCountdown.seconds, attempt: reconnectCountdown.attempt }) }}</span></span>
        </div>
        <Popover :open="connectionInfoOpen" @update:open="(open) => { if (!open) connectionInfoOpen = false; }">
          <PopoverAnchor as-child>
            <button type="button" class="icon-button icon-neutral" :title="t('connectionInfo')" :aria-expanded="connectionInfoOpen" @click.stop="toggleConnectionInfo"><Info /></button>
          </PopoverAnchor>
          <PopoverContent class="popover connection-info-popover" align="start" :side-offset="5">
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
          </PopoverContent>
        </Popover>
      </div>
      <div class="toolbar-actions">
        <button class="icon-button icon-neutral" :title="paneOrder === 'terminal-left' ? t('moveSftpLeft') : t('moveTerminalLeft')" @click="togglePaneOrder"><ArrowLeftRight /></button>
        <!-- Local terminal UI hides SSH-only actions outright (not disabled): the local
             shell has no SSH session to act on. -->
        <button v-if="!localUiMode" class="icon-button icon-cyan" :class="{ 'is-active': sftpPaneOpen }" :title="sftpPaneOpen ? t('sftpPane.close') : t('sftpPane.open')" :aria-pressed="sftpPaneOpen" @click="toggleSftpPane"><FolderOpen v-if="!sftpPaneOpen" /><PanelRightClose v-else /></button>
        <button class="icon-button" :title="t('terminalFontDecrease')" @click="adjustTerminalZoom(-1)"><span class="font-step-label" aria-hidden="true">A−</span></button>
        <button class="icon-button" :title="t('terminalFontIncrease')" @click="adjustTerminalZoom(1)"><span class="font-step-label" aria-hidden="true">A+</span></button>
        <button v-if="!localUiMode" class="icon-button icon-emerald" :title="t('newSessionTab')" :disabled="!connectionId" @click="openNewSessionTab"><SquarePlus /></button>
        <button v-if="!localUiMode" class="icon-button icon-emerald" :title="t('copySessionTab')" :disabled="!connectionId || !connected" @click="openCopiedSessionTab"><Copy /></button>
        <!-- Telnet 明文会话入口（P2-3）：与 SSH/本地终端互斥，占用终态先经确认。 -->
        <button v-if="!localUiMode" class="icon-button icon-amber" :title="t('telnet.open')" @click="requestTelnet"><Globe /></button>
        <!-- VNC 远程桌面入口（nyaterm-parity P2 2d）：与其它会话互斥，占用先经确认。 -->
        <button v-if="!localUiMode" class="icon-button icon-cyan" :title="t('vnc.open')" @click="requestVnc"><MonitorPlay /></button>
        <!-- RDP 远程桌面入口（nyaterm-parity P3-4）：与其它会话互斥，占用先经确认。 -->
        <button v-if="!localUiMode" class="icon-button icon-emerald" :title="t('rdp.open')" @click="requestRdp"><MonitorUp /></button>
        <!-- 串口会话入口（P3）：与 SSH/本地/Telnet 互斥，占用终态先经确认。 -->
        <button v-if="!localUiMode" class="icon-button icon-neutral" :title="t('serial.open')" @click="requestSerial"><Usb /></button>
        <!-- 串口文件上传入口（NyaTerm 对齐 P0-3）：仅串口模式可用；传输中禁发。 -->
        <button v-if="isSerialMode" class="icon-button icon-emerald" :title="t('serial.upload.open')" :disabled="serialUploadBusy" @click="serialUploadDialogOpen = true"><FileUp /></button>
        <!-- 本地终端：sidecar 所在机器的登录 shell。与 SSH 会话互斥展示，
             已连接时经确认先关 SSH；退出态由终端覆盖层提供重开出口。 -->
        <button class="icon-button icon-violet" :class="{ 'is-active': localUiMode }" :title="isRdpMode ? t('rdp.disconnect') : isVncMode ? t('vnc.disconnect') : isSerialMode ? t('serial.disconnect') : isTelnetMode ? t('telnet.disconnect') : localUiMode && !localShellRestored ? t('localTerminal.close') : t('localTerminal.open')" @click="toggleLocalTerminal"><TerminalIcon /></button>
        <div v-if="!isTelnetMode && !isSerialMode && !isVncMode && !isRdpMode">
          <!-- 本地终端设置：多平台 shell 选择（local/shells/list 发现）+ 注入开关，
               记入 sidecar 偏好（iframe 沙箱无 localStorage）。 -->
          <Popover :open="localMenuOpen" @update:open="(open) => { if (!open) localMenuOpen = false; }">
            <PopoverAnchor as-child>
              <button class="icon-button icon-violet local-shell-chevron" :class="{ 'is-active': localMenuOpen }" :title="t('localTerminal.settings')" @click.stop="openLocalMenu"><ChevronDown /></button>
            </PopoverAnchor>
            <PopoverContent class="popover local-shell-popover" align="start" :side-offset="5">
              <h3>{{ t("localTerminal.settings") }}</h3>
              <p class="muted local-shell-hint">{{ t("localTerminal.settingsHint") }}</p>
              <div v-if="localShellsLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
              <template v-else-if="localShells.length">
                <label v-for="entry in localShells" :key="entry.program" class="agent-mode-option">
                  <input type="radio" name="local-shell" :checked="localShellPref ? localShellPref === entry.program : entry.isDefault" @change="setLocalShellPref(entry.program)" />
                  <span class="local-shell-row">
                    <strong>{{ entry.name }}</strong>
                    <span class="mono local-shell-program">{{ entry.program }}</span>
                    <span v-if="entry.isDefault" class="local-shell-badge">{{ t("localTerminal.defaultBadge") }}</span>
                    <span v-if="entry.isUserShell" class="local-shell-badge">{{ t("localTerminal.userShellBadge") }}</span>
                  </span>
                </label>
              </template>
              <p v-else class="muted local-shell-hint">{{ t("localTerminal.shellsUnavailable") }}</p>
              <label class="agent-mode-option" :title="selectedShellInjectable === false ? t('localTerminal.injectionUnavailable') : ''">
                <input type="checkbox" name="local-shell-integration" :checked="localShellIntegrationPref" :disabled="selectedShellInjectable === false" @change="setLocalShellIntegrationPref(($event.target as HTMLInputElement).checked)" />
                <span>{{ t("localTerminal.injection") }}</span>
              </label>
              <footer class="local-shell-footer">
                <!-- 本地模式中按钮保持可用：restart 语义（关当前 → 按新偏好重开）。
                     仅 starting 期间禁用防双击。 -->
                <button
                  v-if="canOpenLocalTab"
                  class="local-tab-button"
                  :title="t('localTerminal.openInNewTab')"
                  @click="openLocalTerminalTab"
                ><SquarePlus /></button>
                <Popover :open="localShellSurfaceOpen" @update:open="(open) => (localShellSurfaceOpen = open)">
                  <PopoverAnchor as-child>
                    <button
                      v-if="canOpenLocalTab"
                      class="local-tab-button"
                      :title="t('localTerminal.openShellSurface')"
                      @click="openLocalShellSurfaceMenu"
                    ><ListPlus /></button>
                  </PopoverAnchor>
                  <PopoverContent class="popover" align="end" :side-offset="5">
                    <button class="shell-surface-item" @click="openLocalShellSurface()">
                      <TerminalIcon class="h-3.5 w-3.5" />{{ t("localTerminal.autoShell") }}
                    </button>
                    <button v-for="entry in localShells" :key="entry.program" class="shell-surface-item" @click="openLocalShellSurface(entry.program)">
                      <TerminalIcon class="h-3.5 w-3.5" />{{ entry.name }}<span class="mono local-shell-program">{{ entry.program }}</span>
                    </button>
                    <template v-if="dockConnections.length">
                      <p class="shell-surface-header">{{ t("localTerminal.connectionTerminals") }}</p>
                      <button v-for="connection in dockConnections" :key="`conn-${connection.id}`" class="shell-surface-item" @click="openConnectionSurface(connection)">
                        <TerminalIcon class="h-3.5 w-3.5" />{{ connection.name }}
                      </button>
                    </template>
                  </PopoverContent>
                </Popover>
                <button class="primary-button" :disabled="localState === 'starting'" @click="localMenuOpen = false; localShellRestored || isLocalMode ? restartLocalTerminal() : requestLocalTerminal()">
                  {{ localUiMode ? t("localTerminal.restart") : t("localTerminal.open") }}
                </button>
              </footer>
            </PopoverContent>
          </Popover>
        </div>
        <button v-if="!localUiMode" class="icon-button icon-emerald" :title="t('reconnect')" :disabled="terminalState === 'connecting' && !reconnectPending" @click="reconnectNow"><PlugZap /></button>
        <!-- 一键 sudo -v：向当前 PTY 写入命令刷新 sudo 凭据缓存；quick sudo 自动应答
             是否启用由连接设置决定（设置弹窗），工作台不再提供开关。 -->
        <button v-if="!localUiMode" class="icon-button icon-emerald" :title="t('sudoRefresh.title')" :disabled="!connected" @click="sendSudoRefresh"><ShieldCheck /></button>
        <button v-if="!localUiMode" class="icon-button icon-emerald" :title="t('profilesTitle')" @click="openProfilesManager"><KeyRound /></button>
        <button v-if="!localUiMode" class="icon-button icon-cyan" :title="t('alertTriage.title')" @click="openAlertTriage"><Siren /></button>
        <!-- main 新增的端口转发入口同属 SSH 专属：沿用 A4 惯例在本地模式整体隐藏。 -->
        <button v-if="!localUiMode" class="icon-button icon-cyan" :title="t('forwards.title')" :disabled="!session" @click="forwardsOpen = true"><Network /></button>
        <label v-if="!localUiMode" class="follow-directory-control" :title="t('followTerminal')">
          <Switch size="sm" :model-value="followDirectory" :disabled="!connected" @update:model-value="setDirectoryTracking" />
          <span>{{ t("followTerminal") }}</span>
        </label>
        <span class="toolbar-separator" aria-hidden="true" />
        <button v-if="!localUiMode" class="icon-button icon-neutral" :title="t('commandTitle')" :disabled="!connected" @click="openCommandDialog"><SquareTerminal /></button>
        <button v-if="!localUiMode && !panelSurface" class="icon-button icon-neutral" :class="{ 'is-active': batchBarOpen }" :title="t('batchSendTitle')" :aria-pressed="batchBarOpen" :disabled="!connected" @click="toggleBatchBar"><ListChecks /></button>
        <div v-if="!localUiMode">
          <Popover :open="quickMenuOpen" @update:open="(open) => { if (!open) quickMenuOpen = false; }">
            <PopoverAnchor as-child>
              <button class="icon-button icon-amber" :title="t('quickCommands')" :disabled="!connected" @click.stop="toggleQuickMenu"><Zap /></button>
            </PopoverAnchor>
            <PopoverContent class="popover quick-commands-popover" align="end" :side-offset="5">
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
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <Popover :open="agentModeOpen" @update:open="(open) => { if (!open) agentModeOpen = false; }">
            <PopoverAnchor as-child>
              <button class="icon-button" :class="agentMode === 'off' ? 'icon-neutral' : 'icon-emerald is-active'" :title="t('agentTerminalQuickHint')" :aria-pressed="agentMode !== 'off'" :disabled="!connected" @click.stop="toggleAgentModeMenu"><Bot /></button>
            </PopoverAnchor>
            <PopoverContent class="popover agent-mode-popover" align="end" :side-offset="5">
            <h3>{{ t("agentTerminalSection") }}</h3>
            <label v-for="mode in AGENT_MODES" :key="mode" class="agent-mode-option">
              <input type="radio" name="agent-mode" :checked="agentMode === mode" :disabled="agentModeBusy" @change="applyAgentMode(mode)" />
              <span>{{ t(`agentTerminal${mode === "off" ? "Off" : mode === "auto" ? "Auto" : "Strict"}`) }}</span>
            </label>
            <p class="muted agent-mode-note">{{ agentModeHint }}</p>
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <Popover :open="highlightMenuOpen" @update:open="(open) => { if (!open) highlightMenuOpen = false; }">
            <PopoverAnchor as-child>
              <button class="icon-button icon-violet" :class="{ 'is-active': highlightMenuOpen }" :title="t('highlightRules.title')" :aria-pressed="highlightMenuOpen" @click.stop="toggleHighlightMenu"><Palette /></button>
            </PopoverAnchor>
            <PopoverContent class="popover highlight-rules-popover" align="end" :side-offset="5">
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
                <ToggleGroup v-model="highlightFlagValues" type="multiple" class="highlight-editor-flags">
                  <ToggleGroupItem value="regex" class="highlight-editor-flag-item" :title="t('highlightRules.regex')">.*</ToggleGroupItem>
                  <ToggleGroupItem value="case" class="highlight-editor-flag-item" :title="t('highlightRules.caseSensitive')">Aa</ToggleGroupItem>
                </ToggleGroup>
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
            </PopoverContent>
          </Popover>
        </div>
        <button class="icon-button icon-emerald" :class="{ 'is-active': metricsOpen }" :title="t('metrics')" :aria-pressed="metricsOpen" :disabled="!connected" @click="toggleMetrics"><Gauge /></button>
        <button class="icon-button" :class="{ 'is-recording': recordingActive }" :title="recordingActive ? t('recordingStop') : t('recordingTitle')" :disabled="!connected" @click="toggleRecording"><Disc /></button>
        <button class="icon-button" :class="{ 'is-active': recordingsOpen }" :title="t('recordingsTitle')" :aria-pressed="recordingsOpen" @click="toggleRecordings"><Film /></button>
        <button class="icon-button icon-violet" :title="t('settings')" :disabled="!connected" @click="openSettings"><Settings /></button>
        <button class="icon-button icon-amber" :title="t('auditLog.title')" @click="openAuditLog"><FileText /></button>
        <div>
          <Popover :open="columnsOpen" @update:open="(open) => { if (!open) columnsOpen = false; }">
            <PopoverAnchor as-child>
              <button class="icon-button icon-violet" :title="t('customizeColumns')" @click.stop="toggleColumnsMenu"><Columns3 /></button>
            </PopoverAnchor>
            <PopoverContent class="popover columns-popover" align="end" :side-offset="5">
            <label v-for="column in (['size', 'modified', 'owner', 'group', 'permissions'] as SftpColumn[])" :key="column"><input type="checkbox" :checked="visibleColumns.includes(column)" @change="toggleColumn(column)" />{{ t(column) }}</label>
            <hr class="columns-popover-separator" />
            <label :title="t('sftpPane.defaultOpenHint')"><input type="checkbox" :checked="sftpPaneDefaultOpen" @change="toggleSftpPaneDefaultOpen" />{{ t("sftpPane.defaultOpen") }}</label>
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <!-- 历史卡右键菜单（ContextMenu）打开时忽略弹层的外点关闭请求：
               菜单项 pointerdown 相对弹层是"外部"，不加守卫会在 select 前把宿主弹层
               连同菜单一起卸载，动作丢失。 -->
          <Popover :open="transferPanelOpen" @update:open="(open) => { if (!open && !transferHistoryMenu) transferPanelOpen = false; }">
            <PopoverAnchor as-child>
              <button class="icon-button icon-blue" :title="t('transfers')" @click.stop="toggleTransferPanel"><ArrowUpDown /><span v-if="activeTransfers" class="activity-dot" /></button>
            </PopoverAnchor>
            <PopoverContent class="popover transfer-popover" align="end" :side-offset="5">
            <h3>{{ t("transfers") }}</h3>
            <div v-if="!transferList.length" class="empty compact">{{ t("noTransfers") }}</div>
            <article v-for="task in transferList" :key="task.taskId" class="transfer-card">
              <div class="transfer-title"><FileUp v-if="task.direction === 'upload'" /><Download v-else /><span>{{ task.fileName || task.taskId }}</span><strong v-if="task.phase !== 'staging'">{{ transferPercent(task) }}%</strong></div>
              <progress :value="transferBarValue(task)" max="100" />
              <div class="transfer-meta"><span>{{ t(`transferStatus.${task.status}`) }}</span><span :title="transferBytesTitle(task)">{{ formatBytes(transferShownBytes(task)) }} / {{ formatBytes(task.size) }}</span><span v-if="transferSpeeds[task.taskId]">{{ formatBytes(transferSpeeds[task.taskId]) }}/s</span></div>
              <!-- 目录下载：在传文件相对路径，让长传输有可感知的推进。 -->
              <p v-if="task.currentFile" class="transfer-path mono" :title="task.currentFile">{{ task.currentFile }}</p>
              <p v-if="task.localPath" class="transfer-path mono" :title="task.localPath">{{ task.localPath }}</p>
              <!-- 目录下载部分失败的汇总由完成 toast 承担：failedCount 与终态
                   同拍赋值，终态卡随即转入历史区，活跃卡上的失败行永远渲染
                   不到（UI 回归确认），故不再放置死分支。 -->
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
                <button type="button" class="icon-button" :title="t('transfersHistory.clear')" :disabled="!transferHistory.length" @click.stop="transferHistoryClearOpen = true"><Trash2 /></button>
              </span>
            </div>
            <div v-if="transferHistoryFailed" class="empty compact">
              <span>{{ t("transfersHistory.loadFailed") }}</span>
              <button type="button" class="link-button" @click.stop="refreshTransferPanel">{{ t("refresh") }}</button>
            </div>
            <div v-else-if="transferHistoryLoading && !transferHistory.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
            <div v-else-if="!transferHistory.length" class="empty compact">{{ t("transfersHistory.empty") }}</div>
            <ContextMenu v-for="entry in transferHistory" :key="entry.taskId" :open="transferHistoryMenu?.taskId === entry.taskId" @update:open="(open) => { if (!open && transferHistoryMenu?.taskId === entry.taskId) transferHistoryMenu = undefined; }">
              <ContextMenuTrigger as-child>
                <article class="transfer-card transfer-history-card" @contextmenu="showTransferHistoryMenu($event, entry)">
                  <div class="transfer-title"><FileUp v-if="entry.direction === 'upload'" /><Download v-else /><span :title="entry.fileName">{{ entry.fileName || entry.taskId }}</span></div>
                  <div class="transfer-meta"><span>{{ t(`transferStatus.${entry.status}`) }}</span><span>{{ formatBytes(entry.size) }}</span></div>
                  <p v-if="entry.localPath" class="transfer-path mono" :title="entry.localPath">{{ entry.localPath }}</p>
                  <p v-if="entry.error" class="task-error">{{ entry.error }}</p>
                </article>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem @select="entry.localPath && revealTransferTarget(entry.localPath)"><FolderOpen />{{ t("revealInFolder") }}</ContextMenuItem>
                <ContextMenuItem @select="entry.localPath && openTransferTarget(entry.localPath)"><FileText />{{ t("openDownloadedFile") }}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>

    <div v-if="tooltip" ref="tooltipBubble" class="app-tooltip" :class="{ 'app-tooltip-above': tooltip.above }" :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px`, '--arrow-offset': `${tooltip.arrowOffset}px` }" role="tooltip">{{ tooltip.text }}</div>
    <ToastProvider :label="t('notification')">
      <ToastRoot v-if="notice" :key="noticeKey" :open="noticeOpen" :duration="noticeActions.length ? 8000 : 3500" class="notice" @update:open="onNoticeOpenChange">
        <span>{{ notice }}</span>
        <ToastAction v-for="action in noticeActions" :key="action.label" :alt-text="action.label" class="notice-action" @click="action.run()">{{ action.label }}</ToastAction>
      </ToastRoot>
      <ToastViewport class="notice-viewport" />
    </ToastProvider>
    <ToastProvider :label="t('notification')">
      <ToastRoot v-if="sftpError" :key="sftpErrorKey" :open="sftpErrorOpen" :duration="8000" class="error-banner" @update:open="onSftpErrorOpenChange">
        <span>{{ sftpError }}</span>
        <ToastAction v-if="sftpErrorRetry" :alt-text="t('retry')" class="notice-action" @click="sftpErrorRetry()">{{ t("retry") }}</ToastAction>
        <ToastClose :title="t('close')"><X /></ToastClose>
      </ToastRoot>
      <ToastViewport class="error-viewport" />
    </ToastProvider>

    <section ref="paneContainer" :class="orderedPaneClass">
      <ContextMenu :open="terminalMenuOpen" @update:open="(open) => { if (!open) terminalMenuOpen = false; }">
        <ContextMenuTrigger as-child>
      <section class="terminal-pane" :class="{ 'drag-active': terminalDragActive, 'batch-bar-open': connected && batchBarOpen, 'marker-visible': commandMarker.installed, 'gutter-visible': gutterPaneVisible, 'wallpaper-active': wallpaperActive }" :style="[terminalBasis, gutterPaneStyle]" @contextmenu="showTerminalMenu" @dragenter.prevent="onTerminalDragEnter" @dragover.prevent @dragleave.self="terminalDragActive = false" @drop.prevent="onTerminalDrop($event)">
        <!-- P2-9 背景图层：pointer-events:none 垫底（DOM 序先于 terminal-host），
             透明度 0.1-0.9 由设置页滑杆控制；开启期间强制 DOM 渲染器透出本层。 -->
        <div v-if="wallpaperActive" class="terminal-wallpaper" :style="{ backgroundImage: `url(${wallpaperDataUrl})`, opacity: wallpaperOpacity / 100 }" aria-hidden="true" />
        <!-- P1-3 行号/时间戳 gutter：绝对定位覆盖左缘 padding 环带（z-index 1，
             低于浮层 z-index 2），xterm 左 padding 随 --dbx-gutter-width 加宽，
             不遮文本；drop-overlay/搜索面板/诊断浮层定位不受影响。 -->
        <TerminalGutter v-if="gutterVisible" :rows="gutterRows" :width="gutterWidth" />
        <div ref="terminalHost" class="terminal-host" :class="{ 'bell-flash': terminalBellFlash }" @mousedown.middle="handleTerminalMiddleClick" />
        <!-- VNC 画布（nyaterm-parity P2 2d）：盖在 xterm 之上（z-index 2），
             帧从 vnc/frame/{id} 二进制通道进入；键盘/鼠标由画布采集后经
             keysym 映射发 vnc/input。连接态/退出覆盖层沿用 terminal-overlay。 -->
        <VncSurface v-if="isVncMode" ref="vncSurface" class="vnc-surface" :scale-mode="vncScaleMode" @input="sendVncInput" @clipboard-out="sendVncClipboard" />
        <!-- RDP 画布（nyaterm-parity P3-4）：盖在 xterm 之上（z-index 2），帧从
             rdp/frame/{id} 二进制通道进入（与 vnc/frame 同一 44 字节 patch 头）；
             键盘经扫描码映射、鼠标/滚轮原样映射发 rdp/input，服务端光标形状
             （rdp/pointer）落到画布 CSS cursor。连接态/退出覆盖层沿用
             terminal-overlay。 -->
        <RdpSurface v-if="isRdpMode" ref="rdpSurface" class="vnc-surface" :scale-mode="rdpScaleMode" @input="sendRdpInput" @clipboard-out="sendRdpClipboard" />
        <!-- P1-2 动作链接命令预览浮签：悬停 / Alt+点击时显示建议命令文本。 -->
        <div v-if="actionLinkHint" class="action-link-hint mono" :style="{ left: `${actionLinkHint.x}px`, top: `${actionLinkHint.y}px` }">{{ actionLinkHint.text }}</div>
        <!-- #33/#71 快速输入丢失诊断浮层：Ctrl/Cmd+Shift+D 切换。keys=onData
             路由到 PTY 的按键、sends=提交宿主桥的帧、acks=sidecar 确认的帧、
             errors=桥拒绝、swallowed=传输路由吞键。三者对不上即锁定丢失层。 -->
        <div v-if="terminalDiagVisible" class="terminal-diag-overlay" @dblclick="terminalDiagVisible = false">
          keys {{ terminalDiag.keys }} · sends {{ terminalDiag.sends }} · acks {{ terminalDiag.acks }} · errors {{ terminalDiag.errors }} · swallowed {{ terminalDiag.swallowed }}
        </div>
        <!-- 命令模糊建议浮层（P1-1）：锚点为光标像素坐标，读不到时贴终端底部；
             键盘（↑↓/Tab/Enter/Esc）由 handleTerminalKey 在浮层开启时优先消费。 -->
        <CommandSuggestions
          v-if="suggestionOpen && suggestionItems.length"
          :items="suggestionItems"
          :active-index="suggestionActiveIndex"
          :anchor="suggestionAnchor"
          :t="t"
          @activate="(index) => (suggestionActiveIndex = index)"
          @fill="fillSuggestion"
        />
        <!-- 结构化补全浮层（对标 Warp/fig，线 2）：spec 命中时优先展示，
             键盘（↑↓/Tab/Enter/Esc）由 handleCompletionKey 消费，点击即填充。 -->
        <CompletionMenu
          v-if="completionOpen && completionRows.length"
          :rows="completionRows"
          :level="completionLevel"
          :command-path="completionCommandPath"
          :active-index="completionActiveIndex"
          :anchor="completionAnchor"
          :t="t"
          @activate="(index) => (completionActiveIndex = index)"
          @accept="acceptCompletionRow"
        />
        <!-- 终端行内 ghost 自动建议（对标 Warp/fish）：灰色剩余文本盖在光标右侧，
             → 一次接受（handleTerminalKey 消费）。overlay DOM 而非 xterm
             decoration 的理由见 ghost 函数块注释。 -->
        <div
          v-if="ghostMatch && ghostAnchor"
          class="terminal-ghost mono"
          :style="{ left: `${ghostAnchor.x}px`, top: `${ghostAnchor.y}px` }"
          aria-hidden="true"
        >{{ ghostMatch.remainder }}</div>
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
        <!-- SSH 连接卡片：本地/串口/Telnet/VNC 会话占用的终端视图不再叠 SSH-only
             卡片（互斥展示）。Dock panel surface 不再显示瞬态连接遮罩（宿主
             预拨号、面板直出终端区域），但 FAILED/disconnected 是死路态——
             连接卡（错误文案 + 重连出口）在面板内同样要呈现，否则面板读作空白。 -->
        <div
          v-if="(!panelSurface || terminalState === 'error' || terminalState === 'disconnected') && !isLocalMode && !localShellRestored && !isSerialMode && !isTelnetMode && !isVncMode && terminalState !== 'connected' && !reconnectPending"
          class="terminal-overlay"
        >
          <ConnectingCard
            :locale="locale"
            :name="connection.name || connectionIdentity"
            :identity="connectionIdentity"
            :state="connectCardState"
            :status-text="inactiveWaiting ? t('connectCard.waitingReopen') : ''"
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
        <!-- 本地终端退出态覆盖层（含 A4 恢复外壳：restored tab 未起 shell 时
             也由它承担外壳态，spec §8.4）：显示退出码（sidecar 未上报时不显
             示），给重开与关闭两个出口（VS Code 式终端退出体验）。 -->
        <div v-if="(isLocalMode || localShellRestored) && localState === 'exited'" class="terminal-overlay">
          <div class="local-exit-card" role="status">
            <TerminalIcon class="local-exit-icon" />
            <strong>{{ t("localTerminal.exited") }}</strong>
            <span v-if="localExitCode !== null" class="mono local-exit-code">{{ t("localTerminal.exitCode", { code: localExitCode }) }}</span>
            <div class="local-exit-actions">
              <button class="primary-button" @click="restartLocalTerminal">{{ t("localTerminal.restart") }}</button>
              <button @click="localShellRestored ? dismissRestoredLocalShell() : closeLocalTerminal()">{{ t("localTerminal.close") }}</button>
            </div>
          </div>
        </div>
        <!-- Telnet 退出覆盖层（连接失败/对端断开）：给出关闭出口，展示
             sidecar 带回的原因文本（明文协议告警在连接弹窗里）。 -->
        <div v-if="isTelnetMode && telnetState === 'closed'" class="terminal-overlay">
          <div class="local-exit-card" role="status">
            <TriangleAlert class="local-exit-icon" />
            <strong>{{ t("telnet.closed") }}</strong>
            <span v-if="telnetError" class="mono local-exit-code">{{ telnetError }}</span>
            <div class="local-exit-actions">
              <button @click="closeTelnetSession">{{ t("telnet.close") }}</button>
            </div>
          </div>
        </div>
        <!-- 串口退出覆盖层（读线程 IO 失败/设备拔线）：给出关闭出口，展示原因。 -->
        <div v-if="isSerialMode && serialState === 'closed'" class="terminal-overlay">
          <div class="local-exit-card" role="status">
            <TriangleAlert class="local-exit-icon" />
            <strong>{{ t("serial.closed") }}</strong>
            <span v-if="serialError" class="mono local-exit-code">{{ serialError }}</span>
            <div class="local-exit-actions">
              <button @click="closeSerialSession">{{ t("serial.close") }}</button>
            </div>
          </div>
        </div>
        <!-- VNC 退出覆盖层（认证失败/服务端强制 Tight/对端断开）：给出关闭
             出口，展示 sidecar 带回的原因文本；明文/经典认证告警在连接弹窗。 -->
        <div v-if="isVncMode && vncState === 'closed'" class="terminal-overlay">
          <div class="local-exit-card" role="status">
            <TriangleAlert class="local-exit-icon" />
            <strong>{{ t("vnc.closed") }}</strong>
            <span v-if="vncError" class="mono local-exit-code">{{ vncError }}</span>
            <div class="local-exit-actions">
              <button @click="closeVncSession">{{ t("vnc.close") }}</button>
            </div>
          </div>
        </div>
        <!-- RDP 重连状态条（退避梯子进行中）：非阻塞展示进度，梯子跑完由
             closed 覆盖层接管（协议：证书/认证/协商失败永不自动重试）。 -->
        <div v-if="isRdpMode && rdpState.state === 'reconnecting'" class="zmodem-status" role="status">
          <Loader2 class="spinning" />
          <span>{{ rdpState.maxAttempts > 0 ? t("rdp.reconnectingAttempt", { attempt: rdpState.attempt, max: rdpState.maxAttempts }) : t("rdp.reconnecting") }}</span>
        </div>
        <!-- RDP 退出覆盖层（graceful close / 终态错误）：errorKind 友好文案为
             主行、sidecar 原因文本为细节行；给出 Reconnect（rdp/reconnect）与
             关闭双出口（协议：服务端主动断开不自动重连，由用户决定）。 -->
        <div v-if="isRdpMode && rdpState.state === 'closed'" class="terminal-overlay">
          <div class="local-exit-card" role="status">
            <TriangleAlert class="local-exit-icon" />
            <strong>{{ rdpClosedTitle }}</strong>
            <span v-if="rdpState.error" class="mono local-exit-code">{{ rdpState.error }}</span>
            <div class="local-exit-actions">
              <button class="primary-button" @click="reconnectRdpSession">{{ t("rdp.reconnect") }}</button>
              <button @click="closeRdpSession">{{ t("rdp.close") }}</button>
            </div>
          </div>
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
        <div v-if="agentRunning" class="agent-run-banner" role="status">
          <Loader2 class="spinning" />
          <span class="agent-run-text">{{ t("agentRunningBanner") }}</span>
          <code class="agent-run-command mono" :title="agentRunning.command">{{ agentRunning.command }}</code>
          <button class="agent-interrupt" @click="interruptAgentRun">{{ t("agentInterrupt") }}</button>
        </div>
        <div v-if="zmodemBusy" class="zmodem-status" role="status">
          <Loader2 class="spinning" />
          <span>{{ zmodemState === "waiting" ? t("zmodemWaiting") : t("zmodemUploading", { name: zmodemFileName, percent: zmodemPercent }) }}</span>
          <span v-if="zmodemSpeed">{{ formatBytes(zmodemSpeed) }}/s</span>
        </div>
        <div v-if="trzszOverlayVisible" class="zmodem-status trzsz-status" role="status" :class="{ 'trzsz-done': trzszPhase === 'success', 'trzsz-failed': trzszPhase === 'failed' }">
          <Loader2 v-if="trzszPhase === 'waiting' || trzszPhase === 'transferring'" class="spinning" />
          <TriangleAlert v-else-if="trzszPhase === 'failed'" />
          <span class="trzsz-label">{{ trzszStatusLabel }}</span>
          <progress v-if="trzszPhase === 'transferring'" :value="trzszPercent" max="100" />
          <span v-if="trzszPhase === 'transferring' && trzszFileCount > 1" class="trzsz-count mono">{{ trzszFileIndex }}/{{ trzszFileCount }}</span>
          <span v-if="trzszPhase === 'transferring' && trzszSpeed" class="trzsz-speed">{{ formatBytes(trzszSpeed) }}/s</span>
          <button v-if="trzszBusy" class="trzsz-cancel" :title="t('cancel')" @click="cancelTrzszTransfer"><X /></button>
        </div>
        <!-- 串口文件上传进度（NyaTerm 对齐 P0-3）：running 吞键入 + 可取消；
             complete/failed 保留展示，由用户点 × 收起。 -->
        <div v-if="serialUploadOverlayVisible" class="zmodem-status trzsz-status" role="status" :class="{ 'trzsz-done': serialUpload.phase === 'complete', 'trzsz-failed': serialUpload.phase === 'failed' }">
          <Loader2 v-if="serialUploadBusy" class="spinning" />
          <TriangleAlert v-else-if="serialUpload.phase === 'failed'" />
          <span class="trzsz-label">{{ serialUploadStatusLabel }}</span>
          <progress v-if="serialUploadBusy" :value="serialUploadPercentValue" max="100" />
          <span class="trzsz-count mono">{{ serialUpload.protocol.toUpperCase() }}</span>
          <button v-if="serialUploadBusy" class="trzsz-cancel" :title="t('cancel')" @click="cancelSerialUpload"><X /></button>
          <button v-else class="trzsz-cancel" :title="t('close')" @click="serialUpload = initialSerialUploadState()"><X /></button>
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
              <GpuNpuMonitor :locale="locale" :gpu="metrics.gpu" :npu="metrics.npu" />
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
              <Select :model-value="String(replaySpeed)" @update:model-value="(v) => (replaySpeed = Number(v))">
                <SelectTrigger size="xs" class="replay-speed" :title="t('replaySpeed')">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.5">0.5×</SelectItem>
                  <SelectItem value="1">1×</SelectItem>
                  <SelectItem value="2">2×</SelectItem>
                  <SelectItem value="4">4×</SelectItem>
                </SelectContent>
              </Select>
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
          <div>
            <!-- 底部条上的 popover 向上展开（reka side="top"，旧绝对定位会被裁切）。 -->
            <Popover :open="batchTargetsOpen" @update:open="(open) => { if (!open) batchTargetsOpen = false; }">
              <PopoverAnchor as-child>
                <button class="batch-bar-targets" :title="t('batchSendTitle')" @click.stop="toggleBatchTargetsPopover"><ListChecks /><span>{{ t("batchSendTargets", { count: batchSelected.length, total: batchTargets.length }) }}</span></button>
              </PopoverAnchor>
              <PopoverContent class="popover batch-targets-popover" side="top" align="start" :side-offset="6">
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
              </PopoverContent>
            </Popover>
          </div>
          <Select v-if="!batchSaveMode && quickCommands.length" :model-value="batchQuickPickId" @update:model-value="onBatchQuickPick">
            <SelectTrigger size="xs" class="batch-bar-quick" :title="t('batchSendQuickPick')">
              <SelectValue :placeholder="t('batchSendQuickPick')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="item in quickCommands" :key="item.id" :value="item.id">{{ item.name }}</SelectItem>
            </SelectContent>
          </Select>
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
        </ContextMenuTrigger>
        <!-- P2-8：Copy/Paste/Search online/Close 由 TerminalContextMenu 承载；
             插件自有菜单项经默认插槽保持在原有位置。 -->
        <TerminalContextMenu
          :open="terminalMenuOpen"
          :has-selection="terminal?.hasSelection() ?? false"
          :can-paste="connected && !terminalTransferBusy"
          :engines="ctxSearchEngines"
          :t="t"
          @copy="copyTerminalSelection"
          @paste="pasteTerminal"
          @search="searchSelectionOnline"
          @close="terminalMenuOpen = false"
        >
          <!-- 本地终端最近命令（VS Code Run Recent Command 简化版）：
               依赖 shell integration 注入的 633;E 命令行。 -->
          <template v-if="isLocalMode && localRecentCommands.length">
            <ContextMenuItem @select="rerunLocalCommand(localRecentCommands[0])"><History />{{ t("localTerminal.rerunLast") }}</ContextMenuItem>
            <ContextMenuItem v-for="(command, index) in localRecentCommands.slice(0, 5)" :key="index" @select="rerunLocalCommand(command)"><span class="mono local-rerun-command">{{ command }}</span></ContextMenuItem>
            <ContextMenuSeparator />
          </template>
          <ContextMenuItem @select="selectAllTerminal"><TextSelect />{{ t("terminalSelectAll") }}</ContextMenuItem>
          <ContextMenuItem @select="openTerminalSearch"><Search />{{ t("terminalSearch.open") }}</ContextMenuItem>
          <ContextMenuItem @select="clearTerminal"><Eraser />{{ t("terminalClear") }}</ContextMenuItem>
          <ContextMenuItem :disabled="!connected" @select="sendSudoRefresh"><ShieldCheck />{{ t("sudoRefresh.title") }}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem :disabled="!connected || terminalTransferBusy || !canWrite" @select="chooseZmodem"><FileUp />{{ t("zmodemUpload") }}</ContextMenuItem>
          <ContextMenuItem :disabled="!connected || terminalTransferBusy || !canWrite" @select="chooseTrzszUpload"><FileUp />{{ t("trzszUpload") }}</ContextMenuItem>
        </TerminalContextMenu>
      </ContextMenu>

      <div v-if="sftpPaneOpen" class="divider" @pointerdown="startDividerDrag" />

      <section v-if="sftpPaneOpen" ref="sftpPane" class="sftp-pane" tabindex="-1" :class="{ 'drag-active': dragActive }" @pointerdown="focusSftpPaneOnPointerDown" @paste.capture="onSftpClipboardPaste" @dragenter.prevent="onSftpDragEnter" @dragover.prevent @dragleave.self="dragActive = false" @drop.prevent="onDrop">
        <div class="path-toolbar">
          <button class="icon-button" :title="t('parentFolder')" :disabled="currentPath === '/'" @click="goParent"><ArrowUp /></button>
          <button class="icon-button icon-amber" :title="t('home')" :disabled="!connected" @click="loadHome"><Home /></button>
          <button class="icon-button icon-cyan" :title="t('refresh')" :disabled="!connected || loadingFiles" @click="loadDirectory()"><RefreshCw :class="{ spinning: loadingFiles }" /></button>
          <!-- #54 路径栏双态：非编辑态把当前路径渲染成可点击分段（末段为当前位置），
               点击分段直接回跳、点击分段外区域进入编辑；编辑态是原先的完整输入框，
               提交后回到分段展示。分段切分走 remotePathInput（有单测）。 -->
          <div class="path-bar">
            <input
              v-show="pathBarEditing"
              ref="pathBarInputEl"
              v-model="currentPath"
              spellcheck="false"
              @keydown.enter="submitPathInput"
              @keydown.esc="cancelPathBarEdit"
              @blur="pathBarEditing = false"
            />
            <nav v-show="!pathBarEditing" class="path-crumbs" tabindex="0" @click="beginPathBarEdit" @keydown.enter.self.prevent="beginPathBarEdit">
              <template v-for="(crumb, index) in pathCrumbs" :key="crumb.path">
                <span v-if="index" class="path-crumb-sep" aria-hidden="true">/</span>
                <button v-if="index < pathCrumbs.length - 1" class="path-crumb mono" :title="crumb.path" @click.stop="goToPath(crumb.path)">{{ crumb.name }}</button>
                <span v-else class="path-crumb current mono" :title="crumb.path" aria-current="location">{{ crumb.name }}</span>
              </template>
            </nav>
          </div>
          <div>
            <Popover :open="bookmarkSaveOpen" @update:open="(open) => { if (!open) bookmarkSaveOpen = false; }">
              <PopoverAnchor as-child>
                <button class="icon-button icon-amber" :title="t('sftpBookmark.add')" :disabled="!connected" @click.stop="toggleBookmarkSave"><Star /></button>
              </PopoverAnchor>
              <!-- 星标收藏弹层：label 默认取路径末段，可编辑后保存（前端先行校验 + 后端错误回显） -->
              <PopoverContent class="popover bookmark-save-popover" align="end" :side-offset="5">
              <strong class="path-history-title">{{ t("sftpBookmark.add") }}</strong>
              <span class="bookmark-save-path mono" :title="currentPath">{{ currentPath }}</span>
              <input v-model="bookmarkLabelDraft" class="bookmark-label-input mono" :maxlength="SFTP_BOOKMARK_LABEL_MAX_LENGTH" spellcheck="false" :placeholder="t('sftpBookmark.namePlaceholder')" :disabled="bookmarkSaving" autofocus @keydown.enter="confirmBookmarkSave" />
              <div class="bookmark-save-actions">
                <button class="icon-button icon-emerald" :title="t('save')" :disabled="bookmarkSaving" @click="confirmBookmarkSave"><Save /></button>
                <button class="icon-button" :title="t('cancel')" :disabled="bookmarkSaving" @click="bookmarkSaveOpen = false"><X /></button>
              </div>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <Popover :open="pathHistoryOpen" @update:open="(open) => { if (!open) pathHistoryOpen = false; }">
              <PopoverAnchor as-child>
                <button class="icon-button" :title="t('sftpPathHistory.title')" :disabled="!connected" @click.stop="togglePathHistoryMenu"><History /></button>
              </PopoverAnchor>
              <PopoverContent class="popover path-history-popover" align="end" :side-offset="5">
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
              </PopoverContent>
            </Popover>
          </div>
          <button class="icon-button" :title="t('sftpPaste.action')" :disabled="!connected || !canWrite || !sftpClipboard || pasteBusy" @click="pasteClipboard"><ClipboardPaste /></button>
          <button class="icon-button icon-teal" :title="`${t('upload')} · Ctrl/Cmd+V`" :disabled="!connected || !canWrite" @click.stop="chooseUpload"><FileUp /></button>
          <button class="icon-button icon-amber" :title="t('newFolder')" :disabled="!connected || !canWrite" @click="operationDraft = ''; operationDialog = 'mkdir'"><FolderPlus /></button>
          <button class="icon-button icon-amber" :title="t('sftpNewFile.action')" :disabled="!connected || !canWrite" @click="openNewFileDialog"><FilePlus /></button>
          <label class="follow-directory-control sudo-label" :title="!canWrite ? t('readOnly') : t('sudo.modeHint')">
            <Switch size="sm" :model-value="sudoMode" :disabled="!connected || !canWrite" @update:model-value="toggleSudoMode" />
            <span>{{ t("sudo.mode") }}</span>
          </label>
        </div>
        <!-- SFTP 面板主体：左侧 tree/quick 双 tab 侧栏（可收起）+ 右侧文件区 -->
        <div class="sftp-body">
          <ContextMenu :open="!!sideMenu" @update:open="(open) => { if (!open) sideMenu = undefined; }">
            <!-- display:contents 避免包装 span 参与 flex 布局；行右键经冒泡到达触发器。 -->
            <ContextMenuTrigger class="contents">
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
            </ContextMenuTrigger>
            <!-- 侧栏（目录树/快捷路径）行右键：打开 / 复制路径 / 复制文件名 / 压缩 -->
            <ContextMenuContent>
              <ContextMenuItem @select="sideMenuAction('open')"><Folder />{{ t("openFolder") }}</ContextMenuItem>
              <ContextMenuItem @select="sideMenuAction('copyPath')"><Copy />{{ t("sftpCopy.copyPath") }}</ContextMenuItem>
              <ContextMenuItem @select="sideMenuAction('copyName')"><FileText />{{ t("sftpCopy.copyName") }}</ContextMenuItem>
              <ContextMenuItem :disabled="!canWrite || archiveBusy" @select="sideMenuAction('archive')"><Archive />{{ t("archive.action") }}</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <div class="sftp-main">
          <div class="sftp-filter-bar">
            <label class="sftp-search-input">
              <Search />
              <input v-model="sftpSearch" type="search" :placeholder="t('sftpSearch.placeholder')" spellcheck="false" />
              <button v-if="sftpSearch" class="sftp-search-clear" :title="t('cancel')" @click.prevent="sftpSearch = ''"><X /></button>
            </label>
            <Select :model-value="sftpTypeFilter" @update:model-value="(v) => (sftpTypeFilter = v as SftpTypeFilter)">
              <SelectTrigger size="xs" class="sftp-type-filter" :title="t('sftpFilter.all')">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ t("sftpFilter.all") }}</SelectItem>
                <SelectItem value="directory">{{ t("sftpFilter.folders") }}</SelectItem>
                <SelectItem value="file">{{ t("sftpFilter.files") }}</SelectItem>
              </SelectContent>
            </Select>
            <button
              class="icon-button sftp-hidden-toggle"
              :class="{ 'is-active': sftpShowHidden }"
              :title="sftpShowHidden ? t('sftpFilter.hideHidden') : t('sftpFilter.showHidden')"
              :aria-pressed="sftpShowHidden"
              @click="sftpShowHidden = !sftpShowHidden"
            >
              <Eye v-if="sftpShowHidden" />
              <EyeOff v-else />
            </button>
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
            <!-- 行右键（文件操作）与空白处右键（新建/刷新）共用同一 ContextMenu 根：
                 行处理器 showFileMenu 先行设置负载，容器处理器按事件目标兜空白区；
                 定位/碰撞/Esc/外点关闭均由 reka 承担。 -->
            <ContextMenu :open="!!(fileMenu || blankMenu)" @update:open="(open) => { if (!open) { fileMenu = undefined; blankMenu = false; } }">
              <ContextMenuTrigger as-child>
            <div class="file-rows" @contextmenu="onFileAreaContextMenu">
              <div class="file-header" :style="sftpGridStyle">
                <button class="col-wrap" @click="toggleSort('name')">{{ t("name") }}<component :is="sortIcon('name')" /><span class="col-resizer" @pointerdown="(e) => onColResizeStart('name', e)" /></button>
                <button v-if="visibleColumns.includes('size')" class="col-wrap" @click="toggleSort('size')">{{ t("size") }}<component :is="sortIcon('size')" /><span class="col-resizer" @pointerdown="(e) => onColResizeStart('size', e)" /></button>
                <button v-if="visibleColumns.includes('modified')" class="col-wrap" @click="toggleSort('modified')">{{ t("modified") }}<component :is="sortIcon('modified')" /><span class="col-resizer" @pointerdown="(e) => onColResizeStart('modified', e)" /></button>
                <span v-if="visibleColumns.includes('owner')" class="col-wrap" :title="t('owner')">{{ t("owner") }}<span class="col-resizer" @pointerdown="(e) => onColResizeStart('owner', e)" /></span>
                <span v-if="visibleColumns.includes('group')" class="col-wrap" :title="t('group')">{{ t("group") }}<span class="col-resizer" @pointerdown="(e) => onColResizeStart('group', e)" /></span>
                <span v-if="visibleColumns.includes('permissions')" class="col-wrap">{{ t("permissions") }}<span class="col-resizer" @pointerdown="(e) => onColResizeStart('permissions', e)" /></span>
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
                  <!-- issue #36：图标只认 sftpEntryIconKind —— 仅 directory 出文件夹，
                       other/未知一律文件图标，symlink 保持链接文档。 -->
                  <Folder v-if="sftpEntryIconKind(entry.kind) === 'folder'" class="folder-icon" />
                  <FileIcon v-else-if="sftpEntryIconKind(entry.kind) === 'file'" />
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
                  <span v-else :title="linkTargetTitle(entry)">{{ entry.name }}</span>
                </span>
                <span v-if="visibleColumns.includes('size')" class="numeric">{{ entry.kind === "file" ? formatBytes(entry.size) : "" }}</span>
                <span v-if="visibleColumns.includes('modified')">{{ formatModified(entry.modifiedAt) }}</span>
                <span v-if="visibleColumns.includes('owner')" class="mono" :title="entry.owner">{{ entry.owner || "-" }}</span>
                <span v-if="visibleColumns.includes('group')" class="mono" :title="entry.group">{{ entry.group || "-" }}</span>
                <span v-if="visibleColumns.includes('permissions')" class="mono">{{ entry.permissions }}</span>
              </button>
              <div v-if="!loadingFiles && !visibleEntries.length" class="empty">{{ entries.length ? t("sftpSearch.noMatch") : t("emptyFolder") }}</div>
            </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <!-- 多选感知：右键时已多选（selection > 1）→ 菜单整体切换为批量区，单项动作隐藏 -->
                <template v-if="fileMenu && fileMenu.selection.length > 1">
                  <ContextMenuItem @select="batchDownload"><Download />{{ t("download") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!canWrite || archiveBusy || batchDeleteSubmitting" @select="batchArchive()"><Archive />{{ t("sftpBatch.archive") }}</ContextMenuItem>
                  <ContextMenuItem variant="destructive" :disabled="!canWrite || archiveBusy || batchDeleteSubmitting" @select="batchDeleteOpen = true"><Trash2 />{{ t("sftpBatch.delete") }}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="copySelectedPaths"><Copy />{{ t("sftpCopy.copySelected") }}</ContextMenuItem>
                </template>
                <template v-else-if="fileMenu">
                  <ContextMenuItem v-if="fileMenu.entry.kind === 'directory' || fileMenu.entry.kind === 'file'" @select="openEntry(fileMenu.entry)"><Folder v-if="fileMenu.entry.kind === 'directory'" /><FileText v-else />{{ fileMenu.entry.kind === "directory" ? t("openFolder") : t("preview") }}</ContextMenuItem>
                  <ContextMenuItem v-if="fileMenu.entry.kind === 'file' || fileMenu.entry.kind === 'directory'" @select="downloadEntry(fileMenu.entry)"><Download />{{ t("download") }}</ContextMenuItem>
                  <!-- 外部编辑器回传（P2-5，桌面端）：web/docker 的 sidecar 不在本机，
                       监听与回传都不可用，localCanSave 未探测到前也保持禁用。 -->
                  <ContextMenuItem v-if="fileMenu.entry.kind === 'file'" :disabled="!canWrite || !localCanSave || externalEditBusy" @select="openInExternalEditor(fileMenu.entry)"><ExternalLink />{{ t("sftpEdit.openExternal") }}</ContextMenuItem>
                  <!-- 符号链接改指向（P2-6）：读取现有 target 预填后 update。 -->
                  <ContextMenuItem v-if="fileMenu.entry.kind === 'symlink'" :disabled="!canWrite" @select="beginSymlinkEdit(fileMenu.entry)"><Link2 />{{ t("symlink.editAction") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!canWrite" @select="beginRename(fileMenu.entry)"><Pencil />{{ t("rename") }}</ContextMenuItem>
                  <ContextMenuItem @select="copySelectedEntries('copy')"><Copy />{{ t("sftpCopy.copy") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!canWrite" @select="copySelectedEntries('cut')"><Scissors />{{ t("sftpCopy.cut") }}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="copyTextToClipboard(pathFromUri(fileMenu.entry.uri), 'sftpCopy.copiedPath')"><Copy />{{ t("sftpCopy.copyPath") }}</ContextMenuItem>
                  <ContextMenuItem @select="copyTextToClipboard(fileMenu.entry.name, 'sftpCopy.copiedName')"><FileText />{{ t("sftpCopy.copyName") }}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem :disabled="!canWrite" @select="beginChmod(fileMenu.entry)"><Lock />{{ t("permissionsEdit") }}</ContextMenuItem>
                  <ContextMenuItem @select="openAttributes(fileMenu.entry)"><Info />{{ t("sftpAttrs.action") }}</ContextMenuItem>
                  <ContextMenuItem v-if="fileMenu.entry.kind === 'directory' || (fileMenu.entry.kind === 'file' && !isArchiveName(fileMenu.entry.name))" :disabled="!canWrite || archiveBusy" @select="archiveEntry(fileMenu.entry)"><Archive />{{ t("archive.action") }}</ContextMenuItem>
                  <ContextMenuItem v-if="fileMenu.entry.kind === 'file' && isArchiveName(fileMenu.entry.name)" :disabled="!canWrite || archiveBusy" @select="extractEntry(fileMenu.entry)"><PackageOpen />{{ t("extract.action") }}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" :disabled="!canWrite" @select="deleteTarget = fileMenu.entry"><Trash2 />{{ t("delete") }}</ContextMenuItem>
                </template>
                <!-- 文件列表空白处右键：新建文件夹 / 新建文件 / 上传文件 / 刷新 -->
                <template v-else>
                  <ContextMenuItem :disabled="!canWrite" @select="blankMenuAction('mkdir')"><FolderPlus />{{ t("newFolder") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!canWrite" @select="blankMenuAction('newFile')"><FilePlus />{{ t("sftpNewFile.action") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!canWrite" @select="blankMenuAction('symlink')"><Link2 />{{ t("symlink.createAction") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!connected || !canWrite" @select="blankMenuAction('upload')"><FileUp />{{ t("upload") }}</ContextMenuItem>
                  <ContextMenuItem :disabled="!connected || loadingFiles" @select="blankMenuAction('refresh')"><RefreshCw />{{ t("refresh") }}</ContextMenuItem>
                </template>
              </ContextMenuContent>
            </ContextMenu>
            <footer class="file-footer"><span>{{ sftpFiltersActive ? t("sftpSearch.footerMatch", { matched: visibleEntries.length, total: entries.length }) : t("items", { count: entries.length }) }}</span><span v-if="diskUsage" :title="`${diskUsage.filesystem} → ${diskUsage.mount}`">{{ formatBytes(diskUsage.availableBytes) }} {{ t("diskFreeOf", { total: formatBytes(diskUsage.totalBytes) }) }}</span><span>{{ currentPath }}</span></footer>
          </div>
          </div>
        </div>
        <div v-if="dragActive" class="drop-overlay"><FileUp /><strong>{{ t("upload") }}</strong></div>
      </section>
    </section>

    <!-- 弹层统一迁移 reka Dialog（Strategy B）：portal/遮罩/焦点陷阱/外点关闭由 reka
         承担；Esc 仍由 onDocumentKeydown 分层链独占（内容上一律 @escape-key-down.prevent），
         外点关闭经 update:open(false) 路由到各弹窗的语义取消函数。 -->
    <Dialog :open="previewOpen" @update:open="(open) => { if (!open) closePreview(); }">
      <DialogContent class="modal preview-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>
            {{ previewTitle }}
            <span v-if="previewDirty" class="preview-dirty"><span class="preview-dirty-dot" />{{ t("editSave.unsaved") }}</span>
            <span v-else-if="previewTruncated" class="preview-truncated-badge">{{ t("previewDialog.truncated", { limit: formatBytes(MAX_INLINE_PREVIEW_BYTES), size: formatBytes(previewSize) }) }}</span>
          </DialogTitle>
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
      </DialogContent>
    </Dialog>

    <!-- 端口映射管理（-L/-R）：列表/添加/停止与 ssh/forward/state 订阅都在
         PortForwardDialog 内；会话断开由 sidecar 清理全部映射。 -->
    <PortForwardDialog
      :locale="locale"
      :open="forwardsOpen"
      :connection-id="connectionId"
      :session-id="session?.sessionId ?? null"
      @update:open="forwardsOpen = $event"
      @error="showError($event, 'terminal')"
    />

    <Dialog :open="operationDialog === 'mkdir'" @update:open="(open) => { if (!open) operationDialog = null; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("newFolder") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="operationDialog = null"><X /></button></header>
        <input v-model="operationDraft" autofocus @keydown.enter="createDirectory" />
        <footer><button @click="operationDialog = null">{{ t("cancel") }}</button><button class="primary-button" :disabled="!operationDraft.trim()" @click="createDirectory">{{ t("confirm") }}</button></footer>      </DialogContent>
    </Dialog>

    <!-- 符号链接新建/改指向（P2-6）：target 允许相对路径（symlink 语义），
         编辑模式预填当前指向；改指向后端 readlink 比对做 no-op 兜底。 -->
    <Dialog :open="symlinkDialog !== null" @update:open="(open) => { if (!open) symlinkDialog = null; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="symlinkDialog">
        <header><DialogTitle>{{ symlinkDialog.mode === "edit" ? t("symlink.editTitle", { name: symlinkDialog.name }) : t("symlink.createTitle") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="symlinkDialog = null"><X /></button></header>
        <p v-if="symlinkDialog.mode === 'edit'" class="muted mono">{{ symlinkDialog.linkPath }}</p>
        <input v-if="symlinkDialog.mode === 'create'" v-model="symlinkDraft" autofocus :placeholder="t('symlink.namePlaceholder')" @keydown.enter="commitSymlink" />
        <input v-if="symlinkDialog.mode === 'create'" v-model="symlinkTargetDraft" class="mono" spellcheck="false" :placeholder="t('symlink.targetPlaceholder')" @keydown.enter="commitSymlink" />
        <input v-else v-model="symlinkDraft" class="mono" spellcheck="false" autofocus :placeholder="t('symlink.targetPlaceholder')" @keydown.enter="commitSymlink" />
        <p class="muted">{{ t("symlink.hint") }}</p>
        <footer><button @click="symlinkDialog = null">{{ t("cancel") }}</button><button class="primary-button" :disabled="(symlinkDialog.mode === 'create' ? !symlinkDraft.trim() || !symlinkTargetDraft.trim() : !symlinkDraft.trim()) || symlinkSubmitting" @click="commitSymlink"><Loader2 v-if="symlinkSubmitting" class="spinning" />{{ t("confirm") }}</button></footer>
        </template>
      </DialogContent>
    </Dialog>

    <!-- 外部编辑器保存回传确认（P2-5）：上传一次 / 总是上传（记住 watchId）/ 取消。 -->
    <Dialog :open="watchModifiedPrompt !== null" @update:open="(open) => { if (!open) dismissWatchModified(); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("sftpEdit.modifiedTitle") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="dismissWatchModified"><X /></button></header>
        <p class="sftp-dialog-hint">{{ t("sftpEdit.modifiedMessage", { name: watchModifiedPrompt?.name || "" }) }}</p>
        <footer>
          <button @click="dismissWatchModified">{{ t("cancel") }}</button>
          <button :disabled="externalEditBusy" @click="uploadWatchedFileAlways">{{ t("sftpEdit.alwaysUpload") }}</button>
          <button class="primary-button" :disabled="externalEditBusy" @click="uploadWatchedFile(watchModifiedPrompt?.watchId || '')"><Loader2 v-if="externalEditBusy" class="spinning" />{{ t("sftpEdit.uploadOnce") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

    <Dialog :open="commandOpen" @update:open="(open) => { if (!open) commandOpen = false; }">
      <DialogContent class="modal command-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("commandTitle") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="commandOpen = false"><X /></button></header>
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
          <Switch v-model="commandUseSudo" size="sm" :disabled="commandRunning" />
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
      </DialogContent>
    </Dialog>

    <Dialog :open="!!chmodTarget" @update:open="(open) => { if (!open) chmodTarget = undefined; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="chmodTarget">
        <header><DialogTitle>{{ t("permissionsEdit") }} · {{ chmodTarget.name }}</DialogTitle><button :title="t('close')" class="icon-button" @click="chmodTarget = undefined"><X /></button></header>
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
        </template>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteTarget" @update:open="(open) => { if (!open) deleteTarget = undefined; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="deleteTarget">
        <header><DialogTitle>{{ t("deleteTitle") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="deleteTarget = undefined"><X /></button></header>
        <div class="destructive-copy"><div><strong>{{ deleteTarget.name }}</strong><p class="muted">{{ t("deleteMessage") }}</p></div></div>
        <footer><button @click="deleteTarget = undefined">{{ t("cancel") }}</button><button class="danger-button" :disabled="deleteSubmitting" @click="confirmDelete"><Trash2 />{{ t("delete") }}</button></footer>
        </template>
      </DialogContent>
    </Dialog>

    <Dialog :open="batchDeleteOpen" @update:open="(open) => { if (!open) batchDeleteOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("sftpBatch.deleteTitle") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="batchDeleteOpen = false"><X /></button></header>
        <div class="destructive-copy"><div><strong>{{ t("sftpBatch.selected", { count: selectedEntries.length }) }}</strong><p class="muted">{{ t("sftpBatch.deleteMessage") }}</p></div></div>
        <div v-if="batchProgress" class="batch-progress-row"><progress class="batch-progress-bar" :value="batchProgressPercent(batchProgress)" max="100" /><span class="batch-progress mono">{{ t("sftpBatch.progress", { done: batchProgress.done, total: batchProgress.total }) }}</span></div>
        <footer><button @click="batchDeleteOpen = false" :disabled="batchDeleteSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="batchDeleteSubmitting" @click="confirmBatchDelete"><Loader2 v-if="batchDeleteSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
      </DialogContent>
    </Dialog>

    <!-- 录制删除确认：应用内弹窗替代 window.confirm（宿主沙箱 iframe 无 allow-modals，confirm 恒 false） -->
    <!-- 下载/导出前的保存目录选择（设置里开启「每次询问」时出现） -->
    <Dialog :open="!!downloadPrompt" @update:open="(open) => { if (!open) resolveDownloadPrompt(undefined); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="downloadPrompt">
        <header><DialogTitle>{{ t("downloadSettings.askTitle") }}</DialogTitle><button class="icon-button" :title="t('close')" @click="resolveDownloadPrompt(undefined)"><X /></button></header>
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
        </template>
      </DialogContent>
    </Dialog>

    <!-- 「询问我」冲突策略：目标目录已有同名文件时的选择 -->
    <Dialog :open="!!downloadConflictPrompt" @update:open="(open) => { if (!open) resolveDownloadConflict(undefined); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="downloadConflictPrompt">
        <header><DialogTitle>{{ t("downloadConflict.title") }}</DialogTitle><button class="icon-button" :title="t('close')" @click="resolveDownloadConflict(undefined)"><X /></button></header>
        <p>{{ t("downloadConflict.message", { name: downloadConflictPrompt.fileName }) }}</p>
        <p class="muted mono">{{ downloadConflictPrompt.path }}</p>
        <footer>
          <button @click="resolveDownloadConflict(undefined)">{{ t("cancel") }}</button>
          <button class="danger-button" @click="resolveDownloadConflict('overwrite')">{{ t("downloadSettings.conflict.overwrite") }}</button>
          <button class="primary-button" @click="resolveDownloadConflict('rename')">{{ t("downloadSettings.conflict.rename") }}</button>
        </footer>
        </template>
      </DialogContent>
    </Dialog>

    <!-- 上传重复目标「询问我」（P1-5）：重命名 / 覆盖 / 取消，支持应用到本批次 -->
    <Dialog :open="!!uploadDuplicatePrompt" @update:open="(open) => { if (!open) resolveUploadDuplicate(undefined); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="uploadDuplicatePrompt">
        <header><DialogTitle>{{ t("transferCfg.duplicateTitle") }}</DialogTitle><button class="icon-button" :title="t('close')" @click="resolveUploadDuplicate(undefined)"><X /></button></header>
        <p>{{ t("transferCfg.duplicateMessage", { name: uploadDuplicatePrompt.fileName }) }}</p>
        <p class="muted mono">{{ uploadDuplicatePrompt.path }}</p>
        <label class="settings-field settings-switch-row">
          <input v-model="uploadDuplicateApplyAll" type="checkbox" />
          <span>{{ t("transferCfg.applyAll") }}</span>
        </label>
        <footer>
          <button @click="resolveUploadDuplicate(undefined)">{{ t("cancel") }}</button>
          <button class="danger-button" @click="resolveUploadDuplicate('overwrite')">{{ t("transferCfg.policy.overwrite") }}</button>
          <button class="primary-button" @click="resolveUploadDuplicate('rename')">{{ t("transferCfg.policy.rename") }}</button>
        </footer>
        </template>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!recordingDeleteTarget" @update:open="(open) => { if (!open) recordingDeleteTarget = null; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="recordingDeleteTarget">
        <header><DialogTitle>{{ t("recordingDelete") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="recordingDeleteTarget = null"><X /></button></header>
        <div class="destructive-copy"><div><strong>{{ t("recordingDeleteConfirm", { host: recordingDeleteTarget.host || recordingDeleteTarget.recordingId }) }}</strong><p class="muted">{{ formatRecordedAt(recordingDeleteTarget.startedAt) }} · {{ formatDuration(recordingDeleteTarget.durationSecs ?? 0) }}</p></div></div>
        <footer><button @click="recordingDeleteTarget = null" :disabled="recordingDeleteSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="recordingDeleteSubmitting" @click="confirmRecordingDelete"><Loader2 v-if="recordingDeleteSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
        </template>
      </DialogContent>
    </Dialog>

    <!-- 录制一键清空确认：应用内弹窗（沙箱 iframe confirm 恒 false） -->
    <Dialog :open="recordingClearAllOpen" @update:open="(open) => { if (!open) recordingClearAllOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("recordingsClear") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="recordingClearAllOpen = false"><X /></button></header>
        <div class="destructive-copy"><div><strong>{{ t("recordingsClearConfirm", { count: recordings.length }) }}</strong></div></div>
        <footer><button @click="recordingClearAllOpen = false" :disabled="recordingClearAllSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="recordingClearAllSubmitting" @click="confirmRecordingClearAll"><Loader2 v-if="recordingClearAllSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
      </DialogContent>
    </Dialog>

    <!-- 传输历史清空确认：应用内弹窗（沙箱 iframe confirm 恒 false） -->
    <Dialog :open="transferHistoryClearOpen" @update:open="(open) => { if (!open) transferHistoryClearOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("transfersHistory.clear") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="transferHistoryClearOpen = false"><X /></button></header>
        <div class="destructive-copy"><div><strong>{{ t("transfersHistory.clearConfirm") }}</strong></div></div>
        <footer><button @click="transferHistoryClearOpen = false">{{ t("cancel") }}</button><button class="danger-button" @click="confirmTransferHistoryClear"><Trash2 />{{ t("delete") }}</button></footer>
      </DialogContent>
    </Dialog>

    <Dialog :open="newFileDialog" @update:open="(open) => { if (!open) newFileDialog = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("sftpNewFile.title") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="newFileDialog = false"><X /></button></header>
        <input v-model="newFileDraft" autofocus spellcheck="false" :placeholder="t('sftpNewFile.placeholder')" @keydown.enter="createNewFile" />
        <footer><button @click="newFileDialog = false">{{ t("cancel") }}</button><button class="primary-button" :disabled="!newFileDraft.trim() || newFileSubmitting" @click="createNewFile"><Loader2 v-if="newFileSubmitting" class="spinning" />{{ t("confirm") }}</button></footer>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!attrsTarget" @update:open="(open) => { if (!open) closeAttributes(); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="attrsTarget">
        <header><DialogTitle>{{ t("sftpAttrs.title") }} · {{ attrsTarget.name }}</DialogTitle><button :title="t('close')" class="icon-button" @click="closeAttributes"><X /></button></header>
        <div v-if="attrsLoading" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
        <template v-else-if="attrsInfo">
          <dl class="attrs-grid">
            <dt>{{ t("sftpAttrs.path") }}</dt><dd class="mono">{{ attrsInfo.path }}</dd>
            <dt>{{ t("sftpAttrs.type") }}</dt><dd>{{ t(`sftpAttrs.kind.${attrsInfo.kind}`) }}</dd>
            <dt>{{ t("size") }}</dt><dd class="numeric">{{ attrsInfo.kind === "directory" ? "–" : formatBytes(attrsInfo.size || 0) }}</dd>
            <dt>{{ t("sftpAttrs.permissions") }}</dt><dd class="mono">{{ attrsInfo.mode || "–" }}</dd>
            <dt>{{ t("sftpAttrs.owner") }}</dt><dd>{{ attrsOwnerDisplay }}</dd>
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
        </template>
      </DialogContent>
    </Dialog>

    <!-- 设置弹窗 + quick sudo 配置档管理弹窗：独立组件（设置域 UI/状态集中处；Esc 链与终端偏好仍留在 App）。 -->
    <SettingsDialog
      ref="settingsDialog"
      v-model:open="settingsOpen"
      v-model:profilesOpen="profilesOpen"
      :session-id="session?.sessionId"
      :connection-id="session?.connectionId"
      :terminal-font-size="terminalFontSize"
      :host-font-size="appearance.terminal.fontSize"
      :host-font-family="hostTerminalFontFamily(appearance)"
      :local-download-dir="localDownloadDir"
      :local-can-save="localCanSave"
      :webgl-enabled="webglEnabled"
      :terminal-behavior="terminalBehavior"
      :terminal-hotkeys="terminalHotkeys"
      :apple-platform="applePlatform"
      :action-links="actionLinksSettings"
      :gutter="gutterSettings"
      :ctx-search-engines="ctxSearchEnginesText"
      :wallpaper-enabled="wallpaperEnabled"
      :wallpaper-opacity="wallpaperOpacity"
      :wallpaper-session-only="wallpaperSessionOnly"
      :appearance="terminalAppearanceState"
      :custom-themes="terminalAppearance.customThemes"
      :active-theme-id="activeAppearanceThemeId"
      :host-theme="hostTerminalTheme()"
      :host-color-scheme="appearance.colorScheme"
      :download-prefs="downloadPrefsAdapter"
      :transfer-prefs="transferPrefsAdapter"
      :suggestion-prefs="suggestionPrefsAdapter"
      :t="t"
      @notice="showNotice"
      @error="showError"
      @browse-download-dir="folderPickerTarget = 'settings'"
      @update:webgl="setWebglEnabled"
      @update-behavior="updateTerminalBehavior"
      @update-hotkeys="updateTerminalHotkeys"
      @update:action-links="updateActionLinksSettings"
      @update:gutter="updateGutterSettings"
      @update:ctx-search-engines="updateCtxSearchEngines"
      @update:ghost-suggest="setGhostEnabled"
      @update:wallpaper-enabled="updateWallpaperEnabled"
      @update:wallpaper-opacity="updateWallpaperOpacity"
      @set-wallpaper-image="setWallpaperImage"
      @clear-wallpaper="clearWallpaperImage"
      @apply-font="(payload) => applyTerminalFontSettings(payload.family, payload.size)"
      @update-appearance="updateTerminalAppearance"
      @apply-theme="applyTerminalAppearanceTheme"
      @save-theme="saveTerminalAppearanceTheme"
      @delete-theme="deleteTerminalAppearanceTheme"
      @add-schemes="addImportedSchemes"
      @remove-scheme="removeImportedScheme"
    />

    <Dialog :open="auditOpen" @update:open="(open) => { if (!open) auditOpen = false; }">
      <DialogContent class="modal audit-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("auditLog.title") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="auditOpen = false"><X /></button></header>
        <div class="settings-body">
          <div class="audit-toolbar">
            <Select :model-value="auditKindFilter || SELECT_EMPTY_SENTINEL" @update:model-value="(v) => (auditKindFilter = v === SELECT_EMPTY_SENTINEL ? '' : String(v))">
              <SelectTrigger size="xs" class="audit-kind-select" :aria-label="t('auditLog.kindFilter')">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="SELECT_EMPTY_SENTINEL">{{ t("auditLog.kindAll") }}</SelectItem>
                <SelectItem v-for="kind in auditKindOptions(auditEntries)" :key="kind" :value="kind">{{ auditKindLabel(kind, t) }}</SelectItem>
              </SelectContent>
            </Select>
            <div class="audit-actions">
              <button class="icon-button" :title="t('refresh')" :disabled="auditLoading" @click="loadAuditEntries"><RefreshCw :class="{ spinning: auditLoading }" /></button>
              <button class="icon-button" :title="t('auditLog.clear')" :disabled="!auditEntries.length" @click="auditClearOpen = true"><Trash2 /></button>
            </div>
          </div>
          <div v-if="auditLoading && !auditEntries.length" class="empty compact audit-empty"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <div v-else-if="auditLoadFailed" class="empty compact audit-empty">
            <span>{{ t("auditLog.loadFailed") }}</span>
            <button class="link-button" @click="loadAuditEntries">{{ t("refresh") }}</button>
          </div>
          <div v-else-if="!visibleAuditEntries.length" class="audit-empty"><FileText /><span>{{ t("auditLog.empty") }}</span></div>
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
      </DialogContent>
    </Dialog>

    <!-- 审计日志清空确认：应用内弹窗（沙箱 iframe confirm 恒 false） -->
    <Dialog :open="auditClearOpen" @update:open="(open) => { if (!open) auditClearOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("auditLog.clear") }}</DialogTitle><button :title="t('close')" class="icon-button" @click="auditClearOpen = false"><X /></button></header>
        <div class="destructive-copy"><div><strong>{{ t("auditLog.clearConfirm") }}</strong></div></div>
        <footer><button @click="auditClearOpen = false" :disabled="auditClearSubmitting">{{ t("cancel") }}</button><button class="danger-button" :disabled="auditClearSubmitting" @click="confirmAuditClear"><Loader2 v-if="auditClearSubmitting" class="spinning" /><Trash2 v-else />{{ t("delete") }}</button></footer>
      </DialogContent>
    </Dialog>
    <!-- 安全弹窗：不允许 Esc / 点击遮罩关闭，必须显式信任或拒绝（不在 Esc 链中） -->
    <Dialog :open="!!hostKeyPrompt">
      <DialogContent class="modal host-key-modal" @escape-key-down.prevent @pointer-down-outside.prevent>
        <template v-if="hostKeyPrompt">
        <header><DialogTitle>{{ t("hostKeyDialog.title") }}</DialogTitle></header>
        <p>{{ t("hostKeyDialog.desc") }}</p>
        <dl><dt>{{ t("hostKeyDialog.server") }}</dt><dd>{{ hostKeyPrompt.host }}:{{ hostKeyPrompt.port }}</dd><dt>{{ t("hostKeyDialog.keyType") }}</dt><dd>{{ hostKeyPrompt.keyType }}</dd><dt>{{ t("hostKeyDialog.fingerprint") }}</dt><dd class="fingerprint">{{ hostKeyPrompt.fingerprint }}</dd></dl>
        <label class="remember"><input v-model="rememberHostKey" type="checkbox" /> {{ t("hostKeyDialog.remember") }}</label>
        <footer><button @click="resolveHostKey(false)">{{ t("hostKeyDialog.reject") }}</button><button class="primary-button" @click="resolveHostKey(true)">{{ t("hostKeyDialog.trust") }}</button></footer>
        </template>
      </DialogContent>
    </Dialog>

    <!-- RDP 证书确认（rdp-certificate challenge）：安全弹窗，不允许 Esc / 点击
         遮罩关闭；SHA256 指纹 + knownHostStatus 徽标 + 120s 倒计时 + remember，
         超时 fail-closed（应答与 sidecar 超时同样按拒绝处理）。 -->
    <Dialog :open="!!rdpCertPrompt">
      <DialogContent class="modal host-key-modal" @escape-key-down.prevent @pointer-down-outside.prevent>
        <template v-if="rdpCertPrompt">
        <header><DialogTitle>{{ t("rdp.cert.title") }}</DialogTitle></header>
        <p>{{ t("rdp.cert.desc") }}</p>
        <dl>
          <dt>{{ t("rdp.cert.server") }}</dt><dd>{{ rdpCertPrompt.host }}:{{ rdpCertPrompt.port }}</dd>
          <dt>{{ t("rdp.cert.fingerprint") }}</dt><dd class="fingerprint">{{ rdpCertPrompt.fingerprint }}</dd>
        </dl>
        <p class="muted rdp-cert-status">{{ t(`rdp.cert.status.${rdpCertStatusKey(rdpCertPrompt.knownHostStatus)}`) }}</p>
        <label class="remember"><input v-model="rdpCertRemember" type="checkbox" /> {{ t("rdp.cert.remember") }}</label>
        <p class="muted rdp-cert-expires">{{ t("rdp.cert.expires", { seconds: rdpCertRemaining }) }}</p>
        <footer><button @click="resolveRdpCertificate(false)">{{ t("rdp.cert.reject") }}</button><button class="primary-button" @click="resolveRdpCertificate(true)">{{ t("rdp.cert.accept") }}</button></footer>
        </template>
      </DialogContent>
    </Dialog>

    <!-- 安全弹窗：不允许 Esc / 点击遮罩关闭，必须显式批准或拒绝（不在 Esc 链中） -->
    <Dialog :open="!!agentPromptHead">
      <DialogContent class="modal" @escape-key-down.prevent @pointer-down-outside.prevent>
        <template v-if="agentPromptHead">
        <header><DialogTitle>{{ agentPromptHead.source === "mcp" ? t("agentPrompt.mcpSource", { tool: agentPromptHead.tool }) : t("agentPromptTitle") }}</DialogTitle></header>
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
        </template>
      </DialogContent>
    </Dialog>

    <!-- 告警排查：异构告警 → 结构化 + 分类 + 只读诊断命令清单 -->
    <Dialog :open="alertTriageOpen" @update:open="(open) => { if (!open) alertTriageOpen = false; }">
      <DialogContent class="modal alert-triage-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>{{ t("alertTriage.title") }}</DialogTitle>
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
      </DialogContent>
    </Dialog>

    <Dialog :open="!!pasteConfirm" @update:open="(open) => { if (!open) resolvePasteConfirm(false); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="pasteConfirm">
        <header>
          <DialogTitle>{{ pasteConfirm.danger ? t("terminalDanger.title") : t("terminalPasteConfirm.title") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="resolvePasteConfirm(false)"><X /></button>
        </header>
        <div v-if="pasteConfirm.danger" class="destructive-copy warning">
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
        </template>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!dropUploadPrompt" @update:open="(open) => { if (!open) resolveDropUpload('cancel'); }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <template v-if="dropUploadPrompt">
        <header>
          <DialogTitle>{{ t("terminalDropPrompt.title") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="resolveDropUpload('cancel')"><X /></button>
        </header>
        <p class="muted">{{ t("terminalDropPrompt.summary", { count: dropUploadPrompt.files.length }) }}</p>
        <pre class="command-output mono drop-file-list">{{ dropUploadPrompt.files.map((file) => file.name).join("\n") }}</pre>
        <label class="drop-option">
          <input v-model="dropUploadTarget" type="radio" name="drop-upload-target" value="cwd" />
          <span>{{ t("terminalDropPrompt.toCurrent") }}</span>
          <code class="mono">{{ dropCwdTarget }}</code>
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
        </template>
      </DialogContent>
    </Dialog>

    <!-- 目录选择器：DOM 末尾渲染，保证叠在设置弹窗/下载询问弹窗之上。
         不传 initialPath：默认从「此电脑」盘符页开始（macOS/Linux 无盘符概念，
         回退到默认下载目录），与 kimi-code-desktop 的选择器行为对齐。 -->
    <FolderPickerDialog
      v-if="folderPickerTarget"
      :locale="locale"
      @select="onFolderPicked"
      @close="folderPickerTarget = null"
    />

    <!-- Telnet 连接表单（P2-3）：host/port/回退格/回车 + Expect 自动应答。 -->
    <TelnetConnectDialog :locale="locale" :open="telnetDialogOpen" @update:open="(open) => (telnetDialogOpen = open)" @connect="startTelnetSession" />

    <!-- 串口连接表单（P3）：端口发现/波特率/数据位/校验/停止位/退格。 -->
    <SerialConnectDialog :locale="locale" :open="serialDialogOpen" @update:open="(open) => (serialDialogOpen = open)" @connect="startSerialSession" />
    <SerialUploadDialog :locale="locale" :open="serialUploadDialogOpen" :busy="serialUploadBusy" @update:open="(open) => (serialUploadDialogOpen = open)" @start="startSerialUpload" />

    <VncConnectDialog :locale="locale" :open="vncDialogOpen" @update:open="(open) => (vncDialogOpen = open)" @connect="startVncSession" />

    <!-- RDP 连接表单（P3-4）：host/port/NLA 凭据/分辨率/证书策略。 -->
    <RdpConnectDialog :locale="locale" :open="rdpDialogOpen" @update:open="(open) => (rdpDialogOpen = open)" @connect="startRdpSession" />

    <!-- RDP 确认：SSH/本地/Telnet/串口/VNC 会话仍占用终端视图时先关闭再弹连接表单 -->
    <Dialog :open="rdpConfirmOpen" @update:open="(open) => { if (!open) rdpConfirmOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>{{ t("rdp.openConfirmTitle") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="rdpConfirmOpen = false"><X /></button>
        </header>
        <p class="muted">{{ t("rdp.openConfirm") }}</p>
        <footer>
          <button @click="rdpConfirmOpen = false">{{ t("cancel") }}</button>
          <button class="primary-button" @click="confirmRdpOpen">{{ t("rdp.open") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

    <!-- VNC 确认：SSH/本地/Telnet/串口会话仍占用终端视图时先关闭再弹连接表单 -->
    <Dialog :open="vncConfirmOpen" @update:open="(open) => { if (!open) vncConfirmOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>{{ t("vnc.openConfirmTitle") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="vncConfirmOpen = false"><X /></button>
        </header>
        <p class="muted">{{ t("vnc.openConfirm") }}</p>
        <footer>
          <button @click="vncConfirmOpen = false">{{ t("cancel") }}</button>
          <button class="primary-button" @click="confirmVncOpen">{{ t("vnc.open") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

    <!-- Telnet 确认：SSH 会话仍连着（或本地终端占用）时先关闭再弹连接表单 -->
    <Dialog :open="telnetConfirmOpen" @update:open="(open) => { if (!open) telnetConfirmOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>{{ t("telnet.openConfirmTitle") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="telnetConfirmOpen = false"><X /></button>
        </header>
        <p class="muted">{{ t("telnet.openConfirm") }}</p>
        <footer>
          <button @click="telnetConfirmOpen = false">{{ t("cancel") }}</button>
          <button class="primary-button" @click="confirmTelnetOpen">{{ t("telnet.open") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

    <!-- 串口确认：SSH/本地/Telnet 会话仍占用终端视图时先关闭再弹连接表单 -->
    <Dialog :open="serialConfirmOpen" @update:open="(open) => { if (!open) serialConfirmOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>{{ t("serial.openConfirmTitle") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="serialConfirmOpen = false"><X /></button>
        </header>
        <p class="muted">{{ t("serial.openConfirm") }}</p>
        <footer>
          <button @click="serialConfirmOpen = false">{{ t("cancel") }}</button>
          <button class="primary-button" @click="confirmSerialOpen">{{ t("serial.open") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

    <!-- 本地终端确认：SSH 会话仍连着时先关闭再进入本地模式 -->
    <Dialog :open="localOpenConfirmOpen" @update:open="(open) => { if (!open) localOpenConfirmOpen = false; }">
      <DialogContent class="modal small-modal" @escape-key-down.prevent>
        <header>
          <DialogTitle>{{ t("localTerminal.openConfirmTitle") }}</DialogTitle>
          <button :title="t('close')" class="icon-button" @click="localOpenConfirmOpen = false"><X /></button>
        </header>
        <p class="muted">{{ t("localTerminal.openConfirm") }}</p>
        <footer>
          <button @click="localOpenConfirmOpen = false">{{ t("cancel") }}</button>
          <button class="primary-button" @click="confirmLocalTerminal">{{ t("localTerminal.open") }}</button>
        </footer>
      </DialogContent>
    </Dialog>

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
.sftp-type-filter { flex: 0 0 auto; }
.sftp-hidden-toggle { flex: 0 0 auto; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); background: transparent; color: var(--muted-foreground); cursor: pointer; padding: 0; display: inline-grid; place-items: center; }
.sftp-hidden-toggle:hover { background: var(--accent); color: var(--foreground); }
.sftp-hidden-toggle.is-active { color: var(--primary); border-color: color-mix(in srgb, var(--primary) 55%, var(--border)); }
.sftp-hidden-toggle svg { width: 14px; height: 14px; }
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
/* 弹层根规则移到 style.css 全局：portal 后内容根不带本组件 scopeId。 */
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
/* 星标收藏弹层：路径预览 + 可编辑 label + 保存/取消（根规则见 style.css 全局） */
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

/* 快速命令栏（工具栏下拉）：发送 / 编辑 / 删除 + 底部新增编辑器（根规则见 style.css 全局） */
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

/* 连接信息面板（工具栏下拉，只读；根规则见 style.css 全局） */
.connection-info-popover h3 { margin: 4px 0 8px; font-size: 12px; }
.connection-info-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 12px; }
.connection-info-grid dt { max-width: 16ch; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis; white-space: nowrap; }
.connection-info-grid dd { display: flex; min-width: 0; align-items: center; gap: 8px; margin: 0; overflow-wrap: anywhere; }
.connection-info-grid .task-error { font-size: 10px; }
.connection-info-grid .link-button { flex: 0 0 auto; align-self: center; font-size: 10px; }

/* 终端 MCP 模式快速开关（工具栏弹出层，与设置弹窗共用三档文案；根规则见 style.css 全局） */
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
/* 录制记录列表：shadcn 式行布局——行间距归零，行间仅一条 45% 淡化的发丝线，
   行 hover 出 accent 圆角背景。旧卡片每条 border-top + body gap 会叠出
   "每行上下各一条线"的双线观感，此处整体替换。 */
.recordings-float .metrics-float-body { gap: 0; padding: 4px 6px; }
.recording-card { display: flex; align-items: center; gap: 8px; border-radius: var(--radius); padding: 7px 8px; }
.recording-card + .recording-card { border-top: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.recording-card:hover { background: var(--accent); }
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
/* 控制行控件对齐：播放钮 24px / 倍速 26px（SelectTrigger xs）/ 导出按钮走次级按钮规范。 */
.replay-controls .link-button { display: inline-flex; height: 24px; align-items: center; align-self: center; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 11px; }
.replay-controls .link-button:hover:not(:disabled) { background: var(--accent); }
.replay-speed { flex: 0 0 auto; width: 76px; }
.replay-time { min-width: 110px; text-align: right; font-size: 12px; color: var(--muted-foreground); }
/* 终端拖入上传落点询问：文件清单限高滚动，路径行对齐 radio 观感。 */
.drop-file-list { max-height: 132px; margin: 0; overflow: auto; white-space: pre; }
.drop-option { display: flex; align-items: center; gap: 7px; margin: 2px 0; font-size: 12px; cursor: pointer; }
.drop-option input { accent-color: var(--primary); }
.drop-option code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); font-size: 11px; }
.drop-path-input { width: 100%; height: 26px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.drop-path-input:focus { outline: none; border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); }
.drop-path-input:disabled { opacity: .5; }

/* —— SFTP 列宽拖拽 —— */
.file-header { position: relative; }
.file-header .col-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding-right: 6px; /* 给 resizer 留位置 */
}
.file-header .col-wrap > *:not(.col-resizer) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-resizer {
  position: absolute;
  right: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  background: transparent;
  z-index: 2;
}
.col-resizer::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 25%;
  bottom: 25%;
  width: 1px;
  background: transparent;
  transition: background-color .15s ease;
  transform: translateX(-50%);
}
.col-resizer:hover::after,
.col-resizer:active::after,
.file-header.resizing .col-resizer::after {
  background: var(--primary);
}
/* 拖拽过程中全局光标 */
body.resizing-col { cursor: col-resize !important; user-select: none; }

/* —— P1-3 行号/时间戳 gutter 的布局联动 ——
   gutter 组件自身样式在 TerminalGutter.vue；这里只做两件事：
   1) gutter 可见时把 xterm 左 padding 加宽 --dbx-gutter-width（FitAddon 读
      element padding 算列数，列宽随之自动收窄，文本不会滑进 gutter 环带）；
   2) 命令预览浮签（悬停 / Alt+点击动作链接时出现），z-index 高于终端宿主
      （z 0）与 gutter（z 1），低于浮层梯队（z 2+）。 */
.terminal-pane.gutter-visible .terminal-host :deep(.xterm) {
  padding-left: calc(var(--dbx-gutter-width, 0px) + var(--ssh-terminal-padding-left, 10px));
}
/* —— P2-9 背景图（对标 NyaTerm，MVP 简化）——
   图层垫底（DOM 序先于 terminal-host，pointer-events 关）；开启期间 pane/
   宿主/xterm 表面底色透明化（color-mix 保留一层底色防纯黑/纯白刺眼），
   !important 压过 xterm 6.x 内联在 .xterm-scrollable-element 的主题背景。
   开启期间渲染器强制回退 DOM（rendererWebglEffective），否则 WebGL 画布
   不透明会盖死本层。 */
.terminal-wallpaper {
  position: absolute;
  z-index: 0;
  inset: 0;
  pointer-events: none;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.terminal-pane.wallpaper-active { background: color-mix(in srgb, var(--ssh-terminal-background) 55%, transparent); }
.terminal-pane.wallpaper-active .terminal-host { background: transparent; }
.terminal-pane.wallpaper-active .terminal-host :deep(.xterm),
.terminal-pane.wallpaper-active .terminal-host :deep(.xterm .xterm-viewport),
.terminal-pane.wallpaper-active .terminal-host :deep(.xterm .xterm-scrollable-element),
.terminal-pane.wallpaper-active .terminal-host :deep(.xterm .xterm-screen),
.terminal-pane.wallpaper-active .terminal-host :deep(.xterm .xterm-rows) { background: transparent !important; }
.action-link-hint {
  position: absolute;
  z-index: 3;
  max-width: 300px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--popover);
  color: var(--foreground);
  font-size: 11px;
  white-space: pre;
  text-overflow: ellipsis;
  box-shadow: var(--shadow-sm, 0 1px 3px rgb(0 0 0 / 0.25));
  pointer-events: none;
}
/* 终端行内 ghost 自动建议（对标 Warp/fish）：灰字盖在光标格上，无交互
   （pointer-events:none），不参与选区/搜索。终端主题色在 xterm 内部渲染，
   CSS 拿不到，故用全局次级前景色 + 低透明度近似 fish 的 dim 灰。 */
.terminal-ghost {
  position: absolute;
  z-index: 3;
  max-width: calc(100% - 16px);
  overflow: hidden;
  white-space: pre;
  line-height: 1;
  color: var(--muted-foreground);
  opacity: 0.55;
  pointer-events: none;
}
/* RDP 证书确认弹窗：状态徽标 + 倒计时行（弹窗骨架复用 host-key-modal 的
   .remember/.fingerprint 全局类）。 */
.rdp-cert-status { margin: 0 0 8px; font-size: 11px; }
.rdp-cert-expires { margin: 0 0 8px; font-size: 11px; }
</style>
