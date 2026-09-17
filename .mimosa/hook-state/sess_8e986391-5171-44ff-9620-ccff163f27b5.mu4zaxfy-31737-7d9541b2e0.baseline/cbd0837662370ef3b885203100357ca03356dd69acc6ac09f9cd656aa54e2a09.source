// 审计日志查看前端契约：类型 + 纯函数。
// 协议现实：`ssh/audit/list` 由并行批次的 MCP exec 审计落地（tsMs 毫秒 + tool +
// gate/approval/durationMs/connectionId，无 command 原文），本批计划 §1.1 的
// （ts 秒 + kind 判别 + command）形状为另一代契约。本模块对两形状都容忍：
// ts 取 `ts`‖`tsMs`（≥1e12 视为毫秒归一为秒）、kind 取 `kind`‖`tool`、
// connection 取 `connection`‖`connectionId`；展示顺序统一 newest-first 客户端
// 排序，不依赖后端行序；kind 过滤在客户端做（后端可能不认 `kind` 参数）。
// agent 面无审计工具，仅工作台读取。

/** `ssh/audit/list` 条目视图（全部字段可选，除 ts/kind 外都可能有缺省）。 */
export interface AuditEntry {
  /** 归一后的 Unix 秒（tsMs 毫秒输入已除以 1000）。 */
  ts: number;
  kind: string;
  tool?: string;
  gate?: string;
  connection?: string;
  sessionId?: string;
  command?: string;
  /** 命令输出尾部（后端截断 1024 字符；旧行/被拒行无此字段）。 */
  output?: string;
  decision?: string;
  /** 审批轨迹：none|prompt|approved|denied|timeout|remembered（并行批次形状）。 */
  approval?: string;
  sudo?: boolean;
  risk?: string;
  mode?: string;
  /** terminal.auto_sudo 的应答方式：password|otp（避免与行内 kind 撞名）。 */
  kind2?: string;
  deferred?: boolean;
  outcome?: string;
  exitCode?: number | null;
  durationMs?: number;
  error?: string;
}

/** 已知 kind → i18n key 查表（`auditLog.kind.*` 组）；未知 kind 回退原文。
 *  `ssh_exec` / `ssh_exec_sudo` 是并行批次行的 tool 原名（kind 即 tool）。 */
export const AUDIT_KIND_TO_I18N: Readonly<Record<string, string>> = {
  "mcp.tool": "auditLog.kind.mcpTool",
  "mcp.gate": "auditLog.kind.mcpGate",
  "exec": "auditLog.kind.exec",
  "ssh_exec": "auditLog.kind.exec",
  "ssh_exec_sudo": "auditLog.kind.execSudo",
  "agent.challenge": "auditLog.kind.agentChallenge",
  "terminal.auto_sudo": "auditLog.kind.autoSudo",
};

/** kind 展示文案：查表命中走 i18n，未知 kind 回退原文（不显示破损 UI）。 */
export function auditKindLabel(kind: string, t: (key: string) => string): string {
  const i18nKey = AUDIT_KIND_TO_I18N[kind];
  return i18nKey ? t(i18nKey) : kind;
}

/** 过滤下拉选项：当前条目里出现过的 kind，去重并按字典序稳定输出。 */
export function auditKindOptions(entries: readonly AuditEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.kind))].sort((a, b) => a.localeCompare(b));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 时间戳归一为 Unix 秒：≥1e12 视为毫秒，其余按秒；非法/非正数返回 null。 */
function timestampSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

/** 防御上限：超长回传先截断再排序，避免病态载荷拖垮设置弹窗。 */
const SANITIZE_INPUT_CAP = 2000;

/**
 * 归一 `ssh/audit/list` 回传条目：缺时间戳或缺 kind/tool 的条目丢弃、字段类型
 * 收紧，统一按 ts 降序（newest-first）输出，`limit` 截取最新 N 条。
 */
export function sanitizeAuditEntries(raw: unknown, limit = 200): AuditEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AuditEntry[] = [];
  for (const item of raw.slice(0, SANITIZE_INPUT_CAP)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const ts = timestampSeconds(record.ts ?? record.tsMs);
    const kind = optionalString(record.kind) ?? optionalString(record.tool);
    if (ts === null || !kind) continue;
    const entry: AuditEntry = { ts, kind };
    const tool = optionalString(record.tool);
    if (tool !== undefined) entry.tool = tool;
    const optionalStrings = ["gate", "sessionId", "command", "output", "decision", "approval", "risk", "mode", "kind2", "outcome", "error"] as const;
    for (const field of optionalStrings) {
      const value = optionalString(record[field]);
      if (value !== undefined) entry[field] = value;
    }
    const connection = optionalString(record.connection) ?? optionalString(record.connectionId);
    if (connection !== undefined) entry.connection = connection;
    if (record.sudo === true) entry.sudo = true;
    if (record.deferred === true) entry.deferred = true;
    const exitCode = finiteNumber(record.exitCode);
    if (exitCode !== null) entry.exitCode = exitCode;
    const durationMs = finiteNumber(record.durationMs);
    if (durationMs !== null) entry.durationMs = durationMs;
    out.push(entry);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, Math.max(0, limit));
}

/**
 * 结果列文案决策：outcome 优先（ok/error），agent.challenge 的 decision
 * （issued/approved/denied/timeout）次之，auto-sudo 的 kind2（password/otp）
 * 兜底；都缺返回空串（列隐藏）。
 */
export function auditOutcomeLabel(entry: AuditEntry, t: (key: string) => string): string {
  if (entry.outcome === "ok") return t("auditLog.outcomeOk");
  if (entry.outcome === "error") return t("auditLog.outcomeError");
  if (entry.decision) return entry.decision;
  if (entry.kind2) return entry.kind2;
  return "";
}
