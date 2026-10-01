// 行缓冲按键轨迹模型（App.vue trackPendingInput）的行编辑控制字符处理：
// 远端 shell 的 readline 编辑键（Ctrl+U 清行 / Ctrl+W 删词）在 PTY 输入流里
// 是不可见控制字节，回显里看不到删了什么——简单字符模型若忽略它们，行缓冲
// 就会与真实提示符行失步（Ctrl+U 后模型仍留着死字符，建议/补全/ghost 对着
// 错误的行检索，#138 丝滑度 review P0-B）。纯函数，语义对齐 bash readline：
// - Ctrl+U（0x15，unix-line-discard）：清空整行；
// - Ctrl+W（0x17，unix-word-rubout）：删掉行尾的词与词前空白
//   （"abc def" → "abc"，"abc " → ""——词与间隔空白一并删除）。

/** 已知行编辑控制字符 → 新行内容；其余返回 null（调用方按原逻辑处理）。 */
export function applyLineEditControlChar(line: string, char: string): string | null {
  if (char === "\u0015") return "";
  // 「词 + 前后空白」一次删净；全空白行（无词可删）整体清空。
  if (char === "\u0017") return /\S/.test(line) ? line.replace(/\s*\S+\s*$/, "") : "";
  return null;
}
