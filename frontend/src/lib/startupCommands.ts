/**
 * 连接级启动命令（Tabby「Login scripts」对标，M7 P0-4）的表单语义。
 *
 * 权威存储在 sidecar `preferences.json` 的 `startup_commands` 键：
 * `{ <connectionId>: { enabled, commands: [{ command, delayMs, enabled }] } }`，
 * 本模块只做编辑器的归一化/合并纯逻辑（sidecar 同款上限：20 条、单条 4KiB、
 * 延迟 0..=30000ms 缺省 300ms）。命令在 shell 起来后按序注入，仅 SSH 交互
 * shell 会话生效；remote command（exec）会话被 sidecar 跳过。
 */

/** 每连接命令数上限（与 sidecar `startup_commands::MAX_COMMANDS` 一致）。 */
export const STARTUP_COMMAND_MAX = 20;
/** 缺省延迟毫秒（与 sidecar `DEFAULT_DELAY_MS` 一致）。 */
export const STARTUP_DELAY_DEFAULT_MS = 300;
/** 延迟上限毫秒（与 sidecar `MAX_DELAY_MS` 一致）。 */
export const STARTUP_DELAY_MAX_MS = 30_000;
/** 单条命令字节上限（与 sidecar `MAX_COMMAND_BYTES` 一致）。 */
export const STARTUP_COMMAND_MAX_BYTES = 4 * 1024;

export interface StartupCommandEntry {
  command: string;
  delayMs: number;
  enabled: boolean;
}

export interface StartupCommandsConfig {
  enabled: boolean;
  commands: StartupCommandEntry[];
}

/** UTF-8 字节长度（上限按字节口径，与 sidecar 对齐）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 按 UTF-8 字节上限截断，绝不在多字节字符中间劈开。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = new TextEncoder().encode(text);
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function clampDelay(raw: unknown): number {
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return STARTUP_DELAY_DEFAULT_MS;
  return Math.min(Math.trunc(value), STARTUP_DELAY_MAX_MS);
}

/** 编辑器内归一化单条命令：去结尾 CR/LF（注入自带回车）、字节截断、延迟钳制。 */
export function normalizeStartupEntry(raw: unknown): StartupCommandEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.command !== "string") return null;
  const command = truncateUtf8(record.command.replace(/[\r\n]+$/, ""), STARTUP_COMMAND_MAX_BYTES);
  if (command.trim().length === 0) return null;
  return {
    command,
    delayMs: clampDelay(record.delayMs),
    enabled: record.enabled !== false,
  };
}

/**
 * sidecar `startup_commands` 单连接桶 → 编辑器态。主开关缺省关
 * （「开关默认关」），非法行剔除、超限截断，重开弹窗回显无漂移。
 */
export function normalizeStartupConfig(raw: unknown): StartupCommandsConfig {
  if (!raw || typeof raw !== "object") return { enabled: false, commands: [] };
  const record = raw as Record<string, unknown>;
  const rows = Array.isArray(record.commands) ? record.commands : [];
  return {
    enabled: record.enabled === true,
    commands: rows
      .map(normalizeStartupEntry)
      .filter((entry): entry is StartupCommandEntry => entry !== null)
      .slice(0, STARTUP_COMMAND_MAX),
  };
}

/** 编辑器态 → `local/preferences/set` 的单连接桶载荷（与 sidecar 落盘形状一致）。 */
export function serializeStartupConfig(config: StartupCommandsConfig) {
  return {
    enabled: config.enabled === true,
    commands: config.commands.map((entry) => ({
      command: entry.command,
      delayMs: clampDelay(entry.delayMs),
      enabled: entry.enabled !== false,
    })),
  };
}

/**
 * 读改写合并：只替换本连接的桶，其他连接配置原样保留
 * （`local/preferences/set` 对 `startup_commands` 是整键替换，合并语义在客户端）。
 */
export function mergeStartupStore(
  store: unknown,
  connectionId: string,
  config: StartupCommandsConfig,
): Record<string, unknown> {
  const base = store && typeof store === "object" && !Array.isArray(store)
    ? { ...(store as Record<string, unknown>) }
    : {};
  base[connectionId] = serializeStartupConfig(config);
  return base;
}

/** 新增一行：启用、空命令、缺省延迟（用户填入命令后 @change 持久化）。 */
export function createStartupEntry(): StartupCommandEntry {
  return { command: "", delayMs: STARTUP_DELAY_DEFAULT_MS, enabled: true };
}
