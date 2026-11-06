import { computed, nextTick, ref, type Ref } from "vue";
import type { SftpEntryKind, SftpColumn } from "../lib/sftpEntries";
import { createRequestEpoch } from "../lib/requestEpoch";
import { sanitizeSftpEntries } from "../lib/sftpEntries";
import { shouldOfferSudoRetryAfterFollowFailure } from "../lib/sftpErrors";
import { resolveRemotePath, splitRemotePathSegments } from "../lib/remotePathInput";

// 列表条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type ListingEntry = { uri: string; name: string; kind: SftpEntryKind };

/** #209 面板内软错误态：目录跟随/连接后自动首拉失败时的安静提示
 *  （不弹全局横幅），由 sftp-pane 内的软提示条渲染；action 的 run 自含
 *  「先清软态再重载」语义，重试一律走手动导航（再失败才落全局横幅）。 */
export type SftpSoftError = {
  path: string;
  message: string;
  /** 原始错误串：只进悬停 tooltip，不做大字展示。 */
  detail: string;
  action: { label: string; run: () => void };
};

/** SFTP 目录导航：loadDirectory 枢纽（epoch 竞态防护、sudo 跟随降级引导、
 * #209 跟随/自动首拉失败的安静软提示、选中/历史/用量联动刷新）、sudo 开关、
 * 路径栏跳转、主目录探测与目录跟随开关。选中/剪贴板/搜索/列布局等面板子域
 * 另行收口；目录树与路径历史的状态在 useSftpSidebar/useSftpPathHistory，
 * 经依赖注入衔接。 */
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
  hydrateLinkTargets: (list: { uri: string; name: string; kind: SftpEntryKind }[], isCurrent: () => boolean) => void;
  rememberPathHistory: (path: string) => void;
  closePathHistoryMenu: () => void;
  /** 首次列目录成功的回调：App 侧据此置"本会话已加载"标记（#179 惰性连接判定）。 */
  onListingLoaded?: () => void;
  /** 路径栏提交的是文件而非目录时（issue #268）：App 侧以双击同款入口打开预览。 */
  openPathBarFile?: (path: string) => void;
}) {
  const { t, showNotice, showError, session, sudoMode, connected, canWrite, currentPath, entries, loadingFiles, sftpError, sftpErrorOpen, sftpErrorKey, sftpHomePath, visibleColumns, followDirectory, directoryParser, selectedPath, directoryTrackingSupported, clearRowSelection, parentPath, normalizeRemotePath, getPendingTerminalInput, persistState, refreshDiskUsage, persistDirectoryFollowPref, resetLinkTargets, hydrateLinkTargets, rememberPathHistory, closePathHistoryMenu, onListingLoaded, openPathBarFile } = options;

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

// #209 安静失败态（跟随/自动首拉失败落这里，不出全局横幅；App.vue 渲染）。
const sftpSoftError = ref<SftpSoftError | null>(null);

async function loadDirectory(path = currentPath.value, fromTerminal = false, quiet = false): Promise<void> {
  await loadDirectoryStatus(path, fromTerminal, quiet);
}

// issue #268：带结果版本——true=成功，false=本次请求失败，undefined=无会话/
// 被新请求顶替（stale）。仅 submitPathInput 的文件兜底使用；对外仍暴露 void
// 版本，避免波及其他把 loadDirectory 当 Promise<void> 注入的调用方。
async function loadDirectoryStatus(path = currentPath.value, fromTerminal = false, quiet = false): Promise<boolean | undefined> {
  if (!session.value) return;
  const normalized = normalizeRemotePath(path);
  const epochId = listEpoch.next();
  loadingFiles.value = true;
  if (!fromTerminal) { sftpError.value = ""; sftpErrorOpen.value = false; }
  if (fromTerminal || quiet) sftpSoftError.value = null;
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
    onListingLoaded?.();
    resetLinkTargets();
    void hydrateLinkTargets(entries.value, () => listEpoch.isCurrent(epochId));
    currentPath.value = normalized;
    selectedPath.value = "";
    clearRowSelection();
    rememberPathHistory(normalized);
    persistState();
    void refreshDiskUsage();
    sftpSoftError.value = null;
    // issue #268：submitPathInput 的文件兜底需要区分成功/失败/被新请求顶替
    // （stale 返回 undefined，不触发兜底）。
    return true;
  } catch (cause) {
    if (!listEpoch.isCurrent(epochId)) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (fromTerminal || quiet) {
      // #209 跟随触发/连接后自动首拉：失败只落面板内软提示条，不再弹全局
      // 错误横幅。典型场景：终端停在堡垒机会话列表，跟随用的目标机路径在
      // 堡垒机自身 fs 上不存在——全局横幅（8s 自动消失）徒增噪音。跟随时撞
      // 登录用户权限墙（终端 sudo su 后跟到 /root）仍在软条内给出切 sudo
      // 引导；普通重试按手动导航语义执行，再失败才落全局横幅。
      const target = normalized;
      if (shouldOfferSudoRetryAfterFollowFailure({ fromTerminal, sudoMode: sudoMode.value, canWrite: canWrite.value, message })) {
        sftpSoftError.value = {
          path: target,
          message: t("followDirectorySudoHint", { path: target }),
          detail: message,
          action: {
            label: t("followDirectorySudoRetry"),
            run: () => { sftpSoftError.value = null; void enableSudoModeAndReload(target); },
          },
        };
      } else {
        sftpSoftError.value = {
          path: target,
          message: t("sftpSoftError.loadFailed", { path: target }),
          detail: message,
          action: {
            label: t("retry"),
            run: () => { sftpSoftError.value = null; void loadDirectory(target); },
          },
        };
      }
    }
    else { sftpError.value = message; sftpErrorKey.value += 1; sftpErrorOpen.value = true; }
    return false;
  } finally {
    if (listEpoch.isCurrent(epochId)) loadingFiles.value = false;
  }
}

