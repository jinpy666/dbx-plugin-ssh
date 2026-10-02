// 失败命令 AI 修复的触发判定（Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL §4）：
// 非零退出码 ≠ 都值得修——test/grep/diff 这类命令的「非零」是语义的一部分
// （条件判断、无匹配），为它们弹修复条是噪音。首版用首词豁免表，实机调参
// 后再扩。纯函数，可完整单测。

/** 非零退出码属预期语义的命令首词（含 `[` 测试运算符）；kill -0 走前缀特判。 */
const EXPECTED_NON_ZERO_COMMANDS: ReadonlySet<string> = new Set([
  "test",
  "[",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "diff",
  "cmp",
  "which",
  "type",
  "command",
  "hash",
]);

/** 取命令首词：剥掉环境变量前缀（FOO=bar cmd）与 sudo/nohup 等包装。 */
export function firstCommandWord(command: string): string {
  const words = command.trim().split(/\s+/);
  let rest = words;
  while (rest.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
  for (const wrapper of ["sudo", "nohup", "env", "nice", "stdbuf", "timeout"]) {
    if (rest[0] === wrapper) rest = rest.slice(1);
  }
  return rest[0] ?? "";
}

/** 该失败是否为预期语义（true = 不出修复条）。kill -0 特判：探活语义。 */
export function isExpectedNonZeroExit(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/^kill\s+-0(\s|$)/.test(trimmed)) return true;
  return EXPECTED_NON_ZERO_COMMANDS.has(firstCommandWord(trimmed));
}

/** 修复条触发门（纯函数）：调用方逐项传入运行时状态。 */
export interface AiFixGates {
  bridgeAvailable: boolean;
  fixEnabled: boolean;
  alternateActive: boolean;
}

export function shouldOfferAiFix(gates: AiFixGates, exitCode: number | null | undefined, command: string): boolean {
  if (typeof exitCode !== "number" || exitCode === 0) return false;
  if (!gates.bridgeAvailable || !gates.fixEnabled || gates.alternateActive) return false;
  return !isExpectedNonZeroExit(command);
}
