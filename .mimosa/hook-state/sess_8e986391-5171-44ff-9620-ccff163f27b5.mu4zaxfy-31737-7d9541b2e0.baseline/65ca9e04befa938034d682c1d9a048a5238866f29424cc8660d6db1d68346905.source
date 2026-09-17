// 终端 WebGL 加速纯逻辑单测：偏好持久化、attach 三路径、开关幂等切换。
import { describe, expect, it, vi } from "vitest";
import {
  attachWebglRenderer,
  loadWebglEnabled,
  persistWebglEnabled,
  syncWebglRenderer,
  type WebglRendererLike,
  type WebglTerminalLike,
} from "./terminalWebgl";

function fakeTerminal() {
  const loaded: unknown[] = [];
  return {
    loaded,
    loadAddon(addon: unknown) {
      loaded.push(addon);
    },
  };
}

function fakeAddon(options: { throwOnCreate?: boolean; throwOnDispose?: boolean } = {}) {
  let contextLossCallback: (() => void) | null = null;
  const addon: WebglRendererLike & { fireContextLoss(): void } = {
    dispose() {
      if (options.throwOnDispose) throw new Error("dispose failed");
    },
    onContextLoss(callback: () => void) {
      contextLossCallback = callback;
      return { dispose() {} };
    },
    fireContextLoss() {
      contextLossCallback?.();
    },
  };
  return {
    addon,
    create: () => {
      if (options.throwOnCreate) throw new Error("no webgl context");
      return addon;
    },
  };
}

describe("webgl preference persistence", () => {
  it("defaults to enabled when no preference is stored", () => {
    expect(loadWebglEnabled({ getItem: () => null })).toBe(true);
    expect(loadWebglEnabled({ getItem: () => "0" })).toBe(false);
    expect(loadWebglEnabled({ getItem: () => "1" })).toBe(true);
  });

  it("treats a throwing storage as enabled and keeps writing harmless", () => {
    expect(loadWebglEnabled({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
    expect(() =>
      persistWebglEnabled(false, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} }),
    ).not.toThrow();
  });

  it("persisting the default removes the key; disabling writes it", () => {
    const written: Array<[string, string]> = [];
    const removed: string[] = [];
    const storage = {
      setItem: (key: string, value: string) => written.push([key, value]),
      removeItem: (key: string) => removed.push(key),
    };
    persistWebglEnabled(true, storage);
    persistWebglEnabled(false, storage);
    expect(removed).toEqual(["ssh-terminal-webgl"]);
    expect(written).toEqual([["ssh-terminal-webgl", "0"]]);
  });

  it("survives a sandboxed opaque origin where touching window.localStorage throws", () => {
    // 宿主工作台 iframe 是 sandbox="allow-scripts"（无 allow-same-origin）：
    // opaque origin 下「访问 window.localStorage 属性」本身就抛 SecurityError。
    // 默认参数在函数体 try 之外求值，因此此处必须走无参调用路径。
    const sandboxWindow: Record<string, unknown> = {};
    Object.defineProperty(sandboxWindow, "localStorage", {
      get() {
        throw new Error("SecurityError: The document is sandboxed and lacks the 'allow-same-origin' flag");
      },
    });
    vi.stubGlobal("window", sandboxWindow);
    try {
      expect(loadWebglEnabled()).toBe(true);
      expect(() => persistWebglEnabled(false)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("attachWebglRenderer", () => {
  it("attaches and wires the context-loss fallback", () => {
    const terminal = fakeTerminal();
    const { addon, create } = fakeAddon();
    const attached = attachWebglRenderer(terminal, create);
    expect(attached).toBe(addon);
    expect(terminal.loaded).toEqual([addon]);
    // GPU context 丢失：dispose 回退 DOM 渲染，不抛错。
    expect(() => addon.fireContextLoss()).not.toThrow();
  });

  it("returns null when the addon cannot be created (no webgl context)", () => {
    const terminal = fakeTerminal();
    const { create } = fakeAddon({ throwOnCreate: true });
    expect(attachWebglRenderer(terminal, create)).toBeNull();
    expect(terminal.loaded).toHaveLength(0);
  });
});

describe("syncWebglRenderer", () => {
  it("toggling off disposes and returns null (idempotent)", () => {
    const terminal = fakeTerminal();
    const { addon, create } = fakeAddon();
    const attached = attachWebglRenderer(terminal, create);
    expect(syncWebglRenderer(terminal, false, attached, create)).toBeNull();
    // 再关一次保持 null，不重复 dispose。
    expect(syncWebglRenderer(terminal, false, null, create)).toBeNull();
  });

  it("toggling on attaches once and stays idempotent", () => {
    const terminal = fakeTerminal();
    const { addon, create } = fakeAddon();
    const first = syncWebglRenderer(terminal, true, null, create);
    expect(first).toBe(addon);
    const second = syncWebglRenderer(terminal, true, first, create);
    expect(second).toBe(addon);
    expect(terminal.loaded).toHaveLength(1);
  });
});
