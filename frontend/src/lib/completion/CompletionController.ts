// CompletionController（FIG wave-1 Lane A'；批次 2-1 扩展 generator 两段渲染）：
// 补全引擎的调度中枢——把「行缓冲变更 → 防抖请求 → resolver → 响应 guard →
// 菜单」从 App.vue 收进可测试的模块层。resolver 唯一来源 = 冻结接缝
// `fig/source.ts` 的 FigCompletionSource（构造注入；Lane C' 提供真实实现，
// 单测/开发用 testing/fakeFigSource 的 Fake）。纪律（契约 §2.1、方案
// §5.1/§30/§43）：
//
// 1. revision 纪律：一切结果交付前校验 requestId、revision、sessionId 三者
//    与当前态一致，任一不匹配即静默丢弃（"菜单显示 ≠ 键盘所有权"的数据面
//    对应物：过期候选绝不进 UI）。
// 2. resolve 全程 try/catch：任何异常降级为 state:"pass-through" 空响应，
//    绝不抛到调用方（PTY 红线：补全任何一层失败不得影响输入链路）。
// 3. debounce 期间的多次 lineChanged 只发一次请求（旧 timer 作废）。
// 4. enabled()===false 时 lineChanged 不调度、request 不解析（revision 仍
//    前进，保证重新打开后的在途结果不会串期）。
// 5. generator 两段渲染（批次 2-1，§31）：静态候选同步立即交付；声明式
//    generator 位在无静态候选时交付 state:"loading" 占位，异步结果回来后
//    与静态候选合并重新交付（ranking 重排由调用方经 rankItems 完成）。
//    在途 generator 结果同样受三重 guard：新 revision/request/会话到来即
//    丢弃（§30 客户端层面；sidecar 竞速超时与 cancel_exec 属 host 层）。
//
// 冻结 source 接口是同步的（resolve(): CompletionResponse | null，同步
// 交付保持键入路径零时序漂移）；对 thenable 的防御性等待仅为单测驱动
// stale 路径与将来 Worker 化留位，生产实现不会走进该分支。

import type { CompletionContext, CompletionEdit, CompletionItem, CompletionResponse, CompletionTrigger } from "./core/types";
import type { FigGeneratorSlot } from "./fig/generatorScheduler";
import type { FigCompletionSource, FigSourceRequest } from "./fig/source";

/**
 * 声明式 generator 通道（批次 2-1）：生产实现 = GeneratorScheduler
 * （fig/generatorScheduler.ts，TTL 缓存 + hostClient 执行）；单测注入 Fake。
 * 两个方法都不得抛错（实现各自兜底）。
 */
export interface CompletionGeneratorChannel {
  /** 同步收集当前请求位置的声明式 generator 槽位；无槽位/解析失败 → []。 */
  slots(request: FigSourceRequest): FigGeneratorSlot[];
  /** 运行单个槽位；一切失败（超时/异常/无目标/空产出）→ resolve null。 */
  run(slot: FigGeneratorSlot): Promise<CompletionItem[] | null>;
}

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
  /** 声明式 generator 通道；缺省不启用（行为与批次 1 完全一致）。 */
  generators?: CompletionGeneratorChannel;
  onResponse: (response: CompletionResponse) => void;
  /** App.vue 执行终端写入（applyEditToText + 整行擦重打，机制不变）。 */
  onAcceptEdit: (edit: CompletionEdit) => void;
}

/** 一次 dispatch 的 generator 第二段在途状态（§31 merge 面板）。 */
interface GeneratorPhase {
  requestId: number;
  revision: number;
  sessionId: string;
  /** 第一段已交付的静态候选（合并时原样保留，重排交给 ranking 层）。 */
  staticItems: CompletionItem[];
  /** 已返回的 generator 候选（多槽位按 settle 顺序累积）。 */
  generatorItems: CompletionItem[];
  /** 未 settle 的槽位数（全部结束后仍空才补发 pass-through 收尾）。 */
  pending: number;
  context?: CompletionContext;
}

export class CompletionController {
  private revision = 0;
  private requestId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly source: FigCompletionSource;
  private readonly generators: CompletionGeneratorChannel | undefined;
  private phase: GeneratorPhase | null = null;

  constructor(private readonly options: CompletionControllerOptions) {
    this.debounceMs = options.debounceMs ?? 90;
    this.source = options.source;
    this.generators = options.generators;
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
      outcome = null;
    }
    if (outcome !== null && typeof (outcome as { then?: unknown }).then === "function") {
      // 防御分支：冻结接口为同步，此处仅为测试桩 / Worker 化留位。
      // Worker 形态的 generator 第二段并发驱动不在本批次范围。
      void Promise.resolve(outcome).then(
        (response) => this.deliver(requestId, revision, sessionId, response ?? this.passThrough(requestId, revision)),
        () => this.deliver(requestId, revision, sessionId, this.passThrough(requestId, revision)),
      );
      return;
    }

