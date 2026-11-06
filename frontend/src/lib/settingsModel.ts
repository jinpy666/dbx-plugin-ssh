// 设置域共享模型（App.vue 抽出 SettingsDialog.vue 时下沉）：sidecar 返回的
// 设置/配置档/已知主机/本机密钥/MCP 限速结构，与纯格式化助手。字段与
// docs/PROTOCOL.zh-CN.md 的 ssh/settings、sudo/profiles、ssh/knownHosts、
// keys/discover、mcp/settings 各节一致。

import { pluginStore } from "./pluginStore";

export const MIB = 1024 * 1024;

/**
 * MiB 输入框回填。整数 MiB 原样显示，亚 MiB 值保留小数：读取上限默认 256
 * KiB（0.25 MiB），若四舍五入成整数会显示为 0 并被表单判为非法，导致整段
 * MCP 尺寸永远保存不了（issue #241）。
 */
export function mibField(bytes?: number) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  return String(Number((bytes / MIB).toFixed(6)));
}

/** 与 sidecar `McpLimits` 的上限一致（backend/src/mcp.rs 的三个 *_CEILING）。 */
export const MCP_LIMIT_CEILING_MIB = { read: 8, upload: 2048, download: 2048 } as const;

/**
 * 解析 MiB 输入框。正数（允许最多 6 位小数）且不超过该字段上限时返回字节数，
 * 否则返回 null——与 sidecar `validated_limit` 的 1..ceiling 语义对齐，把越界
 * 值挡在提交前，避免 RPC 报错后表单看起来"保存成功又还原"。
 */
export function parseMibInput(value: string | number, ceilingMib: number): number | null {
  // `<input type="number">` 的 v-model 会把用户输入转成 number，因此这里同时
  // 接受两种形状；先归一成字符串再走同一套语法校验。
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const mib = Number.parseFloat(text);
  if (!Number.isFinite(mib) || mib <= 0 || mib > ceilingMib) return null;
  return Math.max(1, Math.round(mib * MIB));
}

export function settingsErrorOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 文件浏览：双击 SFTP 文件的行为（preview=预览，默认 / edit=直接进编辑态）。 */
export type SftpDoubleClickAction = "preview" | "edit";

export const SFTP_DOUBLE_CLICK_ACTIONS: SftpDoubleClickAction[] = ["preview", "edit"];

/** pluginStore 容错解析：仅 "edit" 视为编辑，其余（含缺键）回落预览。 */
export function parseSftpDoubleClickAction(value: string | null | undefined): SftpDoubleClickAction {
  return value === "edit" ? "edit" : "preview";
}

export interface SshSettings {
  quickSudo: boolean;
  sudoUsePty: boolean;
  sudoPasswordSet: boolean;
  totpConfigured: boolean;
  authFlowMode: string;
  passwordPromptHint: string;
  totpPromptHint: string;
  // revealSecrets: true 时回显的本连接原始凭据（设置弹窗预填用）。
  sudoPassword?: string;
  totpSecret?: string;
  // 全局 quick sudo 配置来源（空串 = 使用本连接自己的凭据）。
  quickSudoProfileId?: string;
  quickSudoProfileName?: string;
  // AI 终端同步执行模式（连接级；off 默认 / auto 分级 / strict 全审）。
  agentTerminalMode?: string;
  // 已记住的免审批命令（连接级原始行，sudoers 式 token 语义）。
  rememberedCommands?: string[];
}

