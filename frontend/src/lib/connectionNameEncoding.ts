/**
 * 连接级 SFTP 文件名编码覆盖（M16）的控件语义。
 *
 * 权威存储在 sidecar `preferences.json` 的 `sftp_name_encoding_overrides`
 * 键：`{ <connectionId>: "auto" | "latin-1" }`（值域与全局
 * `sftp_name_encoding` 一致）。本模块只做控件回显/读改写合并的纯逻辑；
 * 解析优先级（连接覆盖 > 全局 > 缺省 auto）由 sidecar
 * `preferences::resolve_sftp_name_encoding` 权威执行，这里同名归一化仅
 * 服务于 UI 状态推导。
 */

/** 覆盖桶上限（与 sidecar `SFTP_NAME_ENCODING_OVERRIDES_MAX_CONNECTIONS` 一致）。 */
export const SFTP_NAME_ENCODING_OVERRIDES_MAX = 512;

/** 控件三态：跟随全局（缺省，桶内无条目）/ 显式 auto / 显式 latin-1。 */
export type ConnectionNameEncodingChoice = "follow" | "auto" | "latin-1";

/** 落盘值：白名单内的显式覆盖；「跟随全局」不落盘（删除桶条目）。 */
export type NameEncodingOverride = "auto" | "latin-1";

/** 白名单归一化：非 auto/latin-1 一律视为未覆盖（与 sidecar parse 同语义）。 */
export function normalizeNameEncodingOverride(value: unknown): NameEncodingOverride | null {
  if (value === "auto" || value === "latin-1") return value;
  return null;
}

/** 存储桶条目 → 控件状态：未覆盖/非法一律回显「跟随全局」。 */
export function choiceFromOverride(value: unknown): ConnectionNameEncodingChoice {
  return normalizeNameEncodingOverride(value) ?? "follow";
}

/** 控件状态 → 落盘值：「跟随全局」为 null（merge 时删除桶条目）。 */
export function overrideFromChoice(choice: ConnectionNameEncodingChoice): NameEncodingOverride | null {
  return choice === "follow" ? null : choice;
}

/** 生效编码（UI 提示用）：连接覆盖 > 全局偏好 > 缺省 auto（纯函数镜像）。 */
export function effectiveNameEncoding(
  connectionOverride: unknown,
  globalPreference: unknown,
): NameEncodingOverride {
  return (
    normalizeNameEncodingOverride(connectionOverride) ??
    normalizeNameEncodingOverride(globalPreference) ??
    "auto"
  );
}

/**
 * 读改写合并（`local/preferences/set` 对该键是整表替换）：保留其他连接的
 * 合法桶条目（非法丢弃、超限截断），再按 `value` 写入/删除本连接的桶。
 * 非对象 store（旧数据/手改损坏）按空表处理，绝不抛错卡死工作台。
 */
export function mergeNameEncodingStore(
  store: unknown,
  connectionId: string,
  value: NameEncodingOverride | null,
): Record<string, NameEncodingOverride> {
  const base =
    store && typeof store === "object" && !Array.isArray(store)
      ? (store as Record<string, unknown>)
      : {};
  const out: Record<string, NameEncodingOverride> = {};
  let kept = 0;
  // 目标连接优先占位：即使其他桶占满上限也保证本次编辑生效（总量仍守上限）。
  if (value !== null && connectionId.length > 0) {
    out[connectionId] = value;
    kept = 1;
  }
  for (const [key, entry] of Object.entries(base)) {
    if (key === connectionId || key.length === 0) continue;
    if (kept >= SFTP_NAME_ENCODING_OVERRIDES_MAX) break;
    const normalized = normalizeNameEncodingOverride(entry);
    if (normalized === null) continue;
    out[key] = normalized;
    kept += 1;
  }
  return out;
}
