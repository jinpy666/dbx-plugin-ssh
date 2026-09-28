// completion/execute 的前端封装（FIG wave-1 契约 §3 / host/protocol.ts 冻结镜像）。
// 职责只有三件：默认值与 clamp、经 window.dbxPlugin.invoke 调 sidecar、
// 把一切失败收敛为 null（补全任何一层失败不得影响 PTY 输入链路）。
// 安全与裁剪的权威在 sidecar（completion:validate_and_clamp）；客户端
// 预先收敛到同一组常量只是减少无效往返，不构成安全边界。

import type { CompletionExecuteRequest, CompletionExecuteResult } from "./protocol";

/** completion/execute 线协议方法名（契约 §2 决策 5：RPC 命名冻结）。 */
export const COMPLETION_EXECUTE_METHOD = "completion/execute";

/** completion 层超时：缺省 1200ms，clamp 到 [200, 3000]（契约 §3）。 */
export const COMPLETION_DEFAULT_TIMEOUT_MS = 1200;
export const COMPLETION_MIN_TIMEOUT_MS = 200;
export const COMPLETION_MAX_TIMEOUT_MS = 3000;

/** 输出上限：缺省/客户端上限 256 KiB（与 sidecar MAX_OUTPUT_BYTES 对齐）。 */
export const COMPLETION_DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/** mode 恒为 completion-generator（契约 §3；sidecar 拒绝其他值）。 */
export const COMPLETION_GENERATOR_MODE = "completion-generator";

/**
 * 桥层显式超时 = completion 超时 + 500ms 余量：保证宿主桥不会先于
 * sidecar 的 completion 层竞速超时而中断（sidecar 超时后会正常回
 * timedOut 结果而非桥错误）。宿主把显式超时 clamp 到 1–120000ms，
 * 本值域安全落在其中。
 */
export const COMPLETION_BRIDGE_TIMEOUT_MARGIN_MS = 500;

/** 宿主桥 invoke 的最小结构签名（window.dbxPlugin.invoke 的子集），便于测试注入。 */
export type CompletionHostInvoke = (
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

export interface CompletionHostClient {
  /**
   * 执行 generator 命令；任何失败（桥缺失、异常、超时、返回畸形、请求畸形）
   * 一律 resolve null，绝不 reject/throw——调用方按 null 降级 pass-through。
   */
  execute(req: CompletionExecuteRequest): Promise<CompletionExecuteResult | null>;
}

/** completion 超时 clamp：非有限数 → 缺省；越界 → 收紧到 [200, 3000]。 */
export function clampCompletionTimeoutMs(timeoutMs: number | undefined | null): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return COMPLETION_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(COMPLETION_MAX_TIMEOUT_MS, Math.max(COMPLETION_MIN_TIMEOUT_MS, timeoutMs));
}

/** 输出上限 clamp：非有限数或非正 → 缺省；上限与 sidecar 256 KiB 对齐。 */
export function clampCompletionMaxOutputBytes(maxOutputBytes: number | undefined | null): number {
  if (typeof maxOutputBytes !== "number" || !Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
    return COMPLETION_DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.min(COMPLETION_DEFAULT_MAX_OUTPUT_BYTES, Math.floor(maxOutputBytes));
}

function isCompletionTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const target = value as { kind?: unknown; sessionId?: unknown };
  return (
    (target.kind === "local" || target.kind === "ssh") &&
    typeof target.sessionId === "string" &&
    target.sessionId.length > 0
  );
}

/**
 * 请求规范化 + 客户端侧校验：timeoutMs/maxOutputBytes 缺省与 clamp；
 * mode 恒覆写为 completion-generator。请求畸形（target/command/args 不合
 * 法）返回 null——与传输失败同语义，由调用方降级。
 */
export function normalizeCompletionExecuteRequest(
  req: CompletionExecuteRequest,
): CompletionExecuteRequest | null {
  if (typeof req !== "object" || req === null) return null;
  if (!isCompletionTarget(req.target)) return null;
  if (typeof req.command !== "string" || req.command.trim() === "") return null;
  if (!Array.isArray(req.args) || req.args.some((arg) => typeof arg !== "string")) return null;
  return {
    target: req.target,
    command: req.command,
    args: req.args,
    cwd: typeof req.cwd === "string" ? req.cwd : null,
    timeoutMs: clampCompletionTimeoutMs(req.timeoutMs),
    maxOutputBytes: clampCompletionMaxOutputBytes(req.maxOutputBytes),
    mode: COMPLETION_GENERATOR_MODE,
  };
}

/** exitCode 合法域：number（有限）或 null（超时/被杀）；畸形返回 undefined。 */
function parseExitCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * 返回值结构校验：与 protocol.ts 的 CompletionExecuteResult 逐字段对齐，
 * 畸形（缺字段/类型不符/非对象）一律 null。
 */
export function parseCompletionExecuteResult(raw: unknown): CompletionExecuteResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const exitCode = parseExitCode(value.exitCode);
  if (exitCode === undefined) return null;
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string") return null;
  if (typeof value.truncated !== "boolean" || typeof value.timedOut !== "boolean") return null;
  return {
    exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
    truncated: value.truncated,
    timedOut: value.timedOut,
  };
}

function defaultBridgeInvoke(): CompletionHostInvoke | null {
  try {
    const bridge = typeof window === "undefined" ? undefined : window.dbxPlugin;
    return bridge && typeof bridge.invoke === "function" ? bridge.invoke.bind(bridge) : null;
  } catch {
    return null;
  }
}

/**
 * 创建 completion/execute 客户端。生产环境无参调用（走 window.dbxPlugin.invoke）；
 * 测试/离线环境经 `invoke` 注入 Fake 桥。
 */
export function createCompletionHostClient(invoke?: CompletionHostInvoke): CompletionHostClient {
  return {
    async execute(req: CompletionExecuteRequest): Promise<CompletionExecuteResult | null> {
      try {
        const bridgeInvoke = invoke ?? defaultBridgeInvoke();
        if (!bridgeInvoke) return null;
        const request = normalizeCompletionExecuteRequest(req);
        if (!request) return null;
        const raw = await bridgeInvoke(COMPLETION_EXECUTE_METHOD, request, {
          timeoutMs: request.timeoutMs + COMPLETION_BRIDGE_TIMEOUT_MARGIN_MS,
        });
        return parseCompletionExecuteResult(raw);
      } catch {
        return null;
      }
    },
  };
}
