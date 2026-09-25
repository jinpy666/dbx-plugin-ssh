// SFTP 文件名编码（M14-B）：显示解码与传输路径的硬分离在 UI 侧的镜像。
// 传输永远用 sidecar 给的 wire/uri 字符串（服务器路径字节的忠实载体，
// 非法字节为 %XX 转义）；本模块只服务显示层：
// - lossy 探测：wire 名含 U+FFFD（上游 lossy 解码残留）说明原始字节不可
//   还原，行内给出提示徽标；
// - 编码偏好归一（auto / latin-1），与 sidecar preferences 白名单同向。

export type SftpNameEncoding = "auto" | "latin-1";

export const SFTP_NAME_ENCODINGS: readonly SftpNameEncoding[] = ["auto", "latin-1"];

/** 编码偏好归一：白名单外回落 auto（与 sidecar 缺省一致）。 */
export function sanitizeNameEncoding(value: unknown, fallback: SftpNameEncoding = "auto"): SftpNameEncoding {
  return value === "auto" || value === "latin-1" ? value : fallback;
}

/** wire 名是否携带不可还原字节（U+FFFD）。 */
export function hasLossyChars(wire: string): boolean {
  return wire.includes("\uFFFD");
}

/** wire 名是否携带 %XX 转义（latin-1 列表对非 UTF-8 字节的传输形式）。 */
export function hasWireEscapes(wire: string): boolean {
  return /%[0-9a-fA-F]{2}/.test(wire);
}
