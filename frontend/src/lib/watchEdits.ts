/**
 * 外部编辑器回传的多文件并行纯逻辑（M15，P2-5 的多文件扩展）。RPC 与 UI
 * 状态留在 App.vue，本模块只做三件纯事：
 * 1. watch 注册表（watchId -> 条目）：同一会话可同时挂多个远端文件；同一
 *    远端路径多次打开产生多个本地副本 watcher，全部保留（任一副本保存都
 *    回传同一远端目标，上传串行链保证最后写入者生效）；
 * 2. file-modified 事件排队：逐文件弹确认，后到的 modified 事件入队等待，
 *    不顶替未决确认，也不丢事件；
 * 3. 队列头决议：只有队头的 watchId 被处置（上传/总是/取消）时才出队。
 */

/** 一次外部编辑监听的展示条目（watchId 是 sidecar 颁发的 bearer token）。 */
export interface ExternalWatchEntry {
  watchId: string;
  /** 远端文件名（确认框标题用）。 */
  name: string;
  /** 远端绝对路径（dedup 粒度与上传目标）。 */
  remotePath: string;
}

/** watchId -> 条目。 */
export type WatchRegistry = Record<string, ExternalWatchEntry>;

/** 一条待确认的 file-modified 提示（队列元素，逐文件消费）。 */
export interface ModifiedPrompt {
  watchId: string;
  name: string;
}

function validEntry(entry: ExternalWatchEntry | undefined): entry is ExternalWatchEntry {
  return !!entry && !!entry.watchId && !!entry.name && !!entry.remotePath;
}

/** 注册一个新监听：追加挂载，不顶替同 remotePath 的旧条目。sidecar 的
 * dedup 键是 {sessionId, 本地副本路径}——每次打开落新的时间戳目录，旧副本
 * 的 watcher 依然存活；同一远端文件开多个窗口时，任何一个副本的保存都应
 * 回传同一远端路径，按 remotePath 顶替会让旧窗口的保存静默丢失（真机回归）。 */
export function registerWatch(watches: WatchRegistry, entry: ExternalWatchEntry): WatchRegistry {
  if (!validEntry(entry)) return watches;
  return { ...watches, [entry.watchId]: { ...entry } };
}

/** 移除一个监听（watch/stop、会话关闭等）。 */
export function dropWatch(watches: WatchRegistry, watchId: string): WatchRegistry {
  if (!watches[watchId]) return watches;
  const next: WatchRegistry = { ...watches };
  delete next[watchId];
  return next;
}

/** watchId 的展示名（事件负载只带 watchId，名字从注册表回查）。 */
export function watchName(watches: WatchRegistry, watchId: string): string {
  return watches[watchId]?.name || "";
}

/**
 * file-modified 事件入队：不认识的 watchId（会话已关/监听已顶替）静默
 * 丢弃；同一文件在未决期间再次 modified 只保留一条（确认框处置的就是
 * 磁盘上的最新内容，重复弹窗没有信息量）；新文件则排到队尾逐个确认。
 */
export function enqueueWatchModified(
  queue: ModifiedPrompt[],
  watches: WatchRegistry,
  watchId: string,
): ModifiedPrompt[] {
  if (!watchId || !watches[watchId]) return queue;
  if (queue.some((prompt) => prompt.watchId === watchId)) return queue;
  return [...queue, { watchId, name: watchName(watches, watchId) }];
}

/**
 * 队列头决议出队：只有队头的 watchId 与处置动作一致时才弹出它，防止
 * 慢操作期间的过期回调把后一个文件的确认顶掉。返回 null 表示不匹配
 * （队列保持原样）。
 */
export function popWatchModified(queue: ModifiedPrompt[], watchId: string): ModifiedPrompt[] | null {
  const head = queue[0];
  if (!head || head.watchId !== watchId) return null;
  return queue.slice(1);
}
