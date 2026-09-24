// 会话连接弹窗的「上次参数」记忆（pluginStore 单键 JSON）。
// 凭据类字段由调用方剔除后再持久化（密码/密文槽一律不落盘）。
// 载荷只保留原始值字段（string/number/boolean），结构化选项由调用方
// 在类型层面收窄；坏 JSON / 非对象载荷静默回空，不阻塞弹窗打开。
import { pluginStore } from "./pluginStore";

export function loadLastConnectParams<T extends object>(key: string): Partial<T> {
  try {
    const raw = pluginStore.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<T> = {};
    for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        (out as Record<string, unknown>)[field] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function persistLastConnectParams(key: string, params: Record<string, unknown>): void {
  try {
    pluginStore.setItem(key, JSON.stringify(params));
  } catch {
    // 存储不可用：参数记忆仅当前会话生效。
  }
}
