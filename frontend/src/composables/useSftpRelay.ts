import { ref, type Ref } from "vue";
import { runTransfers } from "../lib/transferQueue";
import { orderRelayTree, relayTargetDirPrefixes, relayTargetOptions, triageRelaySelection, type RelayWalkFile, type RelayTargetOption } from "../lib/sftpRelay";
import type { BatchSendTarget } from "../lib/batchSend";
import { pluginStore } from "../lib/pluginStore";

/**
 * SFTP 跨会话传输（issue #334）：右键「发送到会话…」把当前面板选中的文件/
 * 文件夹经前端中继泵到另一台在线服务器。
 *
 * 字节路径（不新增 sidecar 方法，全部复用既有管线）：
 * - 下载腿：`sftp/download/start`（saveToLocal:false）→ `sftp/download/next`
 *   + 二进制帧等待器逐片取**原始字节**（压缩通道只影响 wire，交付恒为明文，
 *   gzip 任务需先等 staging ready）；
 * - 上传腿：`uploadSource(..., { sessionId: 目标会话 })`——与批量上传同一
 *   跨连接投递通道，传输面板卡片/取消/暂停/并发上限全部继承；
 * - 中继泵串在 uploadSource 的 readChunk 里：上传循环逐片拉取，天然背压，
 *   内存峰值只有一片。
 *
 * 文件夹：确认时 BFS 遍历源端树（sftp/list 逐目录，上限镜像后端 tree 扫描），
 * 目标侧按相对路径逐目录 createDirectory（父先于子）后逐文件泵送；symlink
 * 一律不跟随（环安全）。sudo 车道不参与：跨机中继按普通车道走，源端 root
 * 属主文件读不到就如实失败，不做静默换道。
 */

/** 上次使用的目标目录（pluginStore：沙箱内 opaque origin 只能经宿主 storage 落盘）。 */
const RELAY_TARGET_DIR_KEY = "ssh-relay-target-dir";

