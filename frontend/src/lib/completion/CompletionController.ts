// CompletionController（FIG wave-1 Lane A'）：补全引擎的调度中枢——把
// 「行缓冲变更 → 防抖请求 → resolver → 响应 guard → 菜单」从 App.vue 收进
// 可测试的模块层。resolver 唯一来源 = 冻结接缝 `fig/source.ts` 的
// FigCompletionSource（构造注入；Lane C' 提供真实实现，单测/开发用
// testing/fakeFigSource 的 Fake）。纪律（契约 §2.1、方案 §5.1/§30/§43）：
//
// 1. revision 纪律：一切结果交付前校验 requestId、revision、sessionId 三者
//    与当前态一致，任一不匹配即静默丢弃（"菜单显示 ≠ 键盘所有权"的数据面
//    对应物：过期候选绝不进 UI）。
// 2. resolve 全程 try/catch：任何异常降级为 state:"pass-through" 空响应，
//    绝不抛到调用方（PTY 红线：补全任何一层失败不得影响输入链路）。
// 3. debounce 期间的多次 lineChanged 只发一次请求（旧 timer 作废）。
// 4. enabled()===false 时 lineChanged 不调度、request 不解析（revision 仍
//    前进，保证重新打开后的在途结果不会串期）。
//
// 冻结 source 接口是同步的（resolve(): CompletionResponse | null，同步
// 交付保持键入路径零时序漂移）；对 thenable 的防御性等待仅为单测驱动
// stale 路径与将来 Worker 化留位，生产实现不会走进该分支。

import type { CompletionEdit, CompletionItem, CompletionResponse, CompletionTrigger } from "./core/types";
import type { FigCompletionSource, FigSourceRequest } from "./fig/source";

export interface CompletionControllerOptions {
  /** 结构化补全唯一引擎（冻结接缝 fig/source.ts；构造注入）。 */
  source: FigCompletionSource;
  /** 当前终端会话 id（无会话时空串）；结果交付时校验未换会话。 */
  sessionId: () => string;
  /** 返回行缓冲（pendingTerminalInput）当前值。 */
  readLine: () => string;
  /** 引擎开关（设置三态合成后）+ 输入门判定；false 时不调度、不解析。 */
  enabled: () => boolean;
  /** 行缓冲变更后的防抖窗口，默认 90ms。 */
  debounceMs?: number;
  onResponse: (response: CompletionResponse) => void;
  /** App.vue 执行终端写入（applyEditToText + 整行擦重打，机制不变）。 */
  onAcceptEdit: (edit: CompletionEdit) => void;
}

export class CompletionController {
  private revision = 0;
  private requestId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly source: FigCompletionSource;

  constructor(private readonly options: CompletionControllerOptions) {
    this.debounceMs = options.debounceMs ?? 90;
    this.source = options.source;
  }

  /**
   * App.vue 在行缓冲每个变更点调用（trackPendingInput / 整行替换 / ghost
   * 接受 / Enter·Ctrl+C 清行）：revision++ 作废在途结果，并防抖调度一次
   * request("typing")。窗口内多次调用合并为一次（旧 timer 作废）。
   */
  lineChanged(): void {
    this.revision += 1;
    if (!this.options.enabled()) return;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dispatch("typing");
    }, this.debounceMs);
  }

  /**
   * 立即发起一次解析（typing/tab/manual）：取消挂起的防抖调度。同步
   * source 的响应在本调用内同步交付（onResponse 同步回调），键入路径的
   * 浮层刷新时机与基线一致。
   */
  request(trigger: CompletionTrigger): void {
    this.cancelTimer();
    if (!this.options.enabled()) return;
    this.dispatch(trigger);
  }

  /** 接受候选：把 source 产生的 edit 交给 App 执行终端写入。 */
  accept(item: CompletionItem): void {
    try {
      this.options.onAcceptEdit(item.edit);
    } catch {
      // PTY 红线：接受路径的任何异常不得冒泡进按键处理。
    }
  }

  /** 菜单关闭/浮层收起：取消挂起调度并把在途结果作废。 */
  dismiss(): void {
    this.cancelTimer();
    this.revision += 1;
  }

  /** 会话切换：重置 revision/requestId，丢弃在途结果（sessionId guard）。 */
  resetSession(): void {
    this.cancelTimer();
    this.revision += 1;
    this.requestId += 1;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private dispatch(trigger: CompletionTrigger): void {
    const requestId = (this.requestId += 1);
    const revision = this.revision;
    const sessionId = this.options.sessionId();
    const request: FigSourceRequest = {
      line: this.options.readLine(),
      requestId,
      revision,
      sessionId,
      trigger,
    };
    let outcome: CompletionResponse | null;
    try {
      outcome = this.source.resolve(request);
    } catch {
      // source 内部约定吞异常，这里再兜一层：任何抛错都降级 pass-through。
      this.deliver(requestId, revision, sessionId, this.passThrough(requestId, revision));
      return;
    }
    if (outcome !== null && typeof (outcome as { then?: unknown }).then === "function") {
      // 防御分支：冻结接口为同步，此处仅为测试桩 / Worker 化留位。
      void Promise.resolve(outcome).then(
        (response) => this.deliver(requestId, revision, sessionId, response ?? this.passThrough(requestId, revision)),
        () => this.deliver(requestId, revision, sessionId, this.passThrough(requestId, revision)),
      );
      return;
    }
    this.deliver(requestId, revision, sessionId, outcome ?? this.passThrough(requestId, revision));
  }

  private deliver(requestId: number, revision: number, sessionId: string, response: CompletionResponse): void {
    // 三重 guard：requestId / revision / sessionId 任一不匹配当前态 → 静默丢弃。
    if (requestId !== this.requestId || revision !== this.revision || sessionId !== this.options.sessionId()) return;
    try {
      this.options.onResponse(response);
    } catch {
      // onResponse 属 UI 面：异常不冒泡回按键/输入路径。
    }
  }

  private passThrough(requestId: number, revision: number): CompletionResponse {
    return { requestId, revision, state: "pass-through", items: [] };
  }
}
