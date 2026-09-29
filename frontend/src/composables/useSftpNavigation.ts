import { computed, nextTick, ref, type Ref } from "vue";
import type { SftpEntryKind, SftpColumn } from "../lib/sftpEntries";
import { createRequestEpoch } from "../lib/requestEpoch";
import { sanitizeSftpEntries } from "../lib/sftpEntries";
import { shouldOfferSudoRetryAfterFollowFailure } from "../lib/sftpErrors";
import { resolveRemotePath, splitRemotePathSegments } from "../lib/remotePathInput";

// 列表条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type ListingEntry = { uri: string; name: string; kind: SftpEntryKind };

/** SFTP 目录导航：loadDirectory 枢纽（epoch 竞态防护、sudo 跟随降级引导、
 * 选中/历史/用量联动刷新）、sudo 开关、路径栏跳转、主目录探测与目录跟随
 * 开关。选中/剪贴板/搜索/列布局等面板子域另行收口；目录树与路径历史的
 * 状态在 useSftpSidebar/useSftpPathHistory，经依赖注入衔接。 */
export function useSftpNavigation(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string, actions?: Array<{ label: string; run: () => void }>) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  sudoMode: Ref<boolean>;
  connected: Ref<boolean>;
  canWrite: Ref<boolean>;
  currentPath: Ref<string>;
  entries: Ref<ListingEntry[]>;
  loadingFiles: Ref<boolean>;
  sftpError: Ref<string>;
  sftpErrorOpen: Ref<boolean>;
  sftpErrorKey: Ref<number>;
  sftpHomePath: Ref<string>;
  visibleColumns: Ref<SftpColumn[]>;
  followDirectory: Ref<boolean>;
  directoryParser: { reset(): void };
  selectedPath: Ref<string>;
  directoryTrackingSupported: Ref<boolean | undefined>;
  clearRowSelection: () => void;
  parentPath: (path: string) => string;
  normalizeRemotePath: (path: string) => string;
  getPendingTerminalInput: () => string;
  persistState: () => void;
  refreshDiskUsage: () => Promise<void> | void;
  persistDirectoryFollowPref: (value: boolean) => void;
  resetLinkTargets: () => void;
  hydrateLinkTargets: (list: { uri: string; name: string; kind: SftpEntryKind }[]) => void;
  rememberPathHistory: (path: string) => void;
  closePathHistoryMenu: () => void;
}) {
  const { t, showNotice, showError, session, sudoMode, connected, canWrite, currentPath, entries, loadingFiles, sftpError, sftpErrorOpen, sftpErrorKey, sftpHomePath, visibleColumns, followDirectory, directoryParser, selectedPath, directoryTrackingSupported, clearRowSelection, parentPath, normalizeRemotePath, getPendingTerminalInput, persistState, refreshDiskUsage, persistDirectoryFollowPref, resetLinkTargets, hydrateLinkTargets, rememberPathHistory, closePathHistoryMenu } = options;

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

const listEpoch = createRequestEpoch();

async function loadDirectory(path = currentPath.value, fromTerminal = false) {
  if (!session.value) return;
  const normalized = normalizeRemotePath(path);
  const epochId = listEpoch.next();
  loadingFiles.value = true;
  if (!fromTerminal) { sftpError.value = ""; sftpErrorOpen.value = false; }
  try {
    const result = await window.dbxPlugin.invoke<{ entries: ListingEntry[] }>(sudoMode.value ? "sudo/listDir" : "sftp/list", {
      sessionId: session.value.sessionId,
      path: normalized,
      // 属主/属组列开启时才要 owner/group 数据（sudo/listDir 恒定附带）。
      includeOwner: visibleColumns.value.includes("owner") || visibleColumns.value.includes("group"),
    });
    if (!listEpoch.isCurrent(epochId)) return;
    // R3-P2-3：响应容错——非数组/畸形行走 sanitize（null entries → 空数组、
    // 缺 kind 的行降级为 file），单行坏数据不再让列表僵死或抛 pageerror。
    entries.value = sanitizeSftpEntries(result.entries);
    resetLinkTargets();
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
    if (fromTerminal) {
      // 跟随撞上登录用户权限墙（典型：终端 sudo su 后跟到 /root）：引导切
      // sudo 模式并重试，而非裸失败提示。重试走手动导航语义——再失败落
      // SFTP 错误横幅，不再循环弹引导。
      if (shouldOfferSudoRetryAfterFollowFailure({ fromTerminal, sudoMode: sudoMode.value, canWrite: canWrite.value, message })) {
        const target = normalized;
        showNotice(t("followDirectorySudoHint", { path: normalized }), [
          { label: t("followDirectorySudoRetry"), run: () => void enableSudoModeAndReload(target) },
        ]);
      } else {
        showNotice(t("followDirectoryFailed", { path: normalized, error: message }));
      }
    }
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

// 目录跟随权限引导的动作：切到 sudo 模式并重载目标目录（守卫与手动开关一致）。
async function enableSudoModeAndReload(path: string) {
  if (!connected.value || !canWrite.value || loadingFiles.value) return;
  sudoMode.value = true;
  persistState();
  await loadDirectory(path);
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
  if (getPendingTerminalInput()) {
    showNotice(t("followDirectoryInputPending"));
    return;
  }
  try {
    await window.dbxPlugin.invoke("ssh/terminal/directoryTracking", { sessionId: session.value.sessionId, enabled });
    followDirectory.value = enabled;
    persistDirectoryFollowPref(enabled);
    directoryParser.reset();
    persistState();
  } catch (cause) {
    showError(cause, "terminal");
  }
}

function goToPath(path: string) {
  closePathHistoryMenu();
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

  return {
    loadHome,
    refreshSftpHomePath,
    loadDirectory,
    toggleSudoMode,
    enableSudoModeAndReload,
    goParent,
    setDirectoryTracking,
    goToPath,
    pathBarEditing,
    pathBarInputEl,
    pathBarDraft,
    pathCrumbs,
    beginPathBarEdit,
    cancelPathBarEdit,
    submitPathInput,
  };
}
