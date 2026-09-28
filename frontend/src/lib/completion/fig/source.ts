// FIG 补全引擎最终架构的冻结接缝：Lane A（engine-runner / UI / controller）
// 与 Lane C（vendored Amazon Q parser + 全量 spec manifest）之间的唯一边界。
// C 提供实现；A 面向接口编码，单测用 fake。generator（声明式/自定义）的异步
// 补全在批次 2 经独立通道接入，本接口保持同步；generator 声明位置 resolve
// 返回 null（调用方 pass-through，Tab 交还 shell）。

import type { CompletionResponse } from "../core/types";

/** 上游 Fig.Spec 原始对象（含函数字段）。对 Lane A 保持不透明。 */
export type FigSpecRaw = unknown;

/** spec-manifest.generated.ts 的冻结形态：bundled 静态 import（决策 D2）。 */
export type FigSpecManifest = Readonly<Record<string, FigSpecRaw>>;

export interface FigSourceRequest {
  line: string;
  requestId: number;
  revision: number;
  sessionId: string;
  trigger: "typing" | "tab" | "manual";
}

/**
 * 无 spec 命中、parser 抛错、或仅 generator 可补的动态位置 → 返回 null
 * （调用方 pass-through）。实现内部必须吞掉一切异常，绝不向上抛。
 */
export interface FigCompletionSource {
  readonly id: string;
  resolve(request: FigSourceRequest): CompletionResponse | null;
}
