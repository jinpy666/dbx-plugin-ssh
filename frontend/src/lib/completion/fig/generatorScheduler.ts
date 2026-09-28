// 声明式 generator 调度器（FIG 批次 2-1，方案 §16/§18/§29/§30/§31）：
// figCompletionSource 解析出的 generator 槽位 → TTL 缓存 → hostClient
// （completion/execute，目标机执行）→ runDeclarativeGenerator → 按前缀过滤
// 的 CompletionItem[]。控制器（CompletionController）负责两段渲染与
// revision/sessionId/requestId 三重 guard；本模块只管「执行 + 缓存 +
// 收敛」，一切失败 resolve null，绝不 reject/throw。
//
// 安全边界（§16）：只执行 argv 数组形态的 script（allowShellScript=false，
// 字符串/函数形态的 shell script / custom JS 由 source 不产出槽位而天然
// 拒绝）；mode 恒 completion-generator；超时/上限由 hostClient 与 sidecar
// 双侧 clamp；spec 的 postProcess 在 WebView 内执行且必须 try/catch
//（runDeclarativeGenerator 内收敛，抛错 = 该 generator 失败 → null）。

import type { CompletionItem } from "../core/types";
import type { CompletionExecuteTarget } from "../host/protocol";
import { createCompletionHostClient, type CompletionHostClient } from "../host/hostClient";
import { runDeclarativeGenerator, type GeneratorPostProcess, type GeneratorRunContext } from "./generatorRunner";
import type { FigSourceRequest } from "./source";

/** TTL 缓存窗口（§29：建议从 300ms 起）——快速连续输入不重复打 RPC。 */
export const GENERATOR_CACHE_TTL_MS = 300;

/** 声明式 generator 槽位：figCompletionSource.collectGenerators 的产出。
 * script 为 argv 数组；postProcess 为 spec 原生函数（Fig Suggestion[] 语义）；
 * 位置/前缀字段同时供编辑定位与缓存 key 使用。 */
export interface FigGeneratorSlot {
  script: string[];
  /** stdout 切分分隔符；缺省/空串按 "\n"。 */
  splitOn?: string;
  /** spec 原生 postProcess：Fig 签名 (out, tokens?) → Suggestion[]。缺省 =
   * 非空切分片段即候选名。在 WebView 执行，抛错 = 该 generator 失败。 */
  postProcess?: (out: string, tokens?: string[]) => unknown;
  /** 主命令名（primaryName，context.command 语义对齐 source 的 ready 响应）。 */
  command: string | null;
  commandPath: string[];
  /** 当前 token 文本（= searchTerm）；结果按它做 startsWith 过滤。 */
  prefix: string;
  /** 当前 token 在行内的 [start, end)，generator 候选的编辑范围。 */
  tokenStart: number;
  tokenEnd: number;
}

export interface GeneratorSchedulerOptions {
  /** 槽位收集器（= figCompletionSource.collectGenerators；测试注入 Fake）。 */
  collect: (request: FigSourceRequest) => FigGeneratorSlot[];
  /** 目标会话（local/ssh）；null = 无可执行目标（无会话/串口）→ 一律 null。 */
  target: () => CompletionExecuteTarget | null;
  /** generator 执行 cwd（OSC 7/633 跟踪值）；null 交 sidecar 用会话默认目录。 */
  cwd?: () => string | null;
  /** completion/execute 客户端；缺省 createCompletionHostClient()（生产桥）。 */
  hostClient?: CompletionHostClient;
  /** TTL 缓存窗口毫秒；缺省 GENERATOR_CACHE_TTL_MS（300）。 */
  ttlMs?: number;
  /** 时钟注入（测试 fake timers）；缺省 Date.now。 */
  now?: () => number;
}

interface GeneratorCacheEntry {
  expiresAt: number;
  /** 在途即缓存：同 key 并发请求共享同一 promise，天然去重不重复打 RPC。 */
  promise: Promise<CompletionItem[] | null>;
}

export class GeneratorScheduler {
  private readonly collect: (request: FigSourceRequest) => FigGeneratorSlot[];
  private readonly target: () => CompletionExecuteTarget | null;
  private readonly cwd: (() => string | null) | undefined;
  private readonly hostClient: CompletionHostClient;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, GeneratorCacheEntry>();

