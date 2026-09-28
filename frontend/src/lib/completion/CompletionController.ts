// CompletionController（FIG wave-1 Lane A）：补全引擎的调度中枢——把
// 「行缓冲变更 → 防抖请求 → resolver → 响应 guard → 菜单」从 App.vue 收进
// 可测试的模块层。纪律（方案 §5.1/§30/§43，契约 §4.1）：
//
// 1. revision 纪律：一切结果回来时校验 requestId、revision、sessionId 三者
//    与当前态一致，任一不匹配即静默丢弃。
// 2. resolve 全程 try/catch：任何异常降级为 state:"pass-through" 空响应，
//    绝不抛到调用方（PTY 红线：补全任何一层失败不得影响输入链路）。
// 3. debounce 期间的多次 lineChanged 只发一次请求。
// 4. enabled()===false 时不调度、不解析。
//
// wave 1 的 resolver 是 legacyResolve（同步纯函数，响应在 request() 内同步
// 交付，键入路径的浮层刷新时机与 HEAD 一致）；resolver 可注入（默认
// legacyResolve），为 wave 2 的 fig provider 链 / generator RPC 留插槽。
// requestId/revision 字段为将来 Worker 化留位（契约 §2 非目标）。

import type { CompletionEdit, CompletionItem, CompletionResponse, CompletionTrigger } from "./core/types";
import { legacyResolve } from "./legacy/legacySpecAdapter";

export interface LegacyResolveEnvelope {
  line: string;
  requestId: number;
  revision: number;
  sessionId: string;
  trigger: CompletionTrigger;
}

export type CompletionResolver = (input: LegacyResolveEnvelope) => CompletionResponse | Promise<CompletionResponse>;

export interface CompletionControllerOptions {
  /** 当前终端会话 id（无会话时空串）；响应回来时校验未换会话。 */
  sessionId: () => string;
  /** 返回 pendingTerminalInput 当前值。 */
  readLine: () => string;
  /** 总开关 + 引擎开关合成后的判定。 */
  enabled: () => boolean;
  /** 行缓冲变更后的防抖窗口，默认 90ms。 */
  debounceMs?: number;
  /** resolver 可注入（单测注入异常/异步桩）；缺省 legacyResolve。 */
  resolver?: CompletionResolver;
  onResponse: (response: CompletionResponse) => void;
  /** App.vue 执行终端写入（整行擦重打等现机制不动）。 */
  onAcceptEdit: (edit: CompletionEdit) => void;
}

export class CompletionController {
  private revision = 0;
  private requestId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly resolver: CompletionResolver;

  constructor(private readonly options: CompletionControllerOptions) {
    this.debounceMs = options.debounceMs ?? 90;
    this.resolver = options.resolver ?? legacyResolve;
  }

  /**
   * App.vue 在行缓冲每个变更点调用：revision++ 并防抖调度 request("typing")。
   * 窗口内的多次调用合并为一次请求（旧 timer 作废）。
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
   * 立即发起一次解析（manual/typing/tab）：取消挂起的防抖调度，同步
   * resolver 的响应在本次调用内同步交付（onResponse 同步回调）。
   */
  request(trigger: CompletionTrigger): void {
    this.cancelTimer();
    if (!this.options.enabled()) return;
    this.dispatch(trigger);
  }

  /** 接受候选：把 resolver 产生的 edit 交给 App 执行终端写入。 */
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
    const line = this.options.readLine();
    let outcome: CompletionResponse | Promise<CompletionResponse>;
    try {
      outcome = this.resolver({ line, requestId, revision, sessionId, trigger });
    } catch {
      outcome = this.passThrough(requestId, revision);
    }
    if (outcome instanceof Promise) {
      void outcome.then(
        (response) => this.deliver(requestId, revision, sessionId, response),
        () => this.deliver(requestId, revision, sessionId, this.passThrough(requestId, revision)),
      );
      return;
    }
    // 同步 resolver（wave 1 legacy）：同步交付，键入路径零时序回归。
    this.deliver(requestId, revision, sessionId, outcome);
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
