/**
 * Docker 容器文件（`docker/files/list` / `docker/files/read`，B4 只读）的
 * 纯函数半：路径归一/父目录/拼接、大小格式化、目录项排序、响应归一化与
 * base64 解码。组件（`DockerFilesPane.vue`）只负责渲染与调用 RPC。
 *
 * 与 sidecar 的契约（docs/PROTOCOL.zh-CN.md「Docker 管理面板」）：
 * list → `{path, entries: [{name, path, kind, size}], truncated}`，
 * kind 为 `"file" | "dir" | "link" | "other"`，`size` 仅普通文件有效；
 * read → `{path, dataBase64, size, truncated}`，`size` 是文件总字节数，
 * `dataBase64` 是前 `min(size, maxBytes)` 字节。
 *
 * 路径安全由 sidecar 负责（绝对路径、无 NUL/控制字符、≤4096、无 `.`/`..`
 * 段）；这里只做展示层的轻量归一，不替代后端校验。
 */

export type DockerFileKind = "file" | "dir" | "link" | "other";

export interface DockerFileEntry {
  name: string;
  path: string;
  kind: DockerFileKind;
  size: number;
}

export interface DockerFilesListing {
  path: string;
  entries: DockerFileEntry[];
  truncated: boolean;
}

export interface DockerFileContent {
  path: string;
  dataBase64: string;
  size: number;
  truncated: boolean;
}

/** 与 sidecar `FILES_LIST_MAX_ENTRIES` 同值。 */
export const DOCKER_FILES_MAX_ENTRIES = 500;
/** 与 sidecar `FILES_READ_DEFAULT_BYTES` 同值。 */
export const DOCKER_FILES_DEFAULT_MAX_BYTES = 1024 * 1024;
/** 与 sidecar `FILES_READ_MAX_BYTES` 同值。 */
export const DOCKER_FILES_MAX_BYTES = 8 * 1024 * 1024;

const KINDS: readonly DockerFileKind[] = ["file", "dir", "link", "other"];

/** 展示层路径归一：去空白、补前导 `/`、去尾部 `/`（根保留）。 */
export function normalizeDockerFilePath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed) return "/";
  const withRoot = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withRoot.length > 1 ? withRoot.replace(/\/+$/, "") || "/" : withRoot;
}

/** 父目录；根目录的父目录仍是根。 */
export function parentDockerPath(path: string): string {
  const normalized = normalizeDockerFilePath(path);
  if (normalized === "/") return "/";
  const cut = normalized.lastIndexOf("/");
  if (cut <= 0) return "/";
  return normalized.slice(0, cut);
}

/** 目录 + 名字拼接（名字里的 `/` 只保留最后一段）。 */
export function joinDockerPath(dir: string, name: string): string {
  const base = normalizeDockerFilePath(dir);
  const leaf = String(name ?? "").split("/").filter(Boolean).pop() ?? "";
  if (!leaf) return base;
  return base === "/" ? `/${leaf}` : `${base}/${leaf}`;
}

/** 隐藏项：以 `.` 开头（`.`/`..` 不会成为目录项）。 */
export function isHiddenDockerName(name: string): boolean {
  return String(name ?? "").startsWith(".");
}

/**
 * 目录内本地搜索：空白分词 AND、大小写不敏感的名称子串。
 * 空查询返回浅拷贝（调用方可继续叠加隐藏项过滤而不改输入）。
 * 只搜名称：容器里的完整路径由当前目录决定，把父路径放进匹配只会重复命中。
 */
export function filterDockerFileEntries<T extends { name: string }>(
  entries: readonly T[],
  query: string,
): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...entries];
  return entries.filter((entry) => {
    const name = entry.name.toLowerCase();
    return tokens.every((token) => name.includes(token));
  });
}

