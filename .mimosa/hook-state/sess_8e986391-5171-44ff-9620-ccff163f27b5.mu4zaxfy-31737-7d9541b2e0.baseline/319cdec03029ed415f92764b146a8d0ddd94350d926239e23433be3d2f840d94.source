/**
 * sftp/list 响应容错（UI_SCAN R3-P2-3）：真实 sidecar 契约不应返回 null/
 * 畸形行，但网络或版本错配下防御缺失会把"单行坏数据"放大成"整个列表僵死"
 * （null entries 让 for-of 抛 TypeError、null 行让排序比较器抛错）。
 * sanitize 规则：非数组 → 空数组；非对象行丢弃；缺 kind 的行降级为 file
 * （渲染占位而不是整表丢弃）；size/modifiedAt 非数值时取中性默认。
 */
export type SftpEntryKind = "file" | "directory" | "symlink" | "other";

export interface SftpSanitizedEntry {
  name: string;
  uri: string;
  kind: SftpEntryKind;
  size?: number;
  modifiedAt?: number;
  permissions?: string;
  contentType?: string;
}

const KNOWN_KINDS: readonly SftpEntryKind[] = ["file", "directory", "symlink", "other"];

export function sanitizeSftpEntries(value: unknown): SftpSanitizedEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SftpSanitizedEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) continue;
    if (typeof record.uri !== "string" || !record.uri) continue;
    const kind = KNOWN_KINDS.find((candidate) => candidate === record.kind) ?? "file";
    entries.push({
      ...(record as Omit<SftpSanitizedEntry, "kind">),
      name: record.name,
      uri: record.uri,
      kind,
      size: typeof record.size === "number" ? record.size : undefined,
      modifiedAt: typeof record.modifiedAt === "number" ? record.modifiedAt : undefined,
      permissions: typeof record.permissions === "string" ? record.permissions : undefined,
    });
  }
  return entries;
}
