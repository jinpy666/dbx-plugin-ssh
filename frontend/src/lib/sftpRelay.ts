/**
 * SFTP 跨会话传输（issue #334 阶段 1）：右键「发送到会话…」把当前面板选中
 * 的文件经前端中继泵到另一台在线服务器——下载腿复用 `sftp/download/*` 分块
 * 管线（字节流恒为原始内容，压缩通道只影响 wire 不影响交付），上传腿复用
 * `uploadSource` 的显式 `sessionId` 投递（与批量上传同一跨连接通道，字节经
 * webview 桥两跳）。本模块只做纯决策：目标候选过滤、批次规划；RPC 编排与
 * 分块泵在 composables/useSftpRelay。文件夹中继（远端树遍历 + 逐目录建目录）
 * 是阶段 2。
 */
import { batchTargetLabel, filterLiveBatchTargets, type BatchSendTarget } from "./batchSend";

export interface RelayTargetOption {
  sessionId: string;
  label: string;
}

/**
 * 目标候选：在线 SSH 会话、排除当前会话。只读连接一并排除——目标端要写，
 * sudo 车道也不适合跨机中继（源端 root 可读文件走普通车道），宁可少列不列
 * 一个必然失败的目标。本地终端会话（batchTargets 里的 local 行）没有 SFTP，
 * 同样排除。
 */
export function relayTargetOptions(targets: readonly BatchSendTarget[], currentSessionId: string): RelayTargetOption[] {
  const live = filterLiveBatchTargets([...targets]);
  return live
    .filter((target) => !target.local && target.sessionId !== currentSessionId && !target.readOnly)
    .map((target) => ({ sessionId: target.sessionId, label: batchTargetLabel(target) }));
}

export interface RelayQueuePlan<T> {
  files: T[];
  /** 不可中继的条目数（文件夹/符号链接/特殊项）——阶段 1 仅支持普通文件。 */
  skipped: number;
}

/** 批次规划：只有普通文件可中继；目录/符号链接计入 skipped（完成提示说明）。
 * 泛型透传：调用方可在条目上携带 uri 等附加字段，原样保留。 */
export function buildRelayQueue<T extends { kind: string }>(entries: readonly T[]): RelayQueuePlan<T> {
  const files = entries.filter((entry) => entry.kind === "file");
  return {
    files: [...files],
    skipped: entries.length - files.length,
  };
}
