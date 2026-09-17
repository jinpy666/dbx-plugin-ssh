/**
 * 批量发送（对标 tiny-rdm batch send）：把同一条命令写入多个已打开会话的
 * 交互终端（PTY 键盘语义，输出回显在各自终端）。本模块只做目标归一/选择与
 * 逐会话发送结果汇总，RPC 调用留在 App.vue。
 */

export interface BatchSendTarget {
  sessionId: string;
  connectionId: string;
  workbenchId?: string;
  connected?: boolean;
  readOnly?: boolean;
  /** 只读展示字段（ssh/sessions/list 行，连接不在注册表时为空）。 */
  host?: string;
  port?: number;
  username?: string;
  createdAt?: number;
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

/** 目标行主标签：`user@host`，缺连接信息时回退短 session id。 */
export function batchTargetLabel(target: BatchSendTarget): string {
  const host = target.host?.trim();
  if (!host) return target.sessionId.slice(0, 8);
  const user = target.username?.trim();
  return user ? `${user}@${host}` : host;
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
