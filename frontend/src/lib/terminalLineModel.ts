// 行缓冲按键轨迹模型（App.vue trackPendingInput）的行编辑控制字符处理：
// 远端 shell 的 readline 编辑键（Ctrl+U 清行 / Ctrl+W 删词）在 PTY 输入流里
// 是不可见控制字节，回显里看不到删了什么——简单字符模型若忽略它们，行缓冲
// 就会与真实提示符行失步（Ctrl+U 后模型仍留着死字符，建议/补全/ghost 对着
// 错误的行检索，#138 丝滑度 review P0-B）。纯函数，语义对齐 bash readline：
// - Ctrl+U（0x15，unix-line-discard）：清空整行；
// - Ctrl+W（0x17，unix-word-rubout）：删掉行尾空白与它前面的一个词，**保留**
//   该词之前的分隔空白（实测 bash 3.2/5.x readline：
//   "abc def" → "abc "，"abc  def  " → "abc  "，"abc " → ""，"   " → ""）。

/** 已知行编辑控制字符 → 新行内容；其余返回 null（调用方按原逻辑处理）。 */
export function applyLineEditControlChar(line: string, char: string): string | null {
  if (char === "\u0015") return "";
  if (char === "\u0017") {
    // 先吃掉行尾空白，再吃掉最后一个词；词前的分隔空白保留（bash 的
    // unix-word-rubout 只删「空白 + 词」，不删词前空白）。全空白行或无词
    // 可删时整行清空。
    const trimmed = line.replace(/\s+$/, "");
    return trimmed.replace(/\S+$/, "");
  }
  return null;
}
