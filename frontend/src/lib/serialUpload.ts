/**
 * 串口文件上传（XMODEM / YMODEM / ZMODEM，NyaTerm 对齐）前端配套。
 *
 * 协议状态机在 sidecar（backend/src/serial_xmodem.rs），由串口读线程驱动；
 * 前端只负责两件事：
 *  1. 用 File API 分块读本地文件（≤64KiB/块），经 serial/upload/data 的
 *     base64 通道送入 sidecar —— 宿主 fileTransfer 缺失（web/docker 模式）
 *     时的浏览器兜底路径；
 *  2. 消费 serial/upload/progress 事件渲染进度 overlay（不含文件内容）。
 *
 * 互斥语义：上传进行中禁止键入直达串口（控制字符窗口），也禁止并发第二次
 * upload（sidecar 侧同样拒绝）。
 */

export type SerialUploadProtocol = "xmodem" | "ymodem" | "zmodem";

export const SERIAL_UPLOAD_PROTOCOLS: SerialUploadProtocol[] = ["xmodem", "ymodem", "zmodem"];

/** 单个 data 分块上限（sidecar 同步校验）。 */
export const SERIAL_UPLOAD_CHUNK_BYTES = 64 * 1024;
/** 单次上传总量上限（sidecar 同步校验）。 */
export const SERIAL_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

/** serial/upload/progress 事件负载（camelCase，与 sidecar json! 对齐）。 */
export interface SerialUploadProgress {
  sessionId: string;
  protocol: SerialUploadProtocol;
  fileName: string;
  fileIndex: number;
  sent: number;
  total: number;
  state: "running" | "file_complete" | "complete" | "failed";
  reason?: string;
}

export type SerialUploadPhase = "idle" | "running" | "file_complete" | "complete" | "failed";

export interface SerialUploadUiState {
  phase: SerialUploadPhase;
  fileName: string;
  protocol: SerialUploadProtocol | "";
  sent: number;
  total: number;
  reason: string;
}

export function initialSerialUploadState(): SerialUploadUiState {
  return { phase: "idle", fileName: "", protocol: "", sent: 0, total: 0, reason: "" };
}

/** 进度事件归并：file_complete 视为继续传输（YMODEM/ZMODEM 批内阶段态）。 */
export function reduceSerialUpload(state: SerialUploadUiState, progress: SerialUploadProgress): SerialUploadUiState {
  const phase: SerialUploadPhase =
    progress.state === "running" || progress.state === "file_complete" ? "running" : progress.state;
  return {
    phase,
    fileName: progress.fileName || state.fileName,
    protocol: progress.protocol || state.protocol,
    sent: progress.sent,
    total: progress.total,
    reason: progress.reason ?? "",
  };
}

export function serialUploadPercent(state: SerialUploadUiState): number {
  if (state.phase === "complete") return 100;
  if (state.total <= 0) return 0;
  return Math.min(100, Math.round((state.sent / state.total) * 100));
}

export function serialUploadActive(state: SerialUploadUiState): boolean {
  return state.phase === "running";
}

// ---------------------------------------------------------------------------
// 文件流式送入（File API 分块 → serial/upload/data）
// ---------------------------------------------------------------------------

export interface SerialUploadBridge {
  invoke<T = unknown>(method: string, params: unknown): Promise<T>;
  encodeBase64(bytes: Uint8Array): string;
}

export interface SerialUploadStreamOptions {
  sessionId: string;
  protocol: SerialUploadProtocol;
  fileName: string;
  bridge: SerialUploadBridge;
  /** 读取 [start, end) 区间字节（浏览器下是 file.slice().arrayBuffer()）。 */
  readChunk: (start: number, end: number) => Promise<Uint8Array>;
  /** 取消轮询：为真时停发分块并向 sidecar 发 cancel。 */
  shouldAbort?: () => boolean;
  chunkBytes?: number;
}

/**
 * 跑完一次上传的送数流程：start → 分块 data（最后一块带 final）→ 完成。
 * 传输本身的成败由 sidecar 的 progress 事件驱动，这里只负责把字节送到位；
 * sidecar 拒绝（会话不存在/已有上传/超限）时抛错给调用方展示。
 */
export async function streamSerialUploadFile(
  file: { size: number },
  options: SerialUploadStreamOptions,
): Promise<void> {
  if (file.size > SERIAL_UPLOAD_MAX_BYTES) {
    throw new Error("tooLarge");
  }
  const chunkBytes = Math.max(1, Math.min(options.chunkBytes ?? SERIAL_UPLOAD_CHUNK_BYTES, SERIAL_UPLOAD_CHUNK_BYTES));
  const { bridge, sessionId } = options;
  await bridge.invoke("serial/upload/start", {
    sessionId,
    protocol: options.protocol,
    fileName: options.fileName,
    totalSize: file.size,
  });
  try {
    if (file.size === 0) {
      // 0 字节文件：循环体不会执行，sidecar 的 X/Y 引擎将停在握手挂起态且
      // 时钟被抑制（永不超时、上传槽被占住）。显式补一条空的 final 分块让
      // 数据源收尾（ZMODEM 侧该分块幂等，ZEOF 语义不变）。
      await bridge.invoke("serial/upload/data", {
        sessionId,
        dataBase64: "",
        final: true,
      });
      return;
    }
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      if (options.shouldAbort?.()) return;
      const end = Math.min(offset + chunkBytes, file.size);
      const bytes = await options.readChunk(offset, end);
      if (options.shouldAbort?.()) return;
      await bridge.invoke("serial/upload/data", {
        sessionId,
        dataBase64: bridge.encodeBase64(bytes),
        final: end >= file.size,
      });
    }
  } catch (cause) {
    // 送数中断（网络/宿主桥失败）：终止 sidecar 侧传输，避免悬挂占用。
    void bridge.invoke("serial/upload/cancel", { sessionId }).catch(() => undefined);
    throw cause;
  }
}
