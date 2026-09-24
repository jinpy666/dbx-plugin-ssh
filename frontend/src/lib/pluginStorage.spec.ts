// 薄 spec：验证 shared/frontend/pluginStorage 适配器在本插件工具链下
// import 解析成立，并锁定 pluginStore 的迁键清单（实现与文档只在 shared
// 维护，通道级行为由适配器保证；这里防的是"新偏好键直写 localStorage
// 没进 store"与"node 环境默认解析抛错"两类回归）。
import { describe, expect, it } from "vitest";
import type { DbxPluginStorageBridge } from "../../../shared/frontend/pluginStorage";
import { PLUGIN_STORE_KEYS, pluginStore } from "./pluginStore";

describe("ssh pluginStore wiring", () => {
  it("declares every migrated UI-state key (sidecar-backed keys stay out)", () => {
    // 迁移键 = 活的前端 UI 偏好（键名与迁移前 localStorage 一致）。
    // 不在此列：ssh-download-*（sidecar preferences.json 权威的 web 缓存）、
    // ssh-transfer-* / ssh-history-suggestion-*（同 download-*：sidecar 权威
    // 的同步缓存）、ssh-quick-commands（已迁 sidecar，旧键仅作一次性迁移种子）。
    expect([...PLUGIN_STORE_KEYS].sort()).toEqual(
      [
        "sftp-path-history",
        "ssh-command-history",
        "ssh-sftp-pane-open",
        "ssh-sftp-side-tab",
        "ssh-sftp-side-collapsed",
        "ssh-terminal-select-copy",
        "ssh-keyword-highlight",
        "ssh-batch-bar-open",
        "ssh-terminal-search-options",
        "ssh-terminal-webgl",
        "ssh-terminal-font-size",
        "ssh-terminal-font-family",
        "ssh-terminal-behavior",
        "ssh-terminal-hotkeys",
        "ssh-terminal-appearance",
        "ssh-terminal-ghost-suggest",
      ].sort(),
    );
    for (const banned of [
      "ssh-download-directory",
      "ssh-download-use-default-dir",
      "ssh-download-conflict-policy",
      "ssh-transfer-concurrency",
      "ssh-transfer-duplicate-policy",
      "ssh-history-suggestions-enabled",
      "ssh-history-suggestion-min-chars",
      "ssh-history-suggestion-max-chars",
      "ssh-quick-commands",
    ]) {
      expect(PLUGIN_STORE_KEYS).not.toContain(banned);
    }
  });

  it("resolves to the memory channel in node tests instead of throwing", async () => {
    // node 环境无 window：默认解析应落到内存档而不是抛错（opaque origin
    // 真机上 localStorage 访问即抛，适配器需把它折断成降级通道）。
    expect(pluginStore.channel).toBe("memory");
    await pluginStore.ready;
  });

  it("hydrates from a host bridge and writes through synchronously", async () => {
    // 用注入桥走一遍 host 通道：水合读存量 + set/remove 写穿（App.vue 调用
    // 点的同步 getItem/setItem/removeItem 语义依赖该行为）。
    const map = new Map<string, unknown>([["ssh-keyword-highlight", "false"]]);
    const bridge: DbxPluginStorageBridge & { map: Map<string, unknown> } = {
      map,
      get: async (key) => (map.has(key) ? map.get(key) : null),
      set: async (key, value) => {
        map.set(key, value);
        return null;
      },
      delete: async (key) => {
        map.delete(key);
        return null;
      },
    };
    const { createPluginKvStore } = await import("../../../shared/frontend/pluginStorage");
    const store = createPluginKvStore([...PLUGIN_STORE_KEYS], { bridge, localStorage: null });
    await store.ready;
    expect(store.getItem("ssh-keyword-highlight")).toBe("false");
    store.setItem("ssh-sftp-pane-open", "true");
    await Promise.resolve();
    expect(bridge.map.get("ssh-sftp-pane-open")).toBe("true");
    store.removeItem("ssh-sftp-pane-open");
    await Promise.resolve();
    expect(bridge.map.has("ssh-sftp-pane-open")).toBe(false);
  });
});
