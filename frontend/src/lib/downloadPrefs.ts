// 下载冲突策略（设置弹窗与下载询问弹窗共用）：rename（自动重命名，默认）/
// ask（询问我）/ overwrite（覆盖）。存储键与 sanitize 留在 App.vue（耦合
// 下载偏好的内存权威态与 sidecar preferences 同步）。

export type DownloadConflictPolicy = "rename" | "ask" | "overwrite";

export const DOWNLOAD_CONFLICT_POLICIES: readonly DownloadConflictPolicy[] = ["rename", "ask", "overwrite"];

/** 下载落盘通道（SFTP/zmodem/trzsz 三条下载链路共用的优先级契约）：
 * 本机可落盘 → sidecar `local/saveFile`（唯一能提供本机落盘路径的通道——
 * 下载目录设置/冲突处理/「在文件夹中显示」都依赖它，issue #245）；否则宿主
 * fileTransfer（web/docker 无本机文件系统时的流式保存）；两者皆缺 →
 * 浏览器/宿主 saveFile 兜底。探测失败按不可落盘降级，不 reject。 */
export type TransferSinkChannel = "sidecar" | "fileTransfer" | "hostSave";

export async function chooseTransferSinkChannel(options: {
  hasFileTransfer: boolean;
  probeLocalCapabilities: () => Promise<{ canSaveLocal: boolean; downloadsDir: string } | undefined>;
}): Promise<TransferSinkChannel> {
  const local = await options.probeLocalCapabilities().catch(() => undefined);
  if (local?.canSaveLocal) return "sidecar";
  if (options.hasFileTransfer) return "fileTransfer";
  return "hostSave";
}