/** 人类可读大小（IEC，1024 进制；B 不带小数）。 */
export function formatFileSize(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

function kindRank(kind: DockerFileKind): number {
  if (kind === "dir") return 0;
  if (kind === "file") return 1;
  if (kind === "link") return 2;
  return 3;
}

/** 排序：目录优先，其次按名字（大小写不敏感的自然序）。 */
export function sortFileEntries(entries: readonly DockerFileEntry[]): DockerFileEntry[] {
  return [...entries].sort((left, right) => {
    const rank = kindRank(left.kind) - kindRank(right.kind);
    if (rank !== 0) return rank;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function asKind(value: unknown): DockerFileKind {
  return KINDS.includes(value as DockerFileKind) ? (value as DockerFileKind) : "other";
}

function asSize(value: unknown): number {
  const size = typeof value === "number" ? value : Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
}

/** 归一 sidecar 的 list 响应；畸形条目丢弃，最多保留 500 条。 */
export function parseDockerFilesListing(payload: unknown): DockerFilesListing {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const path = normalizeDockerFilePath(typeof record.path === "string" ? record.path : "/");
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries: DockerFileEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name || name.includes("/")) continue;
    const kind = asKind(item.kind);
    entries.push({
      name,
      path: normalizeDockerFilePath(
        typeof item.path === "string" && item.path ? item.path : joinDockerPath(path, name),
      ),
      kind,
      size: kind === "file" ? asSize(item.size) : 0,
    });
    if (entries.length >= DOCKER_FILES_MAX_ENTRIES) break;
  }
  return {
    path,
    entries: sortFileEntries(entries),
    truncated: record.truncated === true || rawEntries.length > DOCKER_FILES_MAX_ENTRIES,
  };
}

/** 归一 sidecar 的 read 响应；缺失字段按空/0 处理。 */
export function parseDockerFileContent(payload: unknown): DockerFileContent {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    path: normalizeDockerFilePath(typeof record.path === "string" ? record.path : "/"),
    dataBase64: typeof record.dataBase64 === "string" ? record.dataBase64 : "",
    size: asSize(record.size),
    truncated: record.truncated === true,
  };
}

/** base64 → 字节；非法 base64 返回空数组（调用方按不可预览处理）。 */
export function decodeBase64Bytes(dataBase64: string): Uint8Array {
  try {
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

/**
 * 文本预览解码：含 NUL 或非法 UTF-8 时返回 null（二进制文件）。
 * `maxChars` 防止把 8 MiB 文本整段塞进 DOM。
 */
export function decodeFileText(bytes: Uint8Array, maxChars = 200_000): string | null {
  if (bytes.some((byte) => byte === 0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return null;
  }
}

/** 与 sidecar `FILES_WRITE_MAX_BYTES` 同值（解码后 64 KiB）。 */
export const DOCKER_FILES_WRITE_MAX_BYTES = 64 * 1024;

/** UTF-8 文本 → 标准 base64（保存预览编辑器用）。 */
export function encodeFileText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** UTF-8 字节数（保存前对照 64 KiB 上限，不依赖 base64 长度）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// —— 覆盖 / 递归删除确认状态机（B6）——————————————————————
//
// 纯状态机：组件只负责把 `request` 变成 RPC、把 `prompt` 渲染成确认条。
// 规则：
// - 写：目标不存在直接执行；已存在先弹「覆盖」确认，确认后才带
//   `overwrite: true`。
// - 删：无论文件还是目录都二次确认（破坏性），目录带 `recursive: true`。
// - `busy` 期间的新请求一律忽略，避免双击提交两次写/删。

export interface DockerMutationRequest {
  kind: "write" | "delete";
  path: string;
  overwrite: boolean;
  recursive: boolean;
}

export interface DockerMutationState {
  pending: DockerMutationRequest | null;
  busy: boolean;
}

export interface DockerMutationStep {
  state: DockerMutationState;
  /** 立即执行的请求（无需再确认）。 */
  request: DockerMutationRequest | null;
  /** 需要用户确认的请求（渲染确认条，确认后走 `confirmDockerMutation`）。 */
  prompt: DockerMutationRequest | null;
}

export function initialDockerMutation(): DockerMutationState {
  return { pending: null, busy: false };
}

const idle: DockerMutationStep = {
  state: { pending: null, busy: false },
  request: null,
  prompt: null,
};

function ignored(state: DockerMutationState): DockerMutationStep {
  return { state, request: null, prompt: null };
}

/** 保存草稿：已存在 → 覆盖确认；不存在 → 直接写。 */
export function requestDockerWrite(
  state: DockerMutationState,
  path: string,
  exists: boolean,
): DockerMutationStep {
  if (state.busy || state.pending) return ignored(state);
  if (!exists) {
    return {
      state: { pending: null, busy: true },
      request: { kind: "write", path, overwrite: false, recursive: false },
      prompt: null,
    };
  }
  const prompt: DockerMutationRequest = { kind: "write", path, overwrite: true, recursive: false };
  return { state: { pending: prompt, busy: false }, request: null, prompt };
}

/** 删除：一律二次确认；目录同时带递归标记。 */
export function requestDockerDelete(
  state: DockerMutationState,
  path: string,
  recursive: boolean,
): DockerMutationStep {
  if (state.busy || state.pending) return ignored(state);
  const prompt: DockerMutationRequest = { kind: "delete", path, overwrite: false, recursive };
  return { state: { pending: prompt, busy: false }, request: null, prompt };
}

/** 确认/取消当前确认条；确认后返回可执行请求并置 busy。 */
export function confirmDockerMutation(
  state: DockerMutationState,
  accepted: boolean,
): DockerMutationStep {
  if (!state.pending) return { state, request: null, prompt: null };
  if (!accepted) return idle;
  return {
    state: { pending: null, busy: true },
    request: state.pending,
    prompt: null,
  };
}

/** RPC 结束后回到空闲态（成功或失败都调用）。 */
export function settleDockerMutation(): DockerMutationStep {
  return idle;
}

