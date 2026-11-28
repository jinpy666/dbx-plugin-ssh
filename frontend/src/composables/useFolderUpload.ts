import { ref, type Ref } from "vue";
import { advanceFolderUploadDirectories, buildFolderUploadPlan, createFolderUploadProgress, folderUploadOutcome, settleFolderUploadFile, type FolderUploadProgress } from "../lib/folderUpload";
import { createTarChunkSource, shouldFolderArchive } from "../lib/folderArchive";
import { runTransfers } from "../lib/transferQueue";

interface FolderUploadEntry {
  name: string;
  relativePath: string;
  size: number;
  readChunk: (offset: number, length: number) => Promise<Uint8Array>;
}

/** 文件夹上传（issue #78，自 useUploadChain 纯搬移）：纯前端编排，复用既有
 * sftp/upload 管线 —— 选目录 → buildFolderUploadPlan 生成远端目录集 + 文件
 * 清单 → 逐目录 sftp/createDirectory（逐个 ensure，父先于子）→ 逐文件
 * uploadSource（冲突策略：rename/overwrite 交给既有 resolveUploadDuplicateName；
 * ask 在批量下降级为「已存在即跳过」+ 完成提示计数，避免上百次弹窗交互）。
 * 能力探测：浏览器无 webkitdirectory 支持时入口隐藏（onMounted 一次性探测）。 */
