// 命令执行期输出的尾部采集缓冲（Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL
// §4.3）：AI 修复只取「executing→completed 之间的输出尾部」（错误摘要多在
// 尾部），不落全量历史。环形策略：超过内部软上限时从头裁一半，快照时再按
// 行/字符硬上限收尾——append 均摊 O(1)，长输出（tail -f）不无限增长。
// 纯字符串逻辑，可完整单测；调用方负责按 OSC 633 C/D 帧驱动 reset/append。

export const TAIL_CAPTURE_SOFT_LIMIT = 64 * 1024;
export const TAIL_CAPTURE_TRIM_TO = 32 * 1024;

export class TailCapture {
  private buffer = "";
  constructor(
    private readonly softLimit = TAIL_CAPTURE_SOFT_LIMIT,
    private readonly trimTo = TAIL_CAPTURE_TRIM_TO,
  ) {}

  reset() {
    this.buffer = "";
  }

  /** 追加一段输出文本（调用方先经 TextDecoder {stream:true} 解码，多字节
   *  跨 chunk 由解码器兜住；这里只管拼接与裁剪）。 */
  append(chunk: string) {
    if (!chunk) return;
    this.buffer += chunk;
    if (this.buffer.length > this.softLimit) this.buffer = this.buffer.slice(-this.trimTo);
  }

  /** 当前累计的原始文本（未截断未脱敏；发送前必须过 prepareAiOutputSnapshot）。 */
  raw(): string {
    return this.buffer;
  }
}
