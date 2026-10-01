// 终端输出脱敏与截断（Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL §4.3）：
// AI 修复/唤起助手把终端内容发给宿主 AI 面板前必须经过本模块——任何路径
// 不得绕过（隐私红线：远端输出出境是敏感动作）。纯函数，可完整单测。

/** 截断常量：尾部 200 行 / 16 KiB（错误摘要多在尾部，取尾部）。 */
export const AI_OUTPUT_MAX_LINES = 200;
export const AI_OUTPUT_MAX_CHARS = 16 * 1024;

/** 尾部截断：先按行取尾 200 行，再按字符取尾 16 KiB（行界优先，语义可读）。 */
export function truncateTail(text: string, maxLines = AI_OUTPUT_MAX_LINES, maxChars = AI_OUTPUT_MAX_CHARS): string {
  if (!text) return "";
  const lines = text.split("\n");
  const byLines = (lines.length > maxLines ? lines.slice(-maxLines) : lines).join("\n");
  return byLines.length > maxChars ? byLines.slice(-maxChars) : byLines;
}

/**
 * 脱敏规则面（保守集合，宁可漏替不可误伤命令语义）。每条 [正则, 替换]：
 * - 键值对类保留键名与分隔符（AI 仍能理解字段语义），只抹值；
 * - 独立令牌类（Bearer/AKIA/GitHub/OpenAI/Slack/PEM）整段抹掉；
 * - URL 内嵌凭据保留 scheme，抹 user:pass。
 * 刻意不覆盖 `mysql -ppass` 式短选项（与 find -print 等无法区分）——
 * 由 AI 修复的首次快照预览确认兜底。替换为 ***；幂等（*** 不再命中）。
 */
const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b([a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key))(["']?)\s*([=:])(\s*)("?)\S[^\s"']*\5/gi, "$1$2$3$4***"],
  [/\bBearer\s+\S+/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
  [/\b(?:ghp_|gho_|ghu_|ghs_)[A-Za-z0-9]{30,}\b/g, "***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "***"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***"],
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s:@/]+:[^\s@/]+@/gi, "$1://***@"],
];

/** 脱敏：按规则表顺序全局替换。 */
export function redactTerminalOutput(text: string): string {
  if (!text) return "";
  let out = text;
  for (const [pattern, replacement] of REDACTION_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** 组合管线：先截断（减少脱敏面）再脱敏——AI 快照的唯一入口。 */
export function prepareAiOutputSnapshot(text: string): string {
  return redactTerminalOutput(truncateTail(text));
}

/**
 * 剥离 ANSI 转义（采集缓冲的入口净化）：OSC 响（\x1b]…\x07 或 \x1b]…\x1b\\，
 * 含 shell integration 的 633 帧噪声）与 CSI 序列在快照里对 AI 是乱码噪声，
 * 捕获时一并剥掉；\r 回车符折叠掉（CRLF 输出行界归一）。
 */
export function stripAnsiEscapes(text: string): string {
  if (!text) return "";
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
}