function loadRelayTargetDir(): string {
  try {
    return pluginStore.getItem(RELAY_TARGET_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistRelayTargetDir(value: string) {
  try {
    pluginStore.setItem(RELAY_TARGET_DIR_KEY, value);
  } catch {
    // 存储不可用只失去记忆，发送本身不受影响。
  }
}

interface RelayDownloadStart {
  taskId: string;
  fileName: string;
  size: number;
  chunkSize: number;
  compression?: string;
}

export function useSftpRelay(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string, actions?: Array<{ label: string; run: () => void }>) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  connected: Ref<boolean>;
  session: Ref<{ sessionId: string } | undefined>;
  currentPath: Ref<string>;
  /** 批量目标刷新（useBatchSend.refreshBatchTargets）后读全量列表：含连接名覆盖与本地行（本模块自行过滤）。 */
  loadBatchTargets: () => Promise<BatchSendTarget[]>;
  /** 传输队列入口（useTransferQueue）：sessionId 显式传入即按目标会话投递。 */
  uploadSource: (
    name: string,
    size: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
    resume?: { taskId: string; remotePath: string },
    targetDir?: string,
    extra?: { sessionId?: string; batchId?: string; sudoLane?: boolean },
  ) => Promise<boolean>;
  /** 下载分块二进制等待器（useSftpDownload）：帧路由按 taskId 全局分发。 */
  waitForDownloadChunk: (taskId: string, offset: number) => Promise<Uint8Array>;
  /** 压缩下载的 staging 等待（useSftpDownload）：gzip 任务 prep 就绪前 download/next 报错。 */
  waitForDownloadReady: (taskId: string, compression: string | undefined) => Promise<void>;
  loadTransferConcurrency: () => number;
  joinRemote: (dir: string, name: string) => string;
  pathFromUri: (uri: string) => string;
  openTransferPanel: () => void;
}) {
  const { t, showNotice, showError, connected, session, currentPath, loadBatchTargets, uploadSource, waitForDownloadChunk, waitForDownloadReady, loadTransferConcurrency, joinRemote, pathFromUri, openTransferPanel } = options;

  // 对话框态：relayPrompt 为 null = 关闭；skipped 随批次展示/提示。
  const relayPrompt = ref<{ count: number; skipped: number } | null>(null);
  const relayTargets = ref<RelayTargetOption[]>([]);
  const relayTargetSession = ref("");
  const relayTargetDir = ref("");
  const relayBusy = ref(false);
  let relaySelection: Array<{ name: string; kind: string; uri: string }> = [];
  let relaySeq = 0;

  /** 右键「发送到会话…」：分诊选中项 + 拉目标列表 + 打开对话框。无可选目标/
   * 无可发送内容时直接报错不开框（比打开一个空下拉更直接）。文件夹的树遍历
   * 在确认时进行（开框不阻塞在大目录上）。 */
  async function openSendToSession(entries: ReadonlyArray<{ name: string; kind: string; uri: string }>) {
    if (!connected.value || relayBusy.value) return;
    const triage = triageRelaySelection(entries);
    if (!triage.files.length && !triage.dirs.length) {
      showError(new Error(t("sftpRelay.filesOnly")), "sftp");
      return;
    }
    let targets: RelayTargetOption[] = [];
    try {
      targets = relayTargetOptions(await loadBatchTargets(), session.value?.sessionId ?? "");
    } catch (cause) {
      showError(cause, "sftp");
      return;
    }
    if (!targets.length) {
      showError(new Error(t("sftpRelay.noTargets")), "sftp");
      return;
    }
    relaySelection = [...entries];
    relayTargets.value = targets;
    relayTargetSession.value = targets[0]?.sessionId ?? "";
    relayTargetDir.value = loadRelayTargetDir() || currentPath.value;
    relayPrompt.value = { count: entries.length, skipped: triage.skipped };
  }

  function closeSendToSession() {
    if (relayBusy.value) return;
    relayPrompt.value = null;
  }

  /** 单文件中继：下载腿原始字节 → uploadSource 逐片泵到目标会话。 */
  async function relayOne(file: { name: string; uri: string }, sourceSessionId: string, targetSessionId: string, targetDir: string, batchId: string): Promise<boolean> {
    const info = await window.dbxPlugin.invoke<RelayDownloadStart>("sftp/download/start", {
      sessionId: sourceSessionId,
      // M27-A 路径形态契约：下载 start 只吃列表回传的 wire 形式。
      remotePath: pathFromUri(file.uri),
      saveToLocal: false,
    });
    // 压缩任务等 staging ready（未就绪时 download/next 直接报错）。
    await waitForDownloadReady(info.taskId, info.compression);
    let pullOffset = 0;
    let pullEof = false;
    // uploadSource 的泵严格顺序推进（offset 单调），中继只服务顺序读；
    // 乱序请求视为管线状态破坏，按读失败终止（uploadSource 会把
    // readChunk 异常标记 upload-read-failed 并取消任务）。
    const readChunk = async (offset: number): Promise<Uint8Array> => {
      if (offset !== pullOffset || pullEof) throw new Error(t("errors.downloadChunkLength"));
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // 取消经等待器中断；在途请求的 rejection 吞掉避免 unhandled。
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      const chunk = await chunkPromise;
      if (chunk.byteLength !== result.length) throw new Error(t("errors.downloadChunkLength"));
      if (!result.eof && result.length === 0) throw new Error(t("errors.downloadEmptyChunk"));
      pullOffset += chunk.byteLength;
      if (result.eof) pullEof = true;
      return chunk;
    };
    try {
      const done = await uploadSource(file.name, info.size, readChunk, undefined, targetDir, {
        sessionId: targetSessionId,
        batchId,
        sudoLane: false,
      });
      await window.dbxPlugin.invoke("sftp/download/finish", { taskId: info.taskId }, { timeoutMs: 60_000 });
      return done;
    } catch (cause) {
      // 上传腿失败/取消：回收下载腿（任务取消，sidecar 顺带清远端临时件），
      // 原样上抛让 runTransfers 记账（用户取消不中止整批，语义继承）。
      await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
      throw cause;
    }
  }

  // —— 树遍历（阶段 2，文件夹中继）：BFS 走 sftp/list，镜像后端 tree 扫描
  // 的上限口径（sftp_tree.rs：深度 64 / 目录 1 万 / 文件 5 万）——前端遍历
  // 是逐目录 RPC，上限只为防失控，不是性能承诺。symlink 一律不跟随（环安全，
  // 与文件夹下载「跳过符号链接/特殊条目」同语义）。
  const RELAY_WALK_MAX_DIRS = 10_000;
  const RELAY_WALK_MAX_FILES = 50_000;
  const RELAY_WALK_MAX_DEPTH = 64;

  interface RelayWalkAcc {
    dirs: string[];
    files: RelayWalkFile[];
    skipped: number;
    truncated: number;
  }

  async function walkRelayDir(sourceSessionId: string, dirUri: string, relBase: string, depth: number, acc: RelayWalkAcc): Promise<void> {
    const queue: Array<{ uri: string; relBase: string; depth: number }> = [{ uri: dirUri, relBase, depth }];
    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth > RELAY_WALK_MAX_DEPTH || acc.dirs.length >= RELAY_WALK_MAX_DIRS || acc.files.length >= RELAY_WALK_MAX_FILES) {
        acc.truncated += 1;
        continue;
      }
      let entries: Array<{ name: string; kind: string; uri: string }> = [];
      try {
        const result = await window.dbxPlugin.invoke<{ entries?: Array<{ name: string; kind: string; uri: string }> }>("sftp/list", {
          sessionId: sourceSessionId,
          // M27-A：sftp/list 吃 wire 路径（列表回传 uri）。
          path: pathFromUri(current.uri),
        });
        entries = result.entries ?? [];
      } catch {
        // 目录不可读：计入跳过，不让整棵树失败（与文件夹下载的逐目录容错一致）。
        acc.skipped += 1;
        continue;
      }
      for (const entry of entries) {
        if (entry.kind === "directory") {
          const relPath = current.relBase ? `${current.relBase}/${entry.name}` : entry.name;
          acc.dirs.push(relPath);
          queue.push({ uri: entry.uri, relBase: relPath, depth: current.depth + 1 });
        } else if (entry.kind === "file") {
          if (acc.files.length >= RELAY_WALK_MAX_FILES) {
            acc.truncated += 1;
            continue;
          }
          acc.files.push({ relDir: current.relBase, name: entry.name, uri: entry.uri });
        } else {
          acc.skipped += 1;
        }
      }
    }
  }

  async function confirmSendToSession() {
    if (relayBusy.value || !relayPrompt.value) return;
    const targetSessionId = relayTargetSession.value.trim();
    if (!targetSessionId) return;
    const sourceSessionId = session.value?.sessionId;
    if (!sourceSessionId) return;
    const targetDir = relayTargetDir.value.trim() || "/";
    const targetLabel = relayTargets.value.find((target) => target.sessionId === targetSessionId)?.label || targetSessionId;
    const skipped = relayPrompt.value.skipped;
    persistRelayTargetDir(targetDir);
    relayBusy.value = true;
    openTransferPanel();
    let truncated = 0;
    let uploaded = 0;
    let total = 0;
    try {
      // 选中文件直进行（relDir=""），目录先树遍历；顺序收敛交给 orderRelayTree。
      const triage = triageRelaySelection(relaySelection);
      const acc: RelayWalkAcc = {
        dirs: [],
        files: triage.files.map((file) => ({ relDir: "", name: file.name, uri: file.uri })),
        skipped,
        truncated: 0,
      };
      for (const dir of triage.dirs) {
        // cp -r 语义：文件夹本身也复制——目标根下先建同名目录，子项相对其展开。
        acc.dirs.push(dir.name);
        await walkRelayDir(sourceSessionId, dir.uri, dir.name, 1, acc);
      }
      truncated = acc.truncated;
      const tree = orderRelayTree(acc.dirs, acc.files);
      total = tree.files.length;
      // 目标根逐前缀 ensure（mkdir 非递归兜底）+ 目录树按父先于子 ensure：
      // 已存在/无权限等失败静默放行——真正的缺失会在 upload/start 明确报错
      // （任务卡失败），这里不替用户猜语义。
      for (const prefix of relayTargetDirPrefixes(targetDir)) {
        await window.dbxPlugin.invoke("sftp/createDirectory", { sessionId: targetSessionId, path: prefix }).catch(() => undefined);
      }
      for (const rel of tree.dirs) {
        await window.dbxPlugin.invoke("sftp/createDirectory", { sessionId: targetSessionId, path: joinRemote(targetDir, rel) }).catch(() => undefined);
      }
      // 调度 key 带相对目录：不同目录下的同名文件各自成行。
      const rows = tree.files.map((file, index) => ({ key: `relay-${index}`, file }));
      const batchId = `relay-${++relaySeq}`;
      await runTransfers(rows, Math.max(1, loadTransferConcurrency()), {
        id: (row) => row.key,
        run: async (row) => {
          const rowDir = row.file.relDir ? joinRemote(targetDir, row.file.relDir) : targetDir;
          const done = await relayOne({ name: row.file.name, uri: row.file.uri }, sourceSessionId, targetSessionId, rowDir, batchId);
          if (done) uploaded += 1;
        },
      });
    } catch (cause) {
      showError(cause, "sftp");
    } finally {
      relayBusy.value = false;
      relayPrompt.value = null;
    }
    if (uploaded === total) {
      showNotice(t("sftpRelay.completed", { count: uploaded, target: targetLabel }));
    } else {
      showNotice(t("sftpRelay.completedWithFailures", { count: total - uploaded, total, target: targetLabel }));
    }
    if (skipped) showNotice(t("sftpRelay.skippedNote", { count: skipped }));
    if (truncated) showNotice(t("sftpRelay.truncatedNote", { count: truncated }));
  }

  return {
    relayPrompt,
    relayTargets,
    relayTargetSession,
    relayTargetDir,
    relayBusy,
    openSendToSession,
    closeSendToSession,
    confirmSendToSession,
  };
}
