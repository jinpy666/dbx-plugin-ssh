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

export interface RelaySelectionTriage<T> {
  files: T[];
  dirs: T[];
  /** 符号链接/特殊条目——不中继，完成提示说明。 */
  skipped: number;
}

/** 选中条目分诊（阶段 2 起文件夹可中继）：文件直进行、目录走树遍历、
 * 其余（symlink 等）计入 skipped。泛型透传：uri 等附加字段原样保留。 */
export function triageRelaySelection<T extends { kind: string }>(entries: readonly T[]): RelaySelectionTriage<T> {
  const files = entries.filter((entry) => entry.kind === "file");
  const dirs = entries.filter((entry) => entry.kind === "directory");
  return {
    files: [...files],
    dirs: [...dirs],
    skipped: entries.length - files.length - dirs.length,
  };
}

export interface RelayWalkFile {
  /** 目标侧相对目录（"" = 目标根目录）。 */
  relDir: string;
  name: string;
  uri: string;
}

export interface RelayTreeOrder {
  /** 目标侧需 ensure 的相对目录：去重、父先于子（父路径段是子路径段前缀，
   * 按段数升序即拓扑序），段数相同按字典序稳定输出。 */
  dirs: string[];
  files: RelayWalkFile[];
}

/** 树遍历产物的纯整序：目录 ensure 顺序与文件队列确定化（遍历本身在
 * composables/useSftpRelay，BFS 顺序随 RPC 完成序波动，这里收敛成确定序）。 */
export function orderRelayTree(dirs: readonly string[], files: readonly RelayWalkFile[]): RelayTreeOrder {
  const orderedDirs = [...new Set(dirs)];
  orderedDirs.sort((a, b) => {
    const depthA = a ? a.split("/").length : 0;
    const depthB = b ? b.split("/").length : 0;
    return depthA - depthB || (a < b ? -1 : a > b ? 1 : 0);
  });
  return { dirs: orderedDirs, files: files.map((file) => ({ ...file })) };
}

/** 目标根逐前缀拆分（mkdir 非递归兜底）：`/a/b/c` → `["/a", "/a/b", "/a/b/c"]`。
 * 目标端 `sftp/createDirectory` 是单级 mkdir，用户输入多级新路径时逐级 ensure；
 * 已存在的前缀会报错、由调用方静默放行。根目录与空串返回 []。 */
export function relayTargetDirPrefixes(dir: string): string[] {
  const trimmed = dir.trim() || "/";
  if (trimmed === "/") return [];
  const segments = trimmed.split("/").filter(Boolean);
  const prefixes: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}
