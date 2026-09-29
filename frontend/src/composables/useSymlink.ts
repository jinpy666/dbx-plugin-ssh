import { ref, type Ref } from "vue";
import { hasLossyChars } from "../lib/sftpName";
import type { SftpEntryKind } from "../lib/sftpEntries";

/** 符号链接（P2-6）：新建/改指向小对话框、提交（create 直建 / edit 先比对
 * 避免无谓删建）、列表 tooltip 的 → target 缓存与加载后只读解析。 */
export function useSymlink(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  currentPath: Ref<string>;
  pathFromUri: (uri: string) => string;
  joinRemote: (parent: string, name: string) => string;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { t, showError, session, currentPath, pathFromUri, joinRemote, loadDirectory } = options;

// 目录条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type SideSftpEntry = { uri: string; name: string; kind: SftpEntryKind; lossy?: boolean };

// —— 符号链接（P2-6）：新建/改指向小对话框 + 列表 tooltip 的 → target 缓存。
// create 用 draft(链接名)+targetDraft(指向)；edit 复用 draft 承载指向。
const symlinkDialog = ref<{ mode: "create" | "edit"; linkPath: string; name: string } | null>(null);
const symlinkDraft = ref("");
const symlinkTargetDraft = ref("");
const symlinkSubmitting = ref(false);
const linkTargets = ref<Record<string, string>>({});

// —— 符号链接（P2-6）——
function beginSymlinkCreate() {
  if (!session.value) return;
  symlinkDraft.value = "";
  symlinkTargetDraft.value = "";
  symlinkDialog.value = { mode: "create", linkPath: "", name: "" };
}

function beginSymlinkEdit(entry: SideSftpEntry) {
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
function linkTargetTitle(entry: SideSftpEntry): string | undefined {
  const target = entry.kind === "symlink" ? linkTargets.value[entry.uri] : undefined;
  const linkTitle = target ? `→ ${target}` : undefined;
  // M14-B：lossy 行名（wire 含 U+FFFD）在悬停提示里说明字节不可还原，
  // 并指向设置 → 传输的文件名编码偏好。
  if (entry.lossy || hasLossyChars(entry.name)) return [linkTitle, t("sftpName.lossyTitle")].filter(Boolean).join(" · ");
  return linkTitle;
}

/** 列表加载后解析 symlink 条目的指向（只读 readlink，并发、失败静默——
 * 悬空链接也照常显示，tooltip 缺失只是没有 target 文案）。 */
async function hydrateLinkTargets(list: SideSftpEntry[]) {
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


  return {
    symlinkDialog,
    symlinkDraft,
    symlinkTargetDraft,
    symlinkSubmitting,
    linkTargets,
    beginSymlinkCreate,
    beginSymlinkEdit,
    commitSymlink,
    linkTargetTitle,
    hydrateLinkTargets,
  };
}
