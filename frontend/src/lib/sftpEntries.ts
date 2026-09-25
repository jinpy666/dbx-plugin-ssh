/**
 * sftp/list 响应容错（UI_SCAN R3-P2-3）：真实 sidecar 契约不应返回 null/
 * 畸形行，但网络或版本错配下防御缺失会把"单行坏数据"放大成"整个列表僵死"
 * （null entries 让 for-of 抛 TypeError、null 行让排序比较器抛错）。
 * sanitize 规则：非数组 → 空数组；非对象行丢弃；缺 kind 的行降级为 file
 * （渲染占位而不是整表丢弃）；size/modifiedAt 非数值时取中性默认。
 * owner/group（属主/属组，issue #34）是可选字符串，非字符串一律归一为
 * 缺省（UI 渲染 "-"）。
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
  /** 属主用户；缺省即"未知"（渲染 "-"）。 */
  owner?: string;
  /** 属组；缺省即"未知"（渲染 "-"）。 */
  group?: string;
  /** M14-B：显示名不可忠实还原（wire 名含 U+FFFD）时由 sidecar 标记。 */
  lossy?: boolean;
}

const KNOWN_KINDS: readonly SftpEntryKind[] = ["file", "directory", "symlink", "other"];

/** kind → 图标类别（issue #36）：只有 `directory` 才允许显示文件夹图标；
 * symlink 渲染为链接文档；`other`/未知（含旧 sidecar 的容错输入）一律按
 * 普通文件渲染，保证无扩展名/普通文件永远不会出现文件夹图标。 */
export function sftpEntryIconKind(kind: string | undefined): "folder" | "file" | "link" {
  if (kind === "directory") return "folder";
  if (kind === "symlink") return "link";
  return "file";
}

/** 可选显示列；`owner`/`group` 默认关闭（issue #34：默认不显示，避免打扰现有用户）。 */
export type SftpColumn = "size" | "modified" | "permissions" | "owner" | "group";

const KNOWN_COLUMNS: readonly SftpColumn[] = ["size", "modified", "permissions", "owner", "group"];

/** 持久化状态没有可用列偏好时的默认列（全开 5 列）。 */
export const DEFAULT_VISIBLE_COLUMNS: SftpColumn[] = ["size", "modified", "owner", "group", "permissions"];

/** 各列默认宽度（px）；name 列自动伸缩不占固定值。 */
export const DEFAULT_COLUMN_WIDTHS: Record<SftpColumn, number> = {
  size: 80,
  modified: 130,
  owner: 100,
  group: 100,
  permissions: 90,
};

/** 每列最小宽度（px）：修改时间 72（短日期可读），其余 68。 */
export const COLUMN_MIN_WIDTHS: Record<SftpColumn, number> = {
  size: 68,
  modified: 72,
  owner: 68,
  group: 68,
  permissions: 68,
};
export const COLUMN_WIDTH_MAX = 400;

/** 名称列最小宽度（px）：中文文件名不折叠/省略的下限。 */
export const NAME_COLUMN_MIN = 90;
/** 名称列最大宽度（px）。 */
export const NAME_COLUMN_MAX = 600;

export function sanitizeVisibleColumns(value: unknown): SftpColumn[] {
  if (!Array.isArray(value)) return [...DEFAULT_VISIBLE_COLUMNS];
  const columns = value.filter(
    (column): column is SftpColumn =>
      typeof column === "string" && (KNOWN_COLUMNS as readonly string[]).includes(column),
  );
  return columns.length > 0 ? columns : [...DEFAULT_VISIBLE_COLUMNS];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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
      owner: optionalString(record.owner),
      group: optionalString(record.group),
      lossy: record.lossy === true ? true : undefined,
    });
  }
  return entries;
}