export function useFolderUpload(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  connected: Ref<boolean>;
  canWrite: Ref<boolean>;
  currentPath: Ref<string>;
  sftpNameEncodingState: Ref<string>;
  /** 批次并发上限（与 useUploadChain 同源：批次并发与会话深度取小）。 */
  batchTransferLimit: () => number;
  loadTransferDuplicatePolicy: () => "rename" | "ask" | "overwrite";
  uploadSource: (name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string, options?: { duplicatePreCheckedAbsent?: boolean; batchId?: string; lzpack?: boolean }) => Promise<boolean>;
  resolveUploadDuplicateName: (name: string, targetDir: string) => Promise<{ name: string; proceed: boolean }>;
  resetBatchDecision: () => void;
  loadDirectory: (path?: string) => Promise<void>;
  openTransferPanel: () => void;
  joinRemote: (parent: string, name: string) => string;
  /** UploadSudo：与 useTransferQueue 同源判定（sudo 模式 + 可写连接）。重复
   * 预检（exists/rename-unique）与文件夹上传的逐目录建目录随之换 sudo 族——
   * 目标目录（如 /root）对登录用户不可读时 SFTP 探测/建目录必失败。 */
  sudoUpload: () => boolean;
}) {
  const { t, showNotice, showError, session, connected, canWrite, currentPath, sftpNameEncodingState, batchTransferLimit, loadTransferDuplicatePolicy, uploadSource, resolveUploadDuplicateName, resetBatchDecision, loadDirectory, openTransferPanel, joinRemote, sudoUpload } = options;

  // 文件夹上传（issue #78）：webkitdirectory 选择器 + 能力探测（缺失时入口隐藏）。
  const folderUploadInput = ref<HTMLInputElement>();
  const folderUploadSupported = ref(false);
  // 文件夹批量上传的聚合进度（复用传输面板展示；目录 X/Y · 文件 N/M）。
  const folderUploadProgress = ref<FolderUploadProgress>();

  function chooseFolderUpload() {
    if (!connected.value || !canWrite.value || !folderUploadSupported.value) return;
    openTransferPanel();
    folderUploadInput.value?.click();
  }

  function onFolderUploadInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = "";
    if (!files.length) return;
    void uploadFolderFiles(files.map((file) => ({
      name: file.name,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || "",
      size: file.size,
      readChunk: (offset: number, length: number) => file.slice(offset, offset + length).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    }))).catch(showError);
  }

  async function uploadFolderFiles(entries: readonly FolderUploadEntry[], baseDir?: string) {
    if (!session.value || !canWrite.value) return;
    // 并发 run 闭包里不能用 session.value（TS 无法跨异步闭包收窄）：守卫后
    // 捕获一次。
    const sessionId = session.value.sessionId;
    // 批量决策是「每批次开头清 undefined」的契约：文件夹入口同样要清，否则
    // 上一批的「应用到全部=覆盖」残留会让本批归档撞名时静默放行（解包恒覆盖，
    // 属破坏性结果）。
    resetBatchDecision();
    // baseDir：终端/宿主桥拖入的自定义落点；缺省仍是 SFTP 当前目录。
    const base = baseDir ?? currentPath.value;
    const plan = buildFolderUploadPlan(entries);
    if (!plan.files.length) {
      showNotice(t("folderUpload.empty"));
      return;
    }
    // 文件夹整包车道（folderArchive）：超过阈值的目录打成单个流式 tar 走既有
    // 上传管线（网络腿 gzip 由 M33 决策、sudo 车道由 UploadSudo 接管），落盘后
    // 远端 sftp/extract 解包。latin-1 不走该车道：tar 头名字节与解包命令串都是
    // UTF-8 边界（登记边界）。整包超传输上限时回退逐文件。
    if (sftpNameEncodingState.value !== "latin-1" && shouldFolderArchive(plan.files.length)) {
      const archiveEntries = plan.files.map((file) => ({
        relativePath: file.relativePath,
        size: file.size,
        // readChunk 经计划保留的 source 回取：plan.files 是 entries 的过滤子集，
        // 按下标配对会在首条被跳过后整体错位（A 的字节传到 B 的名字下）。
        readChunk: file.source.readChunk,
      }));
      const source = createTarChunkSource(archiveEntries);
      if (source) {
        openTransferPanel();
        try {
          // 冲突策略作用于归档名本身（复用既有预检：ask/rename/覆盖）；解包
          // 恒 overwrite——整包语义就是解包覆盖，逐文件策略不适用。
          const resolved = await resolveUploadDuplicateName(source.name, base);
          if (!resolved.proceed) return;
          const archivePath = joinRemote(base, resolved.name);
          await uploadSource(resolved.name, source.size, source.readChunk, undefined, base, { duplicatePreCheckedAbsent: true });
          await window.dbxPlugin.invoke("sftp/extract", { sessionId, archivePath, destinationPath: base, overwrite: true, sudo: sudoUpload() }, { timeoutMs: 10 * 60 * 1000 });
          // 归档是传输载体：解包成功即清理（sudo 车道 sudo/remove），失败保留
          // 供手工解包。
          await window.dbxPlugin.invoke(sudoUpload() ? "sudo/remove" : "sftp/delete", { sessionId, path: archivePath }).catch(() => undefined);
          await loadDirectory();
          showNotice(t("folderArchive.completed", { count: archiveEntries.length, name: resolved.name }));
        } catch (cause) {
          showError(cause, "sftp");
        }
        return;
      }
      showNotice(t("folderArchive.tooLarge"));
    }
    openTransferPanel();
    let progress = createFolderUploadProgress(plan);
    const publish = (currentFile = "") => {
      folderUploadProgress.value = { ...progress, currentFile };
    };
    publish();
    // 逐目录 ensure：集合已去重且父先于子；单目录失败不阻断（文件上传会
    // 因目录缺失自然失败并计入 failed），创建失败只降级提示。
    for (const relative of plan.directories) {
      const remotePath = joinRemote(base, relative);
      try {
        // sudo 车道建目录换 sudo/mkdir（参数族同用 path），父目录不可写时
        // SFTP createDirectory 必失败。
        const mkdirMethod = sudoUpload() ? "sudo/mkdir" : "sftp/createDirectory";
        await window.dbxPlugin.invoke(mkdirMethod, { sessionId, path: remotePath });
      } catch {
        // 已存在/权限不足等：由后续文件上传结果兜底，这里不中止整批。
      }
      progress = advanceFolderUploadDirectories(progress);
      publish();
    }
    let skipped = 0;
    let failed = 0;
    // 逐文件上传走 runTransfers（评审 M-4）：尊重批次并发偏好，不再纯串行；
    // 聚合进度（文件 N/M · 当前相对路径）在并发 run 里同步推进（单线程事件
    // 循环内 read-modify-write 无交错）。单文件失败计 failed 不中止整批——
    // catch 吞掉不外抛，runTransfers 的失败中止语义不触发；用户取消同理
    // （计 failed，批次继续，与既有串行语义一致）。
    await runTransfers(plan.files.map((file, index) => ({ file, entry: file.source, index })), batchTransferLimit(), {
      id: (item) => `folder-${item.index}`,
      run: async (item) => {
        const { file, entry } = item;
        progress.currentFile = file.relativePath;
        publish(file.relativePath);
        const segments = file.relativePath.split("/");
        const dirSegments = segments.slice(0, -1);
        const fileName = segments[segments.length - 1];
        const targetDir = dirSegments.length ? joinRemote(base, dirSegments.join("/")) : base;
        try {
          // ask 模式批量降级：预检已存在则跳过；不存在则带 preCheckedAbsent
          // 上传，免去 uploadSource 内的第二次 exists（评审 M-4）。sudo 车道
          // 预检换 sudo/exists（目标目录不可读时 sftp/exists 恒 false）。
          if (loadTransferDuplicatePolicy() === "ask") {
            const existsMethod = sudoUpload() ? "sudo/exists" : "sftp/exists";
            const probe = await window.dbxPlugin.invoke<{ exists: boolean }>(existsMethod, { sessionId, path: joinRemote(targetDir, fileName) }).catch(() => ({ exists: false }));
            if (probe.exists === true) {
              skipped += 1;
              progress = settleFolderUploadFile(progress, { file, ok: false });
              publish();
              return;
            }
            await uploadSource(fileName, file.size, entry.readChunk, undefined, targetDir, { duplicatePreCheckedAbsent: true });
          } else {
            await uploadSource(fileName, file.size, entry.readChunk, undefined, targetDir);
          }
          progress = settleFolderUploadFile(progress, { file, ok: true });
        } catch {
          failed += 1;
          progress = settleFolderUploadFile(progress, { file, ok: false });
        }
        publish();
      },
    });
    const outcome = folderUploadOutcome(progress, skipped, failed);
    folderUploadProgress.value = undefined;
    await loadDirectory();
    let message: string;
    if (outcome.failed) {
      message = t("folderUpload.completedWithFailures", { count: outcome.failed, total: outcome.fileCount });
    } else {
      message = t("folderUpload.completed", { count: outcome.uploaded });
    }
    if (outcome.skipped) message += t("folderUpload.skippedNote", { count: outcome.skipped });
    showNotice(message);
  }

  return { folderUploadInput, folderUploadSupported, folderUploadProgress, chooseFolderUpload, onFolderUploadInput, uploadFolderFiles };
}
