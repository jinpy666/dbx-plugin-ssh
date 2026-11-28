import { computed, onUnmounted, ref, type Ref } from "vue";
import { PREVIEW_CONFIRM_BYTES, PREVIEW_MAX_BYTES } from "../lib/preview";
import type { PreviewResolution } from "../lib/previewResolver";

export type PreviewMode = "text" | "image" | "hex" | "viewer";

/** 二进制预览分块流式加载（自 PreviewPane 纯搬移，sftp/stat + sftp/read offset）：
 * 按 1MiB/片（sudo 车道 4MiB）顺序拉取（并发 1）拼装成单个 Blob，进度条以
 * 「已取字节 / totalSize」渲染；取消在分片间隙打断并干净关闭；失败保留已取
 * 字节，可从失败 offset 续传。eof / 取满 totalSize 即收口。
 * 超硬上限（>256MiB）不进浏览器内存保持「下载代替」出口；大文件（>32MiB 的
 * PDF/Office/媒体）先询问——「仍要预览」后本文件不再重复询问。图片不拦。
 * 组件级状态（size/error/mode/dataUri/sourceFile）经依赖注入回写；换文件的
 * 重置经 newAttempt() 完成（同时失效旧分块循环与在途读取）。 */
export function useChunkedPreview(options: {
  path: () => string | null;
  perChunkBytes: () => number;
  readOnce: (path: string, offset: number, length: number) => Promise<{ dataBase64: string; truncated: boolean }>;
  /** viewer 收口时的文件名（预览标题）。 */
  title: () => string;
  /** 本次预览的解析结果（load() 解析后写入；「仍要预览/续传」复用）。 */
  resolution: () => PreviewResolution | null;
  /** 组件级加载态（大文件确认与续传复用整条 loading 门）。 */
  loading: Ref<boolean>;
  /** sudo 车道（stat/read 走 sudo 族）。 */
  sudo: () => boolean;
  sessionId: () => string | undefined;
  /** 组件级展示大小（整读与分块两条链路共用）。 */
  size: Ref<number>;
  /** 组件级错误（整读与分块共用）。 */
  error: Ref<string>;
  setMode: (mode: PreviewMode) => void;
  emitClose: () => void;
}) {
  const { path, perChunkBytes, readOnce, title, resolution, loading, sudo, sessionId, size, error, setMode, emitClose } = options;

  const chunkActive = ref(false);
  const chunkCancelRequested = ref(false);
  const loadedBytes = ref(0);
  const totalBytes = ref(0);
  const chunkPercent = computed(() => {
    if (!totalBytes.value) return 0;
    return Math.min(100, Math.round((loadedBytes.value / totalBytes.value) * 100));
  });
  // 大文件先询问（>32MiB 的 PDF/Office/媒体）：不自动整文件进内存，先给
  // 下载 / 本地打开 / 仍要预览三个出口；用户确认后本文件不再重复询问。
  const largeFile = ref(false);
  const largeFileConfirmed = ref(false);
  // 分块预览超硬上限（>256MiB 不进浏览器内存，保持「下载代替」出口）。
  const overCap = ref(false);
  const dataUri = ref("");
  const sourceFile = ref<File | null>(null);
  /** 分块循环的失效令牌：换文件/取消时自增，旧循环在下一个检查点退出。 */
  let loadToken = 0;
  /** 已取分片（非响应式：大数组逐片 push 不应触发渲染）。 */
  let parts: Uint8Array[] = [];
  let objectUrl = "";

  function revokeObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = "";
    }
  }

  onUnmounted(revokeObjectUrl);
  onUnmounted(() => {
    // 关闭预览（X/Esc/遮罩）也要打断后续分片：大文件不在后台继续下载。
    chunkCancelRequested.value = true;
    loadToken += 1;
  });

  /** 换文件/重开：失效在途分块循环与读取请求，重置全部分块状态。返回本次
   * 加载的令牌供调用方做整读过期检查（检查点语义同 runChunkLoop）。 */
  function newAttempt(): number {
    loadToken += 1;
    chunkCancelRequested.value = false;
    chunkActive.value = false;
    loadedBytes.value = 0;
    totalBytes.value = 0;
    parts = [];
    revokeObjectUrl();
    dataUri.value = "";
    sourceFile.value = null;
    overCap.value = false;
    largeFile.value = false;
    largeFileConfirmed.value = false;
    return loadToken;
  }

  async function loadChunked(resolution: PreviewResolution) {
    // token 在本函数入口捕获并贯穿整个分块链路：stat 是第一个 await，
    // 旧一次 load 的 stat 迟到时会用旧文件的大小覆盖新一轮状态。
    const token = loadToken;
    const total = await fetchTotalSize();
    if (token !== loadToken) return;
    // null = 大小未知（sudo/stat、sftp/stat 均失败）：
    // 不能当成 0 字节直接收口，否则 PDF/Office 会拿空 File 渲染（PDF 侧
    // 报「缺少可读取的数据源」）。未知大小走 truncated 语义逐片读到 EOF。
    size.value = total ?? 0;
    totalBytes.value = total ?? 0;
    if (total !== null && total > PREVIEW_MAX_BYTES) {
      overCap.value = true;
      return;
    }
    // 大文件先询问：PDF/Office/媒体超过 32MiB 不自动整文件进内存，先给
    // 「打开方式 / 下载 / 仍要预览」。图片不拦（浏览器解码足够轻）。
    if (
      resolution.previewStrategy === "file-viewer"
      && total !== null
      && total > PREVIEW_CONFIRM_BYTES
      && !largeFileConfirmed.value
    ) {
      largeFile.value = true;
      return;
    }
    largeFile.value = false;
    chunkActive.value = true;
    parts = [];
    loadedBytes.value = 0;
    await runChunkLoop(resolution, 0, token);
  }

  /** 「仍要预览」：用户明确接受整文件进内存后，按同一链路继续加载。 */
  async function previewLargeAnyway() {
    if (!path() || !resolution() || loading.value) return;
    largeFileConfirmed.value = true;
    largeFile.value = false;
    loading.value = true;
    try {
      await loadChunked(resolution()!);
    } finally {
      loading.value = false;
    }
  }

  /** sudo/readFile 无 stat 语义，但 sudo/stat 能拿精确大小（App 属性面板同源）：
   * 能取到就走确定进度 + 大文件门禁；取不到再退回 unknown 的 truncated 语义。 */
  async function fetchTotalSize(): Promise<number | null> {
    try {
      const stat = await window.dbxPlugin.invoke<{ size?: number }>(sudo() ? "sudo/stat" : "sftp/stat", {
        sessionId: sessionId(),
        path: path(),
      });
      return Number(stat.size ?? 0);
    } catch {
      return null;
    }
  }

  /** 分片循环：顺序（并发 1）拉取；token/取消在每个 await 后检查。 */
  async function runChunkLoop(resolution: PreviewResolution, fromOffset: number, token: number) {
    try {
      let offset = fromOffset;
      // total=0 表示大小未知（sudo 车道 / stat 失败）：靠 truncated 语义收口。
      const total = () => totalBytes.value;
      while (!total() || offset < total()) {
        if (token !== loadToken || chunkCancelRequested.value) return;
        // 未知大小车道没有 stat 上限可依：流式读到 256MiB 即停，保持「下载代替」出口。
        if (!total() && offset >= PREVIEW_MAX_BYTES) {
          chunkActive.value = false;
          parts = [];
          overCap.value = true;
          return;
        }
        const length = total() ? Math.min(perChunkBytes(), total() - offset) : perChunkBytes();
        const result = await readOnce(path() ?? "", offset, length);
        if (token !== loadToken || chunkCancelRequested.value) return;
        const chunk = window.dbxPlugin.decodeBase64(result.dataBase64);
        if (!chunk.byteLength) {
          // 已知大小但还没到 EOF 却读回空片：按协议异常上抛，避免拼出
          // 空/残缺文件后让 viewer 报无从定位的格式错误。
          if (!total()) break;
          if (offset >= total()) break;
          throw new Error("SFTP read returned no data before EOF");
        }
        parts.push(chunk);
        offset += chunk.byteLength;
        loadedBytes.value = offset;
        // 大小未知车道：truncated 表示还有后续，继续下一片；否则收口。
        if (!total() && !result.truncated) break;
        if (total() && offset >= total()) break;
      }
      finishChunkPreview(resolution);
    } catch (cause) {
      if (token !== loadToken || chunkCancelRequested.value) return;
      // 保留已取字节与 chunkActive：错误面板给出「从失败 offset 重试」。
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** 拼装收口：image → object URL；viewer → File 交给既有渲染。 */
  function finishChunkPreview(resolution: PreviewResolution) {
    chunkActive.value = false;
    const blob = new Blob(parts as BlobPart[], { type: resolution.mime ?? "application/octet-stream" });
    // 成功收口后释放分片：Blob 已自持数据，parts 继续被模块级变量持有等于双倍内存。
    parts = [];
    if (resolution.previewStrategy === "image") {
      setMode("image");
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        revokeObjectUrl();
        objectUrl = URL.createObjectURL(blob);
        dataUri.value = objectUrl;
      }
      return;
    }
    setMode("viewer");
    sourceFile.value = new File([blob], title() || "file", { type: blob.type });
  }

  /** 取消：打断剩余分片并干净关闭（不落错误 UI）。 */
  function cancelChunkLoad() {
    if (!chunkActive.value) return;
    chunkCancelRequested.value = true;
    chunkActive.value = false;
    parts = [];
    emitClose();
  }

  /** 失败续传：从已取 offset 继续拉剩余分片（沿用原 resolution 渲染链路）。 */
  async function resumeChunkLoad() {
    if (!path() || !resolution() || loading.value) return;
    error.value = "";
    chunkCancelRequested.value = false;
    chunkActive.value = true;
    loading.value = true;
    try {
      // 已知大小按已取 offset 续传；未知大小（sudo/stat 失败）没有 total 可钳，
      // 直接用已取字节数，避免 Math.min(...) 归零后把 parts 重复拼一遍。
      const resumeFrom = totalBytes.value ? Math.min(loadedBytes.value, totalBytes.value) : loadedBytes.value;
      await runChunkLoop(resolution()!, resumeFrom, loadToken);
    } finally {
      loading.value = false;
    }
  }

  return {
    chunkActive,
    chunkCancelRequested,
    loadedBytes,
    totalBytes,
    chunkPercent,
    largeFile,
    largeFileConfirmed,
    overCap,
    dataUri,
    sourceFile,
    newAttempt,
    /** 整读路径的过期检查：token 仍是当前加载轮次（语义同 loadToken 比较）。 */
    isCurrent: (token: number): boolean => token === loadToken,
    loadChunked,
    previewLargeAnyway,
    cancelChunkLoad,
    resumeChunkLoad,
    revokeObjectUrl,
  };
}
