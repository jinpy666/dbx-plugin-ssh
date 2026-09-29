import { nextTick, ref, type Ref } from "vue";
import { confirmDialog } from "../lib/confirmDialog";
import { shouldCommitRename } from "../lib/sftpRename";

/** SFTP 行内重命名：blur 兜底提交（R3-P1-2/R3-P2-1 短路语义）、目标存在性
 * 预检 + 覆盖确认（R3-P2-2）、sudo 通道分流；失败收敛为关闭编辑态并刷新。 */
export function useSftpRename(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  canWrite: Ref<boolean>;
  sudoMode: Ref<boolean>;
  selectedPath: Ref<string>;
  currentPath: Ref<string>;
  pathFromUri: (uri: string) => string;
  joinRemote: (parent: string, name: string) => string;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { t, showError, session, canWrite, sudoMode, selectedPath, currentPath, pathFromUri, joinRemote, loadDirectory } = options;

// 目录条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type RenameEntry = { uri: string; name: string };

const renamingPath = ref("");
const renameDraft = ref("");
const renameSubmitting = ref(false);

function beginRename(entry: RenameEntry) {
  if (!canWrite.value) return;
  selectedPath.value = entry.uri;
  renamingPath.value = entry.uri;
  renameDraft.value = entry.name;
  void nextTick(() => document.querySelector<HTMLInputElement>(".rename-input")?.select());
}

async function commitRename(entry: RenameEntry) {
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
    if (targetExists && !(await confirmDialog(t("sftpRename.overwriteConfirm", { name })))) {

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


  return {
    renamingPath,
    renameDraft,
    renameSubmitting,
    beginRename,
    commitRename,
  };
}
