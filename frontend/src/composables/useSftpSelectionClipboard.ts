import { type Ref } from "vue";
import type { SftpEntryKind } from "../lib/sftpEntries";
import { confirmDialog } from "../lib/confirmDialog";
import { expandSelection } from "../lib/sftpFileFilters";

// 列表条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type ListingEntry = { uri: string; name: string; kind: SftpEntryKind };
type SftpClipboard = { mode: "copy" | "cut"; paths: string[]; connectionId: string };

/** SFTP 文件行选中与剪贴板粘贴：单击/Ctrl/Shift 多选（行 mousedown 防聚焦
 * 滚动）、右键复制/剪切到连接级剪贴板、粘贴前存在性预检 + 覆盖确认
 * （wire 形式探测，非 UTF-8 名不漏检），cut 清剪贴板、copy 保留。 */
export function useSftpSelectionClipboard(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  canWrite: Ref<boolean>;
  connectionId: Ref<string>;
  currentPath: Ref<string>;
  entries: Ref<ListingEntry[]>;
  visibleEntries: Ref<ListingEntry[]>;
  selectedPath: Ref<string>;
  selectedUris: Ref<string[]>;
  selectedUriSet: Ref<Set<string>>;
  lastClickedUri: Ref<string>;
  sftpClipboard: Ref<SftpClipboard | undefined>;
  pasteBusy: Ref<boolean>;
  fileMenu: Ref<{ entry: ListingEntry; selection: string[] } | undefined>;
  closeFileMenu: () => void;
  joinRemote: (parent: string, name: string) => string;
  remoteBasename: (path: string) => string;
  pathFromUri: (uri: string) => string;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { t, showNotice, showError, session, canWrite, connectionId, currentPath, entries, visibleEntries, selectedPath, selectedUris, selectedUriSet, lastClickedUri, sftpClipboard, pasteBusy, fileMenu, closeFileMenu, joinRemote, remoteBasename, pathFromUri, loadDirectory } = options;

function clearRowSelection() {
  selectedUris.value = [];
  lastClickedUri.value = "";
}

/** 行宽大于 .file-rows 容器宽时（开满 5 列），mousedown 默认聚焦会把整行
 *  scrollIntoView 到容器中心——Name 列被挤出视野，双击/右键的第二次点击
 *  落点随之偏移。阻止行上 mousedown 的默认行为即可消除聚焦滚动；键盘 Tab
 *  聚焦不走 mousedown，不受影响。重命名输入框需要真实聚焦，放行。 */
function onFileRowMousedown(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest(".rename-input")) return;
  event.preventDefault();
}

function selectFile(entry: ListingEntry, event?: MouseEvent) {
  selectedPath.value = entry.uri;
  if (event?.shiftKey && lastClickedUri.value) {
    const expanded = expandSelection(selectedUris.value, lastClickedUri.value, entry.uri, visibleEntries.value.map((item) => item.uri));
    if (expanded.length > selectedUris.value.length || selectedUriSet.value.has(entry.uri)) {
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

function copySelectedEntries(mode: "copy" | "cut") {
  const entry = fileMenu.value?.entry;
  if (!entry) return;
  const uris = selectedUriSet.value.has(entry.uri) && selectedUris.value.length > 1 ? selectedUris.value : [entry.uri];
  sftpClipboard.value = { mode, paths: uris.map((uri) => pathFromUri(uri)), connectionId: connectionId.value };
  closeFileMenu();
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
  // 粘贴前逐项检测目标是否已存在；存在则弹覆盖确认。剪贴板路径与面板当前
  // 目录都是列表回传的 wire 形式（latin-1 下 %XX 转义），预检带 form:"wire"
  // 让 sidecar 整条按 wire 还原字节探测（M17 增量①：此前末段被按显示文本
  // 编码，非 UTF-8 名探不到）；预检失败不阻断粘贴，交由后端执行时报错。
  const conflicting: string[] = [];
  for (const from of clip.paths) {
    try {
      const result = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", {
        sessionId,
        path: joinRemote(currentPath.value, remoteBasename(from)),
        form: "wire",
      });
      if (result.exists) conflicting.push(remoteBasename(from));
    } catch {
      // 存在性检测失败不阻断粘贴，交由后端执行时报错。
    }
  }
  let overwrite = false;
  if (conflicting.length) {
    if (!(await confirmDialog(t("sftpPaste.overwriteConfirm", { count: conflicting.length, names: conflicting.slice(0, 5).join(", ") })))) return;

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


  return {
    clearRowSelection,
    onFileRowMousedown,
    selectFile,
    copySelectedEntries,
    pasteClipboard,
  };
}
