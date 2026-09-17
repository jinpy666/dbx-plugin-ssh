// 告警分诊（alert triage）前端契约：类型 + 纯函数，零 UI 依赖。
// 协议来源：ssh/docs/IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT.zh-CN.md §2.4。
// 后端 `ssh/alert/triage` 负责结构化、分类与白名单命令建议；本模块只做
// 展示侧归一（payload 预处理、severity 分级、purposeKey → i18n 映射），
// 不做分类推理。

/** 分诊分类枚举，与后端 category 协议值钉死。 */
export type TriageCategory = "cpu" | "memory" | "disk" | "inode" | "network" | "oom" | "service" | "generic";

/** severity 展示分级（着色用）。 */
export type TriageSeverityClass = "critical" | "warning" | "info" | "unknown";

/** 后端建议的单条只读诊断命令；purposeKey 为稳定 key，展示文案走 i18n。 */
export interface TriageSuggestion {
  command: string;
  purposeKey: string;
}

/** `ssh/alert/triage` 响应中的 normalized 结构（协议 §2.4）。 */
export interface NormalizedAlert {
  alertId: string;
  title: string;
  message: string;
  severity: string;
  source: string;
  dataJson: string;
}

/** `ssh/alert/triage` 响应整体。 */
export interface TriageResult {
  normalized: NormalizedAlert;
  category: TriageCategory;
  suggestions: TriageSuggestion[];
}

/** 分诊请求 payload 上限：64 KiB；超出部分截断（后端另有长文本钳制，同向收敛）。 */
export const TRIAGE_PAYLOAD_LIMIT = 64 * 1024;

/** trim 首尾空白后超 64 KiB 截断；空串由调用方判定为 invalidPayload。 */
export function sanitizeTriagePayload(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > TRIAGE_PAYLOAD_LIMIT ? trimmed.slice(0, TRIAGE_PAYLOAD_LIMIT) : trimmed;
}

/**
 * severity 展示分级（大小写不敏感，容忍首尾空白）：
 * critical/fatal→critical；warning/warn→warning；info/notice→info；其余→unknown。
 */
export function severityClass(severity: string): TriageSeverityClass {
  switch (severity.trim().toLowerCase()) {
    case "critical":
    case "fatal":
      return "critical";
    case "warning":
    case "warn":
      return "warning";
    case "info":
    case "notice":
      return "info";
    default:
      return "unknown";
  }
}

/**
 * purposeKey 稳定 key 集合（与后端 playbook 契约钉死）；缺后端命令时
 * 多余 key 无害。全部同构映射为 `alertTriage.purpose.<purposeKey>`。
 */
const TRIAGE_PURPOSE_KEYS = [
  "loadSnapshot",
  "cpuTop",
  "cpuTopProcesses",
  "cpuVmstat",
  "memFree",
  "memTopProcesses",
  "diskUsage",
  "diskDu",
  "diskInode",
  "netSummary",
  "netLinks",
  "oomDmesg",
  "oomJournal",
  "serviceStatus",
  "serviceJournal",
] as const;

/** purposeKey → i18n key 查表（同构映射）。 */
export const PURPOSE_KEY_TO_I18N: Readonly<Record<string, string>> = Object.fromEntries(
  TRIAGE_PURPOSE_KEYS.map((key) => [key, `alertTriage.purpose.${key}`]),
);

/**
 * purposeKey 展示文案：查表命中返回 `t(i18nKey)`；未命中回退 purposeKey 原文
 * （后端新增 key 而前端未跟进时的降级路径，不显示破损 UI）。
 */
export function purposeKeyLabel(purposeKey: string, t: (key: string) => string): string {
  const i18nKey = PURPOSE_KEY_TO_I18N[purposeKey];
  return i18nKey ? t(i18nKey) : purposeKey;
}
