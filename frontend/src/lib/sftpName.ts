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

/**
 * latin-1 显示路径 → wire 形式（M17 拖入上传目标目录专用）：与 sidecar 的
 * `latin1_encode_display` + `escape_wire` 组合逐字符等价——U+0000..=U+007F
 * 按字面量透传（`%` 自转义为 `%25`，保证字面 `%XX` 输入经 sidecar 的
 * `unescape_wire` 还原不吞）、U+0080..=U+00FF 按码位转义为 `%XX`（latin-1
 * 字节，恰好是 UTF-8 非法序列，与 escape_wire 输出一致）、>U+00FF 的字符
 * （如中文）按 UTF-8 透传兜底。转换后与本地文件名 join 的整条上传路径符合
 * sidecar `write_path_bytes` 的「wire 目录前缀 + 用户新输入的显示末段」分工。
 * 仅 latin-1 模式调用；auto 模式下显示文本与传输形式本就一致。
 */
export function displayPathToWire(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "%") out += "%25";
    else if (code <= 0x7f) out += ch;
    else if (code <= 0xff) out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += ch;
  }
  return out;
}