// 全局 quick sudo 配置视图：密钥永不回显，只有已设置布尔位。
export interface SudoProfileView {
  id: string;
  name: string;
  sudoPasswordSet: boolean;
  totpConfigured: boolean;
  authFlowMode: string;
  passwordPromptHint: string;
  totpPromptHint: string;
  sudoUsePty: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface KnownHostEntry {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export interface DiscoveredKey {
  path: string;
  algorithm: string;
  fingerprint: string;
  // The protocol doc names this field `hasPassphrase`; the current sidecar
  // serializes Rust's snake_case `has_passphrase`. Accept both spellings.
  hasPassphrase?: boolean;
  has_passphrase?: boolean;
}

export interface McpSizeSettings {
  maxReadBytes?: number;
  maxUploadBytes?: number;
  maxDownloadBytes?: number;
  // §1.3 MCP 权限档与连接作用域（新字段，旧 sidecar 不回即用默认值）。
  execPermissionMode?: string;
  connectionScope?: string[];
}

// ---------------------------------------------------------------------------
// MCP 设置镜像（存储迁移批 1 收尾，IMPL_PLAN_STORAGE_SYNC）：sidecar 在 MCP
// serve 时仍直接消费 mcp-settings.json，本镜像只做「云同步载荷」——保存时
// 双写（RPC + pluginStore），启动时播种（store 缺失）或收敛（store → sidecar，
// 消化云同步恢复）。只镜像五个可同步字段；localTransferRoot 是设备本地路径，
// 依赖 sidecar `mcp/settings/set` 的部分更新语义保留，不进镜像。
// ---------------------------------------------------------------------------

export const MCP_SETTINGS_STORE_KEY = "ssh-mcp-settings";

export interface McpSettingsMirror {
  maxReadBytes: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
  execPermissionMode: string;
  connectionScope: string[];
}

/** 与 sidecar McpLimits::default 一致：get 载荷字段缺失时的兜底。 */
const MCP_DEFAULT_LIMITS = { maxReadBytes: 256 * 1024, maxUploadBytes: 16 * 1024 * 1024, maxDownloadBytes: 1024 * 1024 } as const;

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function scopeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

/**
 * 从 `mcp/settings/get` 载荷提取可同步子集。权限字段优先取 `persisted*`：
 * `execPermissionMode`/`connectionScope` 是**生效值**（进程环境变量可覆盖），
 * 回推会把环境覆盖误写成持久值；旧 sidecar 无 `persisted*` 时回退生效值。
 */
export function extractMcpSettingsMirror(payload: unknown): McpSettingsMirror {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    maxReadBytes: positiveIntOr(record.maxReadBytes, MCP_DEFAULT_LIMITS.maxReadBytes),
    maxUploadBytes: positiveIntOr(record.maxUploadBytes, MCP_DEFAULT_LIMITS.maxUploadBytes),
    maxDownloadBytes: positiveIntOr(record.maxDownloadBytes, MCP_DEFAULT_LIMITS.maxDownloadBytes),
    execPermissionMode:
      typeof record.persistedExecPermissionMode === "string" && record.persistedExecPermissionMode
        ? record.persistedExecPermissionMode
        : typeof record.execPermissionMode === "string" && record.execPermissionMode
          ? record.execPermissionMode
          : "autonomous",
    connectionScope: Array.isArray(record.persistedConnectionScope)
      ? scopeList(record.persistedConnectionScope)
      : scopeList(record.connectionScope),
  };
}

/** 读回消毒：非法形状逐字段回默认/空表（镜像可自愈，无需区分坏档）。 */
function sanitizeMcpSettingsMirror(raw: unknown): McpSettingsMirror {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    maxReadBytes: positiveIntOr(record.maxReadBytes, MCP_DEFAULT_LIMITS.maxReadBytes),
    maxUploadBytes: positiveIntOr(record.maxUploadBytes, MCP_DEFAULT_LIMITS.maxUploadBytes),
    maxDownloadBytes: positiveIntOr(record.maxDownloadBytes, MCP_DEFAULT_LIMITS.maxDownloadBytes),
    execPermissionMode: record.execPermissionMode === "confirm" ? "confirm" : "autonomous",
    connectionScope: scopeList(record.connectionScope),
  };
}

/**
 * 从 pluginStore 读镜像；返回 null 表示键不存在（未播种）**或坏 JSON**——
 * 与批 1 权威数据不同，镜像可从 sidecar 自愈重播种，坏档不视为"已迁移"。
 */
export function loadMcpSettingsMirror(): McpSettingsMirror | null {
  try {
    const raw = pluginStore.getItem(MCP_SETTINGS_STORE_KEY);
    if (raw === null) return null;
    return sanitizeMcpSettingsMirror(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 全量写穿镜像（保存双写与启动播种共用）。 */
export function persistMcpSettingsMirror(mirror: McpSettingsMirror): void {
  try {
    pluginStore.setItem(MCP_SETTINGS_STORE_KEY, JSON.stringify(sanitizeMcpSettingsMirror(mirror)));
  } catch {
    // 持久化失败不阻断：镜像只是同步载荷，sidecar 文件仍是即时权威。
  }
}

/**
 * 镜像等值比较（启动收敛判定）：connectionScope 按**集合**比较（顺序不稳
 * 定不触发无谓回推），数值与权限档严格比较。
 */
export function mcpSettingsMirrorEquals(a: McpSettingsMirror, b: McpSettingsMirror): boolean {
  const canonical = (mirror: McpSettingsMirror) =>
    JSON.stringify({ ...mirror, connectionScope: [...mirror.connectionScope].sort() });
  return canonical(a) === canonical(b);
}
