// 终端交互提示守卫（issue #150 及其反馈扩展）：远端正在向用户**询问输入或
// 要求选择**时（MFA/验证码待码、Password/口令输入、选择菜单与 y/n 确认），
// ↑/↓ 本应留给远端交互（堡垒机选目标服务器/翻菜单），不再被本插件拦截去
// 唤起历史面板，键入应答也不弹出建议/ghost 浮层。本模块只做纯逻辑——行文
// 本判定、光标邻域采样与「交互提示待答」门判定；xterm buffer 读取与各浮层
// 的接线留在调用方（App.vue）。
//
// 判定为启发式：采样窗口是光标行与其上一行（提示行即光标所待的行），命中
// 即抑制；新输出把光标推离提示行后门自动放行，普通提示符场景不受影响。

import { isPasswordPromptLine } from "./terminalPromptHints";

// ① 登录期动态码/验证提示。两种形态：关键词 + 冒号收尾（光标所在的待输入
//    行，如 koko「[OTP Code]:」「验证码:」「One-Time Password:」）；祈使句
//    提示（说明行形态，冒号可有可无，如 koko 的「Please Enter MFA Code.」）。
const AUTH_CHALLENGE_LINE_PATTERN =
  /(?:otp|mfa|2fa|one[-\s]?time(?:\s+(?:password|passcode|code))?|two[-\s]?factor|verification(?:\s+code)?|验证码|动态[口令密码]|双因子|二次验证)[^:：\n]{0,32}[:：]\s*$|(?:please\s+)?enter\s+(?:the\s+)?(?:mfa|otp|2fa|verification(?:\s+code)?|one[-\s]?time|动态[口令密码]|验证码)/i;

/** 该行是否为登录期动态码/验证提示（trimEnd 后判定；空串恒 false）。 */
export function isAuthChallengeLine(text: string): boolean {
  const trimmed = (text ?? "").trimEnd();
  if (!trimmed) return false;
  return AUTH_CHALLENGE_LINE_PATTERN.test(trimmed);
}

// ② 选择/确认提示（堡垒机服务器菜单、shell read/select、y/n 确认等）：
//    - 英文 select/choose/pick 与 enter 类祈使句 + 行尾冒号/问号；
//    - 中文「请选择/请输入/请确认」「输入序号」「^选择…:」+ 行尾冒号/问号；
//    - 行尾 y/n 括号（(y/n)、[Y/n]、(yes/no): 等）与 [Y]/[n] 单字符菜单括号。
const SELECTION_PROMPT_PATTERN =
  /(?:^(?:please\s+)?(?:select|choose|pick)\b[^:：\n?？]{0,40}|^enter\b[^:：\n?？]{0,40}|请(?:选择|输入|确认)|输入(?:序号|编号|选项)|^选择)[^:：\n?？]{0,40}[:：?？]\s*$|\[[YyNn]\]|\[[Yy]\/[Nn]\]|\((?:[Yy]\/[Nn]|[Nn]\/[Yy]|[Yy]es\/[Nn]o|[Nn]o\/[Yy]es)\)(?:\s*[:：])?\s*$/i;

/** 该行是否为选择/确认提示（trimEnd 后判定；空串恒 false）。 */
export function isSelectionPromptLine(text: string): boolean {
  const trimmed = (text ?? "").trimEnd();
  if (!trimmed) return false;
  return SELECTION_PROMPT_PATTERN.test(trimmed);
}

/** 该行是否为「远端询问输入/要求选择」的交互提示行：动态码 ∪ 密码输入
 *  （复用 prompt hints 的密码行启发，单一事实源）∪ 选择/确认。 */
export function isInteractivePromptLine(text: string): boolean {
  const trimmed = (text ?? "").trimEnd();
  if (!trimmed) return false;
  return isAuthChallengeLine(trimmed) || isPasswordPromptLine(trimmed) || isSelectionPromptLine(trimmed);
}

/** 光标行及其上一行的提示采样（与密码提示启发同窗）：getLineText 由调用方
 *  注入（xterm buffer 的 translateToString），本函数只做窗口与判定，单测可
 *  直接喂假行。cursorRow 传缓冲绝对行（调用方负责 baseY + cursorY 折算）。 */
export function interactivePromptNearCursor(cursorRow: number, getLineText: (row: number) => string): boolean {
  for (let row = cursorRow; row >= Math.max(0, cursorRow - 1); row -= 1) {
    if (isInteractivePromptLine(getLineText(row))) return true;
  }
  return false;
}

/** 「交互提示待答」门：调用方逐项传入当前信号，保持纯函数可测。 */
export interface InteractivePromptGates {
  /** 终端缓冲采样：光标邻域有询问输入/选择提示行（动态码、密码、选择菜单）。 */
  promptLineOnScreen: boolean;
  /** 连接期挑战弹窗未决（host-key / 连接挑战的 workbench 回退弹窗在等应答）。 */
  challengeDialogPending: boolean;
}

/** 任一信号在场即「终端交互提示待答」，↑/↓ 与建议/ghost 一并让位远端。 */
export function isInteractivePromptPending(gates: InteractivePromptGates): boolean {
  return gates.promptLineOnScreen || gates.challengeDialogPending;
}
