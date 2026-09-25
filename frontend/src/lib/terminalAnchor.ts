// 终端光标锚点换算：把 xterm buffer 坐标语义集中到一个模块，避免 App.vue 里
// 视口/绝对行公式各自漂移。xterm typings 中：
// - cursorY 是光标在「视口内」的相对行（0..rows-1）；
// - viewportY 是视口顶在缓冲里的绝对行号；
// - baseY 是滚回贴底时视口顶的绝对行号（= buffer.length - rows）。
// 历史回归：曾用 `cursorY - viewportY` 求可见行——viewportY ≠ baseY（回滚区
// 存在后）时结果为负，ghost/建议浮层被画到画布外；曾用 `cursorY + viewportY`
// 采样「光标所在行」——用户上滚时采到的是滚回区旧行而非光标行。

/** 最小 buffer 形状：只取换算需要的三个行号（便于单测伪造）。 */
export interface CursorBufferLike {
  /** 光标在视口内的相对行（0..rows-1）。 */
  cursorY: number;
  /** 视口顶的缓冲绝对行号。 */
  viewportY: number;
  /** 滚回贴底时视口顶的缓冲绝对行号。 */
  baseY: number;
}

/** 光标所在视觉行的「视口内行号」（0..rows-1）：overlay 像素锚点用。 */
export function cursorViewportRow(buffer: CursorBufferLike): number {
  return buffer.cursorY;
}

/** 光标所在视觉行的「缓冲绝对行号」：buffer.getLine 采样用。 */
export function cursorAbsoluteRow(buffer: CursorBufferLike): number {
  return buffer.baseY + buffer.cursorY;
}
