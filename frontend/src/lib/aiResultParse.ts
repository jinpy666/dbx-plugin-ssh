// AI 单命令输出的解析与确认弹窗排版（AI 体验改造 v2，IMPL_PLAN_WARP_AI_TERMINAL
// §3/§4 跟进）：`#` 命令搜索与失败修复的直连生成共用同一输出契约——prompt 钉
// 「首行 = 精确命令；随后一行 Why: 理由」，这里把纯文本结果解析成命令行 + Why 行，
// 并排成确认弹窗的分行纯文本（命令行突出、Why 次行、确认问题收尾）。解析失败
// （首行为空）返回 null，调用方按异常回退，不猜测不拼接。纯函数，不触终端。

/** AI 输出契约里的 Why 标记（英文钉死在 prompt 模板里，属协议面非 UI 文案）。 */
export const AI_RESULT_WHY_PREFIX = "Why:";

export interface AiResultLines {
  /** 首行精确命令（已 trim；调用方只回填它，永不自动执行）。 */
  command: string;
  /** "Why: …" 说明行（原样保留标记）；缺失为空串——展示退化为仅命令行。 */
  why: string;
}

/**
 * 解析生成结果为「命令 + Why」：
 * - 标准两行 → { command, why }；
 * - 只有一行（模型没给 Why）→ { command, why: "" }；
 * - 空串/首行为空 → null（调用方回退面板会话或提示）。
 * CRLF 与首行前导空白都归一；Why 行按标记匹配，其余行忽略（模型偶尔多话不污染回填）。
 */
export function parseAiResultText(raw: string): AiResultLines | null {
  const lines = raw.split("\n");
  const command = (lines[0] ?? "").trim();
  if (!command) return null;
  const why = lines
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith(AI_RESULT_WHY_PREFIX));
  return { command, why: why ?? "" };
}

export interface AiResultFormatOptions {
  /** 命令行前置标签（七语文案，如「命令：」）；缺省则命令行裸排（首行即命令）。 */
  commandLabel?: string;
  /** 收尾的确认问题（七语，aiSearch.fillConfirm / aiFix.fillConfirm）。 */
  fillConfirm: string;
}

/**
 * 排成确认弹窗的分行纯文本：命令行（可带标签）→ 空行 → Why 行（有则排）→
 * 空行 → 确认问题。解析失败（null）不由这里兜底——调用方在解析处分流。
 */
export function formatAiResultConfirmation(parsed: AiResultLines, options: AiResultFormatOptions): string {
  const parts = [options.commandLabel ? `${options.commandLabel} ${parsed.command}` : parsed.command];
  if (parsed.why) parts.push(parsed.why);
  return `${parts.join("\n\n")}\n\n${options.fillConfirm}`;
}
