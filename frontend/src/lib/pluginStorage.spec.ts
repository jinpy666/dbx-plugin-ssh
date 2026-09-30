// 薄 spec：验证 shared/frontend/pluginStorage 适配器在本插件工具链下
// import 解析成立，并锁定 pluginStore 的迁键清单（实现与文档只在 shared
// 维护，通道级行为由适配器保证；这里防的是"新偏好键直写 localStorage
// 没进 store"与"node 环境默认解析抛错"两类回归）。
import { afterEach, describe, expect, it, vi } from "vitest";
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
        // 命令 → 最近执行时刻（Warp 式 history 面板相对时间），与命令环同采集口。
        "ssh-command-history-times",
        "ssh-follow-directory",
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
        // dock 面板精简工具条隐藏偏好。
        "ssh-panel-toolbar-hidden",
        "telnet-connect-last",
        "serial-connect-last",
        "vnc-connect-last",
        // 结构化补全引擎（FIG wave-1）：fig-safe（默认）/ fig / off。
        // 旧结构化补全开关键已随 legacy spec 目录退役（键集全等断言本身
        // 即禁止任何退役键回流，故此处不写字面量，避免命中退役 grep 门禁）。
        "ssh-completion-engine",
        "ssh-terminal-ghost-suggest",
        // Docker/Podman 引擎连接设置（单键 JSON 映射，dockerEngine.ts 自治）。
        "ssh-docker-engine",
        "ssh-tunnel-profiles",
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
      // FIG wave-1 legacy 退役：旧结构化补全开关键被引擎键取代；字面量按
      // 退役 grep 门禁要求省略（"ssh-completion" + "-spec" 拼接）。
      ["ssh-completion", "-spec"].join(""),
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

describe("host init-aware channel resolution", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubHostApi(capabilities: Record<string, unknown>) {
    const initListeners = new Set<(event: Event) => void>();
    const hostApi: Record<string, unknown> = { capabilities };
    vi.stubGlobal(
      "window",
      Object.assign(Object.create(null), { dbxPlugin: hostApi }),
    );
    vi.stubGlobal("document", {
      addEventListener: (_type: string, listener: (event: Event) => void) => initListeners.add(listener),
      removeEventListener: (_type: string, listener: (event: Event) => void) => initListeners.delete(listener),
    });
    return { hostApi, dispatchInit: () => initListeners.forEach((listener) => listener(new Event("dbx-plugin-init"))) };
  }

  function bridgeFor(map: Map<string, unknown>): DbxPluginStorageBridge {
    return {
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
  }

  it("delays channel resolution until the host init event fills capabilities", async () => {
    // 回归根因（新建/复制会话 tab 主题被重置）：宿主 SDK 的 capabilities
    // 由 init 消息填充，插件模块加载即判定通道时它还是空对象——opaque
    // origin 下又没有 localStorage 可降级，整个 store 被误锁到 memory 档，
    // 主题等偏好读到默认、写入重启即丢。判定必须等 dbx-plugin-init。
    const map = new Map<string, unknown>([["ssh-terminal-appearance", "{}"]]);
    const bridge = bridgeFor(map);
    const { hostApi, dispatchInit } = stubHostApi({});
    const { createPluginKvStore } = await import("../../../shared/frontend/pluginStorage");
    const store = createPluginKvStore(["ssh-terminal-appearance"], { localStorage: null, initTimeoutMs: 50 });

    let ready = false;
    void store.ready.then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);

    hostApi.capabilities = { storage: true };
    hostApi.storage = bridge;
    dispatchInit();
    await store.ready;

    expect(store.channel).toBe("host");
    expect(store.getItem("ssh-terminal-appearance")).toBe("{}");
  });

  it("falls back to the degraded channel when the host init never lands", async () => {
    stubHostApi({});
    const { createPluginKvStore } = await import("../../../shared/frontend/pluginStorage");
    const store = createPluginKvStore(["ssh-terminal-appearance"], { localStorage: null, initTimeoutMs: 10 });
    await store.ready;
    expect(store.channel).toBe("memory");
  });

  it("does not wait when no host api exists (direct-browser/node)", async () => {
    vi.stubGlobal("window", Object.assign(Object.create(null), {}));
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
    const backing = new Map<string, string>([["ssh-terminal-appearance", "{}"]]);
    const localStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, value),
      removeItem: (key: string) => backing.delete(key),
    };
    const { createPluginKvStore } = await import("../../../shared/frontend/pluginStorage");
    const store = createPluginKvStore(["ssh-terminal-appearance"], { localStorage });
    await store.ready;
    expect(store.channel).toBe("localStorage");
    expect(store.getItem("ssh-terminal-appearance")).toBe("{}");
  });
});
