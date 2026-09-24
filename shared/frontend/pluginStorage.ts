// 插件工作台 UI 持久化单点适配（宿主 host.storage / window.dbxPlugin.storage）。
//
// 背景：工作台 iframe 是 sandbox="allow-scripts"（opaque origin），插件代码里
// 直接读 localStorage 会抛 SecurityError（宿主 plugin_storage.rs 头注释同款
// 结论，ssh preferences 曾为此整体迁 sidecar）。宿主自 Host API 1.2 起提供
// window.dbxPlugin.storage（get/set/delete，能力位 capabilities.storage）：
// 桌面端落 plugin-data/<id>/ui-storage.json，web 宿主落顶层文档 localStorage，
// dev host 有同形 mock。宿主没有"列键"方法，因此每个插件在创建 store 时
// 声明自己的键集合，水合阶段逐键拉入缓存。
//
// 通道降级：宿主桥 storage → 直接 localStorage（浏览器直连 / 老宿主，guarded）
// → 内存（仅当前会话）。读全部同步（启动水合 + 写穿缓存），插件调用点
// 保持 getItem/setItem/removeItem 的 Web Storage 语义，零 async 改造。
// 宿主档水合时对 localStorage 旧值做一次性惰性搬家（读旧键 → 写穿宿主），
// 老 web 直连 / dev 场景的无感升级；桌面 opaque origin 下 localStorage
// 天然不可读，搬家自然跳过。
//
// 只存非敏感 UI 状态：host.storage 是 UI-state store（单值 256 KiB / 总量
// 1 MiB / 1024 键，宿主端强制），凭据仍走连接表单 binding:"secret"，
// 大数据归 sidecar 的 DBX_PLUGIN_DATA_DIR。

/** Web Storage 子集；localStorage 与本模块的 store 均满足该形状。 */
export type KvBacking = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 宿主桥 storage 面（Host API 1.2；见 pluginHostBridge storage 命名空间）。 */
export interface DbxPluginStorageBridge {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export type PluginKvChannel = "host" | "localStorage" | "memory";

export interface PluginKvStoreOptions {
  /** 注入宿主桥；null 强制跳过宿主档，undefined 按 window.dbxPlugin 解析。 */
  bridge?: DbxPluginStorageBridge | null;
  /** 注入 localStorage 档；null 强制跳过，undefined 按 guarded window.localStorage 解析。 */
  localStorage?: KvBacking | null;
}

export interface PluginKvStore extends KvBacking {
  /** 水合完成（宿主档存量键读入缓存 + 旧值搬家）。挂载前 await，保证首读命中。 */
  ready: Promise<void>;
  /** 实际生效通道；"memory" 表示仅会话内有效（无桥且 localStorage 不可用）。 */
  readonly channel: PluginKvChannel;
}

interface ResolvedChannels {
  bridge: DbxPluginStorageBridge | null;
  fallback: KvBacking | null;
}

function resolveBridge(): DbxPluginStorageBridge | null {
  try {
    const api = (window as unknown as { dbxPlugin?: { capabilities?: { storage?: boolean }; storage?: DbxPluginStorageBridge } }).dbxPlugin;
    if (api?.capabilities?.storage && api.storage) return api.storage;
  } catch {
    /* 无 window（单测 node 环境）：无宿主桥 */
  }
  return null;
}

/** guarded localStorage：opaque origin 下访问即抛，这里把异常折断成 null/忽略。 */
function resolveFallback(): KvBacking | null {
  try {
    const ls = window.localStorage;
    ls.getItem("__dbx_plugin_storage_probe__");
    return {
      getItem: (key) => {
        try {
          return ls.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        try {
          ls.setItem(key, value);
        } catch {
          /* 配额/隐私模式：静默降级为会话内缓存 */
        }
      },
      removeItem: (key) => {
        try {
          ls.removeItem(key);
        } catch {
          /* 同上 */
        }
      },
    };
  } catch {
    return null;
  }
}

export function createPluginKvStore(keys: string[], options: PluginKvStoreOptions = {}): PluginKvStore {
  const cache = new Map<string, string>();
  let resolved: ResolvedChannels | null = null;

  const ensure = (): ResolvedChannels => {
    if (!resolved) {
      resolved = {
        bridge: options.bridge !== undefined ? options.bridge : resolveBridge(),
        fallback: options.localStorage !== undefined ? options.localStorage : resolveFallback(),
      };
    }
    return resolved;
  };

  /** 通道在首次操作时惰性判定：mock=1 注入 mock 宿主后创建的 store 也能命中桥。 */
  const channel = (): PluginKvChannel => {
    const { bridge, fallback } = ensure();
    if (bridge) return "host";
    return fallback ? "localStorage" : "memory";
  };

  /** 写穿：host 桥异步投递（配额超限等失败仅告警，不阻断 UI）；localStorage 档同步。 */
  const persist = (key: string, value: string | null): void => {
    const { bridge, fallback } = ensure();
    if (bridge) {
      const action = value === null ? bridge.delete(key) : bridge.set(key, value);
      void Promise.resolve()
        .then(() => action)
        .catch((error) => console.warn(`[pluginStorage] persist "${key}" failed`, error));
    } else if (fallback) {
      if (value === null) fallback.removeItem(key);
      else fallback.setItem(key, value);
    }
  };

  const ready = (async () => {
    const mode = channel();
    if (mode === "localStorage") {
      // 直接 localStorage 档：同步水合（读取已在 ensure() 时验证可用）。
      const { fallback } = ensure();
      for (const key of keys) {
        const raw = fallback!.getItem(key);
        if (raw !== null) cache.set(key, raw);
      }
      return;
    }
    if (mode !== "host") return;
    const { bridge, fallback } = ensure();
    await Promise.all(
      keys.map(async (key) => {
        try {
          const value = await bridge!.get(key);
          if (value !== null && value !== undefined) {
            // 水合不覆盖水合前的写入（组件可能先渲染先写）。
            if (!cache.has(key)) cache.set(key, typeof value === "string" ? value : JSON.stringify(value));
            return;
          }
          // 宿主未命中：惰性搬家 localStorage 旧值（搬家只发生一次，写穿后旧档仍在，
          // 不删除——老宿主回退时数据可用）。
          const legacy = fallback?.getItem(key) ?? null;
          if (legacy !== null) {
            if (!cache.has(key)) cache.set(key, legacy);
            if (cache.get(key) === legacy) persist(key, legacy);
          }
        } catch (error) {
          console.warn(`[pluginStorage] hydrate "${key}" failed`, error);
        }
      }),
    );
  })();

  return {
    ready,
    get channel(): PluginKvChannel {
      return channel();
    },
    getItem(key: string): string | null {
      return cache.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      cache.set(key, String(value));
      persist(key, String(value));
    },
    removeItem(key: string): void {
      cache.delete(key);
      persist(key, null);
    },
  };
}
