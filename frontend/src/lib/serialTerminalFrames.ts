/**
 * 串口 B1 二进制通道（`serial/terminal/in|out/{sessionId}`）前端帧编解码。
 *
 * 帧与 SSH/local/Telnet 输出帧同构（`TerminalFrame`：1 字节流标签 + 大端
 * u64 单调序号 + 数据，见 docs/PROTOCOL.zh-CN.md「二进制通道」节），写方向
 * 专用 `Stdin = 3` 标签（避开 local 终端已占用的 State = 2 带内状态帧）。
 *
 * 契约（docs/SERIAL_ENHANCE_DESIGN.zh-CN.md §2）：
 * - 解码端（宿主桥/前端/sidecar）遇到未知流标签一律静默丢弃该帧并计数，
 *   不得断连或 panic；
 * - sidecar 对 `serial/terminal/in` 上标签非 Stdin 的入站帧返回参数错误
 *   （sidecar 侧实现，见 backend/src/serial_session.rs decode_input_frame）。
 */

export const SERIAL_STREAM_STDOUT = 0;
export const SERIAL_STREAM_STDERR = 1;
export const SERIAL_STREAM_STATE = 2;
export const SERIAL_STREAM_STDIN = 3;

/** 协议已知流标签上界；解码端遇到更大标签按未知处理（丢帧 + 计数）。 */
export const SERIAL_MAX_KNOWN_STREAM_TAG = SERIAL_STREAM_STDIN;

export function isKnownStreamTag(tag: number): boolean {
  return Number.isInteger(tag) && tag >= 0 && tag <= SERIAL_MAX_KNOWN_STREAM_TAG;
}

/** 编码一条 Stdin 写帧：`Stdin 标签 | 大端 u64 序号 | 原始键序字节`。 */
export function encodeSerialInputFrame(sequence: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(9 + data.byteLength);
  frame[0] = SERIAL_STREAM_STDIN;
  new DataView(frame.buffer).setBigUint64(1, BigInt(sequence), false);
  frame.set(data, 9);
  return frame;
}
