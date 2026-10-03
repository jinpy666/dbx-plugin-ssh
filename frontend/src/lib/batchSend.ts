/**
 * 批量发送（对标 tiny-rdm batch send）：把同一条命令写入多个已打开会话的
 * 交互终端（PTY 键盘语义，输出回显在各自终端）。本模块只做目标归一/选择与
 * 逐会话发送结果汇总，RPC 调用留在 App.vue。
 */

export interface BatchSendTarget {
  sessionId: string;
  connectionId: string;
  /** 本地终端会话（local/session/list）：无 connectionId，发送走本地 PTY 通道。 */
  local?: boolean;
  workbenchId?: string;
  connected?: boolean;
  readOnly?: boolean;
  /** 只读展示字段（ssh/sessions/list 行，连接不在注册表时为空）。 */
  host?: string;
  port?: number;
  username?: string;
  createdAt?: number;
  /** 连接显示名（host.listConnections 实时读数，issue #10232）：终端改名后
   * 无需重连即随下一次目标刷新生效；宿主缺该扩展点时缺省，标签回退 user@host。 */
  name?: string;
}

export interface BatchSendResultRow {
  sessionId: string;
  success: boolean;
  error?: string;
}

export interface BatchSendSummary {
  rows: BatchSendResultRow[];
  sent: number;
  failed: number;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value || undefined;
}

function optionalBool(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 归一 `ssh/sessions/list` 返回：非法行丢弃、按 id 去重，保持后端 createdAt 升序。 */
export function normalizeBatchTargets(raw: unknown): BatchSendTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const targets: BatchSendTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const sessionId = stringField(record, "sessionId");
    const connectionId = stringField(record, "connectionId");
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    targets.push({
      sessionId,
      connectionId,
      workbenchId: optionalString(record, "workbenchId"),
      connected: optionalBool(record, "connected"),
      readOnly: optionalBool(record, "readOnly"),
      host: optionalString(record, "host"),
      port: optionalNumber(record, "port"),
      username: optionalString(record, "username"),
      createdAt: optionalNumber(record, "createdAt"),
    });
  }
  return targets;
}

/**
 * 归一 `local/session/list` 返回为批量目标：本地 shell 与 SSH 会话同一发送语义
 * （向 PTY 键盘写入），connectionId 留空、行标签用 `Local · <shell>`。
 */
export function normalizeLocalBatchTargets(raw: unknown): BatchSendTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const targets: BatchSendTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const sessionId = stringField(record, "sessionId");
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const shell = stringField(record, "shell") || "shell";
    targets.push({
      sessionId,
      connectionId: "",
      local: true,
      host: `Local · ${shell.split(/[\\/]/).pop() || shell}`,
    });
  }
  return targets;
}

/** 目标行主标签：连接名优先（终端改名后批量目标同步显示新名，issue #10232），
 * 未命名回退 `user@host`，连接信息缺失再回退短 session id。 */
export function batchTargetLabel(target: BatchSendTarget): string {
  const name = target.name?.trim();
  if (name) return name;
  const host = target.host?.trim();
  if (!host) return target.sessionId.slice(0, 8);
  const user = target.username?.trim();
  return user ? `${user}@${host}` : host;
}

/**
 * 宿主连接名覆盖（issue #10232）：把 `host.listConnections` 的实时连接名按
 * connectionId 叠加到批量目标上——宿主连接表是唯一随改名即时更新的数据源
 * （sidecar 的会话行只有连接时的 user@host，宿主改名也不重推）。响应形状双
 * 兼容：真实宿主桥返回数组，插件内 mock 走 `{ connections: [...] }` 包装。
 * 纯函数：非法行丢弃、空白名称视为未命名；本地终端目标无 connectionId 不受影响。
 */
export function applyConnectionNames(targets: BatchSendTarget[], raw: unknown): BatchSendTarget[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).connections)
      ? ((raw as Record<string, unknown>).connections as unknown[])
      : [];
  const names = new Map<string, string>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (id && name) names.set(id, name);
  }
  if (!names.size) return targets;
  return targets.map((target) => {
    const name = target.connectionId ? names.get(target.connectionId) : undefined;
    return name ? { ...target, name } : target;
  });
}

/** 多选切换；已选中则移除，未选中则追加。 */
export function toggleBatchTarget(selected: string[], sessionId: string): string[] {
  return selected.includes(sessionId)
    ? selected.filter((id) => id !== sessionId)
    : [...selected, sessionId];
}

/** 快捷选择：all=全部目标，connected=仅存活会话（tiny-rdm All/Active）。 */
export function selectBatchTargets(targets: BatchSendTarget[], mode: "all" | "connected"): string[] {
  return targets
    .filter((target) => (mode === "connected" ? target.connected !== false : true))
    .map((target) => target.sessionId);
}

/** 汇总 `ssh/terminal/batchInput` 的 results：计数 + 归一后的逐行结果。 */
export function summarizeBatchResults(raw: unknown): BatchSendSummary {
  const rows: BatchSendResultRow[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const sessionId = stringField(record, "sessionId");
      if (!sessionId) continue;
      rows.push({
        sessionId,
        success: record.success === true,
        error: optionalString(record, "error"),
      });
    }
  }
  return {
    rows,
    sent: rows.filter((row) => row.success).length,
    failed: rows.filter((row) => !row.success).length,
  };
}

/** 命令条保存快速命令时的默认名称：压平空白后截断（超长以省略号收尾）。 */
export function deriveBatchCommandName(command: string, maxLength = 30): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** 命令条下拉切换：按 id 取快速命令文本；未知 id 返回空串（保持原输入）。 */
export function quickPickCommandById(commands: { id: string; command: string }[], id: string): string {
  return commands.find((item) => item.id === id)?.command ?? "";
}
