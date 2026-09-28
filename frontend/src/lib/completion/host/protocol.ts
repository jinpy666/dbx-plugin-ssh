// CompletionHost RPC 线协议（wave-1 冻结）：前端 HostClient 与 Rust sidecar
// 的 completion/execute 共同遵守的唯一边界。字段一律 camelCase（仓库协议
// 命名约定）。wave 1 只落 completion/execute；listDirectory / environment
// 留待 wave 2。Rust 侧结构体定义见 backend/src/completion/protocol.rs，
// 两边必须逐字段一致（serde round-trip 测试固化）。

export type CompletionExecuteTarget =
  | { kind: "local"; sessionId: string }
  | { kind: "ssh"; sessionId: string };

export interface CompletionExecuteRequest {
  target: CompletionExecuteTarget;
  command: string;
  args: string[];
  cwd?: string | null;
  /** 毫秒；completion 层 clamp 到 [200, 3000]，默认 1200。 */
  timeoutMs: number;
  maxOutputBytes: number;
  mode: "completion-generator";
}

export interface CompletionExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** completion 层超时（底层进程已尝试取消回收）；此时 exitCode 为 null。 */
  timedOut: boolean;
}
