// 连接级设置的按连接镜像助手（存储迁移批 2，IMPL_PLAN_STORAGE_SYNC）：
// sidecar 运行时消费的连接级配置（启动命令 / SFTP 编码覆盖 / agent 模式 /
// 免审批命令），镜像进 pluginStore 作云同步载荷。存储形态：单键
// `Record<connectionId, 条目>`——宿主 storage 无列键，与批 1 单键收敛同理。
//
// 迁移语义（条目级，与批 1 整键级不同）：
// - `loadConnectionEntry` 返回 null = 该连接**尚未迁移**（整键缺失、整键坏档、
//   或 map 里没有该连接），调用方应从 sidecar 播种；
// - 条目存在但内容是垃圾 → 经调用方 sanitizer 收紧成域默认值后返回（**不**
//   回退种子）——条目存在即"已迁移"，防止用户清空后旧数据复活；
// - 整键坏档回落 null 是安全的：镜像可从 sidecar 按连接重建，且下一次
//   saveConnectionEntry 的读改写会以当前连接条目为种子重建整键。

import { pluginStore } from "./pluginStore";

/** 读连接条目；null = 该连接未迁移（调用方播种）。 */
export function loadConnectionEntry<T>(storeKey: string, connectionId: string, sanitize: (raw: unknown) => T): T | null {
  try {
    const raw = pluginStore.getItem(storeKey);
    if (raw === null) return null;
    const map = JSON.parse(raw);
    if (!map || typeof map !== "object" || Array.isArray(map)) return null;
    if (typeof connectionId !== "string" || connectionId.length === 0 || !(connectionId in map)) return null;
    return sanitize(map[connectionId]);
  } catch {
    return null;
  }
}

/** 读改写单连接条目（其余连接条目原样保留），整键写穿；坏档按空表重建。 */
export function saveConnectionEntry(storeKey: string, connectionId: string, value: unknown): void {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  let map: Record<string, unknown> = {};
  try {
    const raw = pluginStore.getItem(storeKey);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        map = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 坏档/读失败：按空表重建（镜像可从 sidecar 按连接回填）。
  }
  map[connectionId] = value;
  try {
    pluginStore.setItem(storeKey, JSON.stringify(map));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效（调用方另持有权威态）。
  }
}

/** 结构等值（收敛判定）：已消毒条目的规范 JSON 比较。 */
export function connectionEntryEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