    // —— 第一段（§31）：静态候选同步立即交付 ——
    const staticReady =
      outcome !== null && outcome.state === "ready" && outcome.items.length > 0 ? outcome : null;

    // —— 第二段：声明式 generator（§31 两段渲染；无通道时零行为变化）——
    const slots = this.safeSlots(request);
    const phase = this.openPhase(requestId, revision, sessionId, staticReady, slots);
    if (staticReady) {
      this.deliver(requestId, revision, sessionId, staticReady);
      this.runSlots(phase, slots);
      return;
    }
    if (phase) {
      // 无静态候选、generator 在途 → loading 占位（Tab/Enter 恒放行 shell，
      // keyboard.ts 规则表由 App 以 loading 态消费）。
      this.deliver(requestId, revision, sessionId, {
        requestId,
        revision,
        state: "loading",
        ...(phase.context ? { context: phase.context } : {}),
        items: [],
      });
      this.runSlots(phase, slots);
      return;
    }
    this.deliver(requestId, revision, sessionId, outcome ?? this.passThrough(requestId, revision));
  }

  private runSlots(phase: GeneratorPhase | null, slots: FigGeneratorSlot[]): void {
    if (!phase) return;
    for (const slot of slots) this.runSlot(phase, slot);
  }

  /** 收集声明式 generator 槽位：无通道/收集器抛错/非数组 → []（不抛）。 */
  private safeSlots(request: FigSourceRequest): FigGeneratorSlot[] {
    if (!this.generators) return [];
    try {
      const slots = this.generators.slots(request);
      return Array.isArray(slots) ? slots : [];
    } catch {
      return [];
    }
  }

  /** 登记本次 dispatch 的 generator 第二段在途状态；无槽位 → null（清旧）。 */
  private openPhase(
    requestId: number,
    revision: number,
    sessionId: string,
    staticReady: CompletionResponse | null,
    slots: FigGeneratorSlot[],
  ): GeneratorPhase | null {
    if (slots.length === 0) {
      this.phase = null;
      return null;
    }
    const first = slots[0];
    const context: CompletionContext = staticReady?.context ?? {
      command: first.command,
      commandPath: first.commandPath,
      tokenStart: first.tokenStart,
      tokenEnd: first.tokenEnd,
    };
    const phase: GeneratorPhase = {
      requestId,
      revision,
      sessionId,
      staticItems: staticReady ? staticReady.items : [],
      generatorItems: [],
      pending: slots.length,
      context,
    };
    this.phase = phase;
    return phase;
  }

  /** 运行单个槽位：settle 后按三重 guard 决定合并交付或丢弃（§30：新
   * revision/request/会话到来即丢弃在途 generator 结果——客户端层面防陈旧，
   * sidecar 竞速超时/cancel_exec 回收属 host 层）。 */
  private runSlot(phase: GeneratorPhase, slot: FigGeneratorSlot): void {
    const channel = this.generators;
    if (!channel) return;
    let settled: Promise<CompletionItem[] | null>;
    try {
      settled = Promise.resolve(channel.run(slot));
    } catch {
      settled = Promise.resolve(null); // run 契约：不抛；这里再兜一层
    }
    void settled
      .catch(() => null)
      .then((items) => {
        if (!this.phaseAlive(phase)) return;
        phase.pending -= 1;
        const added = Array.isArray(items) && items.length > 0;
        if (added) phase.generatorItems.push(...items);
        if (added) {
          // 合并交付：静态 + generator 一并重交，ranking 重排由调用方完成。
          this.deliver(phase.requestId, phase.revision, phase.sessionId, {
            requestId: phase.requestId,
            revision: phase.revision,
            state: "ready",
            ...(phase.context ? { context: phase.context } : {}),
            items: [...phase.staticItems, ...phase.generatorItems],
          });
        } else if (phase.pending <= 0 && phase.staticItems.length === 0 && phase.generatorItems.length === 0) {
          // 全部槽位落空且无静态候选：收回 loading 占位（pass-through）。
          this.deliver(phase.requestId, phase.revision, phase.sessionId, this.passThrough(phase.requestId, phase.revision));
        }
      });
  }

  /** 在途 phase 是否仍然新鲜（与 deliver 同一三重 guard 锚点）。 */
  private phaseAlive(phase: GeneratorPhase): boolean {
    return (
      phase.requestId === this.requestId &&
      phase.revision === this.revision &&
      phase.sessionId === this.options.sessionId()
    );
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
