import { ref, type Ref } from "vue";

/** 压缩/解压（sftp/archive、sftp/extract）：行内右键的归档与解包操作及
 * 归档名判定。侧栏目录压缩（archiveSidePath）因与目录树缓存联动仍留在
 * App.vue，共用本域的 archiveBusy 在途标志。 */
export function useSftpArchive(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  currentPath: Ref<string>;
  pathFromUri: (uri: string) => string;
  joinRemote: (parent: string, name: string) => string;
  loadDirectory: (path?: string) => Promise<void>;
  closeFileMenu: () => void;
}) {
  const { t, showNotice, showError, session, currentPath, pathFromUri, joinRemote, loadDirectory, closeFileMenu } = options;

// 目录条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type ArchiveEntry = { uri: string; name: string };

const archiveBusy = ref(false);

function isArchiveName(name: string) {
  return /\.(tar\.gz|tgz|tar)$/i.test(name);
}

function archiveDirectoryName(name: string) {
  if (/\.(tar\.gz|tgz)$/i.test(name)) return name.replace(/\.(tar\.gz|tgz)$/i, "");
  return name.replace(/\.tar$/i, "");
}

async function archiveEntry(entry: ArchiveEntry) {
  const sessionId = session.value?.sessionId;
  // 目录与单文件都可压缩（sftp/archive 支持任意路径列表）。
  if (!sessionId || archiveBusy.value) return;
  closeFileMenu();
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

async function extractEntry(entry: ArchiveEntry) {
  const sessionId = session.value?.sessionId;
  if (!sessionId || archiveBusy.value) return;
  closeFileMenu();
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


  return {
    archiveBusy,
    isArchiveName,
    archiveDirectoryName,
    archiveEntry,
    extractEntry,
  };
}
