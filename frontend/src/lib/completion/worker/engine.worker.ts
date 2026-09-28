// engine.worker（FIG 批次 2-2）：inline worker 入口。把真实 FigCompletionSource
// 实现（manifest + vendored amazon-q parser，经冻结接缝 fig/source.ts）搬进
// worker 线程执行。
//
// 纪律（roadmap 批次 2-2 / 方案 §43/§44）：
// - 只 import 真实构造（figCompletionSource.ts），不修改其文件——并行 lane
//   对该文件的后续改动随合并自动进入本 worker 包；
// - 线协议 = engineRunner.ts 的 EngineWorkerRequest / EngineWorkerResponse
//   （此处仅 type-only import，编译期擦除）；
// - 任何异常 → 回 response:null（pass-through 空响应），worker 内绝不死；
//   onmessage 接线层再兜一层 try/catch（§43：补全失败不得影响输入链路）。
//
// 测试注记：模块导入安全——Node（vitest 默认环境）无 self 时跳过接线；
// 单测直接驱动导出的 createWorkerMessageHandler（纯函数化，不依赖全局）。

import type { CompletionResponse } from "../core/types";
import type { FigCompletionSource, FigSourceRequest } from "../fig/source";
import { createFigCompletionSource } from "../fig/figCompletionSource";
import type { EngineWorkerRequest, EngineWorkerResponse } from "./engineRunner";

const TRIGGERS: ReadonlyArray<FigSourceRequest["trigger"]> = ["typing", "tab", "manual"];

/**
 * 单条消息处理（纯函数化便于单测）：收到合法 resolve 请求 → source.resolve →
 * post 一条回执；畸形消息静默忽略；source 异常/非法产物 → response:null。
 * post 自身抛错也吞掉（worker 内绝不死）。
 */
export function createWorkerMessageHandler(
  source: FigCompletionSource,
  post: (message: EngineWorkerResponse) => void,
): (data: unknown) => void {
  return (data: unknown) => {
    try {
      const request = parseRequest(data);
      if (request === null) return;
      let response: CompletionResponse | null = null;
      try {
        const outcome = source.resolve(request);
        response = isResponseLike(outcome) ? outcome : null;
      } catch {
        response = null; // 实现约定吞异常（source.ts §3.1），这里再兜一层
      }
      post({
        kind: "response",
        requestId: request.requestId,
        revision: request.revision,
        sessionId: request.sessionId,
        response,
      });
    } catch {
      // post 失败等一切意外到此吞掉：worker 不因单条消息退出
    }
  };
}

/** 协议解码：非 resolve / 字段形态不符 → null（静默忽略）；trigger 容错为
 * "typing"（source 侧仅作调度提示，非法值不值得弃整条请求）。 */
function parseRequest(data: unknown): FigSourceRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Partial<EngineWorkerRequest>;
  if (raw.kind !== "resolve") return null;
  if (typeof raw.requestId !== "number") return null;
  if (typeof raw.revision !== "number") return null;
  if (typeof raw.sessionId !== "string") return null;
  if (typeof raw.line !== "string") return null;
  const trigger = TRIGGERS.includes(raw.trigger as FigSourceRequest["trigger"])
    ? (raw.trigger as FigSourceRequest["trigger"])
    : "typing";
  return {
    line: raw.line,
    requestId: raw.requestId,
    revision: raw.revision,
    sessionId: raw.sessionId,
    trigger,
  };
}

/** 回执产物的最小形态校验：requestId/revision 数字 + items 数组（controller
 * 侧三重 guard 仍会做最终裁决，此处防畸形结构上 line）。 */
function isResponseLike(value: unknown): value is CompletionResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CompletionResponse>;
  return (
    typeof candidate.requestId === "number" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.items)
  );
}

// ---------------------------------------------------------------------------
// 入口接线：真实 source + postMessage 通道（Node/vitest 导入时静默跳过）
// ---------------------------------------------------------------------------

const source: FigCompletionSource = createFigCompletionSource();

/** 最小 worker 宿主面（避免引入 webworker lib 与 DOM lib 的全局声明冲突）。 */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const selfRef = (globalThis as { self?: unknown }).self;
if (typeof selfRef === "object" && selfRef !== null) {
  const scope = selfRef as Partial<WorkerScope>;
  const post = scope.postMessage;
  if (typeof post === "function") {
    const handleMessage = createWorkerMessageHandler(source, (message) => {
      post.call(selfRef, message);
    });
    scope.onmessage = (event: { data: unknown }) => {
      try {
        handleMessage(event?.data);
      } catch {
        // handler 内部已兜底；此层防御 event 形态异常，worker 内绝不死
      }
    };
  }
}
