import { ref, type Ref } from "vue";

/** 新建目录对话框（mkdir；sudo 会话走 sudo/mkdir 通道）。 */
export function useSftpCreateDirectory(options: {
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  sudoMode: Ref<boolean>;
  currentPath: Ref<string>;
  joinRemote: (parent: string, name: string) => string;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { showError, session, sudoMode, currentPath, joinRemote, loadDirectory } = options;

const operationDialog = ref<"mkdir" | null>(null);
const operationDraft = ref("");

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


  return {
    operationDialog,
    operationDraft,
    createDirectory,
  };
}