function toggleSudoMode() {
  if (!connected.value || !canWrite.value) return;
  // 加载中同样允许切换：新请求的 epoch 会让旧响应失效（迟到结果不覆盖
  // 列表、也不清 loading）。此前 loading 守卫会直接吞掉开关——sudo 操作
  // 卡在 sidecar 超时里时用户无法退出 sudo 模式，面板看起来像死了。
  sudoMode.value = !sudoMode.value;
  persistState();
  void loadDirectory();
}

// 目录跟随权限引导的动作：切到 sudo 模式并重载目标目录（守卫与手动开关一致）。
async function enableSudoModeAndReload(path: string) {
  if (!connected.value || !canWrite.value) return;
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
  void loadDirectoryStatus(target).then((loaded) => {
    // issue #268：路径栏输入的是文件而非目录时，SFTP list 对 ENOTDIR 只回
    // 笼统的 "SFTP operation failed" 原始错误串。补一次 stat：目标存在且不是
    // 目录 → 清横幅、走双击同款预览入口（预览里就有外部编辑器打开）；目标真
    // 是目录（权限拒绝等）或 stat 也失败 → 维持原错误横幅不动。
    if (loaded !== false || !openPathBarFile) return;    void window.dbxPlugin
      .invoke<{ kind?: string }>(sudoMode.value ? "sudo/stat" : "sftp/stat", { sessionId: session.value?.sessionId, path: target })
      .then((stat) => {
        if (!stat || stat.kind === "directory") return;
        // 编辑保存后的列表刷新以路径栏为准：文件提交已把 currentPath 置成文
        // 件路径，不纠正的话刷新继续对文件 list 报 ENOTDIR（beta.4 用户实测
        // 反馈）。回退父目录并立即重载——列表与路径栏一致，保存后的刷新正
        // 好落在父目录、能看到刚改的文件。
        currentPath.value = parentPath(target);
        sftpError.value = "";
        sftpErrorOpen.value = false;
        openPathBarFile(target);
        void loadDirectory(currentPath.value);
      })
      .catch(() => undefined);
  });
}

  return {
    loadHome,
    refreshSftpHomePath,
    loadDirectory,
    sftpSoftError,
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