  constructor(options: GeneratorSchedulerOptions) {
    this.collect = options.collect;
    this.target = options.target;
    this.cwd = options.cwd;
    this.hostClient = options.hostClient ?? createCompletionHostClient();
    this.ttlMs = typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : GENERATOR_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** 收集当前请求位置的声明式 generator 槽位；收集器抛错/返回非数组 → []。 */
  slots(request: FigSourceRequest): FigGeneratorSlot[] {
    try {
      const slots = this.collect(request);
      return Array.isArray(slots) ? slots : [];
    } catch {
      return [];
    }
  }

  /**
   * 运行单个槽位：TTL 命中（含在途共享）直接复用，不重复打 RPC；否则执行
   * 并写入缓存。一切失败 → null（resolve，不 reject）。
   */
  run(slot: FigGeneratorSlot): Promise<CompletionItem[] | null> {
    try {
      const target = this.target();
      if (!target) return Promise.resolve(null);
      const key = this.cacheKey(slot, target);
      const timestamp = this.now();
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > timestamp) return hit.promise;
      const promise = this.executeSlot(slot, target);
      this.cache.set(key, { expiresAt: timestamp + this.ttlMs, promise });
      this.prune(timestamp);
      return promise;
    } catch {
      return Promise.resolve(null);
    }
  }

  /** 测试/调试视图：当前缓存条数。 */
  get cacheSize(): number {
    return this.cache.size;
  }

  // ---- 内部 ---------------------------------------------------------------

  /** 缓存 key（§29）：(commandPath, 位置/前缀, target.sessionId, cwd) + 槽位
   * 身份（script/splitOn）——同位置多个 generator 不互相串缓存。 */
  private cacheKey(slot: FigGeneratorSlot, target: CompletionExecuteTarget): string {
    const cwd = this.cwd ? this.cwd() : null;
    return JSON.stringify([
      slot.commandPath,
      slot.tokenStart,
      slot.prefix,
      target.kind,
      target.sessionId,
      typeof cwd === "string" ? cwd : null,
      slot.script,
      typeof slot.splitOn === "string" ? slot.splitOn : null,
    ]);
  }

  private executeSlot(slot: FigGeneratorSlot, target: CompletionExecuteTarget): Promise<CompletionItem[] | null> {
    const ctx: GeneratorRunContext = {
      target,
      execute: (request) => this.hostClient.execute(request),
      context: {
        command: slot.command,
        commandPath: slot.commandPath,
        tokenStart: slot.tokenStart,
        tokenEnd: slot.tokenEnd,
      },
      prefix: slot.prefix,
      cwd: this.cwd ? this.cwd() : null,
    };
    return runDeclarativeGenerator(
      { script: slot.script, splitOn: slot.splitOn },
      this.adaptPostProcess(slot),
      ctx,
    ).then((items) => {
      if (!items) return null;
      if (!slot.prefix) return items;
      // §18：generator 产出按当前前缀过滤后再交 controller 合并（Fig 的
      // query-term 过滤语义；统一排序/截断仍归 ranking 层）。
      return items.filter((item) => item.label.startsWith(slot.prefix));
    });
  }

  /** spec 原生 postProcess → runDeclarativeGenerator 的适配器。无 postProcess
   * 时按 Fig 缺省语义：非空切分片段即候选名。抛错由 runner 兜住 → null。 */
  private adaptPostProcess(slot: FigGeneratorSlot): GeneratorPostProcess {
    const specPostProcess = slot.postProcess;
    return (parts, result) => {
      if (typeof specPostProcess !== "function") {
        return parts
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((label) => ({ label }));
      }
      const produced = specPostProcess(result.stdout);
      if (!Array.isArray(produced)) return null;
      return produced as ReadonlyArray<string | Record<string, unknown>>;
    };
  }

  /** 惰性清理过期条目，防长会话内存缓涨。 */
  private prune(timestamp: number): void {
    if (this.cache.size < 32) return;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= timestamp) this.cache.delete(key);
    }
  }
}
