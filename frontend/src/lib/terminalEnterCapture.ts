// 终端回车行采集（history 面板数据源的兜底路径）：commandHistory 的既有
// 采集点（命令弹窗/建议自动执行/OSC 633 E 帧/批量发送）都覆盖不到「用户在
// 终端提示符下手动敲命令回车」——SSH 会话远端没有 shell integration 时 E 帧
// 不存在，直接键入的命令从不入史（此前按"真实降级"有意不做）。这里补上
// 回车点的纯判定：门过滤 + 回显对照。安全底线是凭据类输入（sudo/ssh/su
// 密码提示等关回显场景）绝不入史——对照失败的行宁可漏采（Tab 补全/方向键
// 编辑会让模型行失真），不能错采。

/** 回车采集的门条件（调用方逐项传入，保持纯函数可测）。 */
export interface EnterCaptureGates {
  /** xterm alternate buffer（vim/tmux/htop 等整屏程序，回车是交互不是命令）。 */
  alternateActive: boolean;
  /** zmodem/trzsz/串口上传等传输占用输入流。 */
  transferBusy: boolean;
  /** OSC 633 E..D 之间（有 shell integration 时命令运行中；无则恒 false）。 */
  shellCommandActive: boolean;
}

/** 回车行是否值得尝试采集：空行、整屏程序、传输占用、命令运行中一律不采。 */
export function canCaptureEnterLine(line: string, gates: EnterCaptureGates): boolean {
  return Boolean(line.trim()) && !gates.alternateActive && !gates.transferBusy && !gates.shellCommandActive;
}

/**
 * 回显对照：模型行（pendingTerminalInput 累积的键入）必须原样出现在光标前
 * 的屏幕文本中。回显是「这不是密码提示」的证据——shell 关闭回显时（密码、
 * read -s）屏幕上不会有这些字符，此时拒采。null = 屏幕不可测（测试环境/
 * 渲染器未就绪），放行走保守降级（与没有该防线时的旧行为一致）。
 */
export function echoConfirmsLine(echoText: string | null, line: string): boolean {
  if (echoText === null) return true;
  return Boolean(line.trim()) && echoText.includes(line);
}
