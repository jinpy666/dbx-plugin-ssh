// 终端 WebGL 渲染加速（对标 iShell「WebGL GPU 加速」）：偏好持久化、
// renderer 挂载/回退、设置开关即时切换的纯逻辑。零 UI 依赖——WebGL
// addon 通过工厂注入（App.vue 传 @xterm/addon-webgl 的构造器），单测
// 用假 addon 覆盖成功/失败/context-loss 三路径。
//
// 设计约束：
// - 默认开启（对标 iShell 默认 GPU 加速）；WebGL 不可用（无 context、
//   headless、驱动黑名单）时静默回退 DOM 渲染，功能不受损（optional 降级）。
// - 浏览器 WebGL context 总数有限（每页 ~8-16 个）：只有主终端长期挂
//   renderer；回放弹窗保持 DOM 渲染。GIF 导出在导出期间给离屏终端临时
//   挂载（取像素必须有 canvas），导出完随终端 dispose 释放 context。
// - context loss（GPU 重置/驱动切换）时 dispose renderer 回退 DOM 渲染，
//   不重建、不报错——xterm DOM 渲染器始终在底层可用。
// - 存储访问不得出现在默认参数位：宿主工作台 iframe 是
//   sandbox="allow-scripts"（opaque origin），「访问 window.localStorage
//   属性」本身就抛 SecurityError；默认参数在函数体 try 之外求值，写在
//   参数位会让 setup 期崩溃、整个工作台空白（2026-09-14 修复的回归）。

const WEBGL_ENABLED_KEY = "ssh-terminal-webgl";

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return window.localStorage;
}

export function loadWebglEnabled(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return (storage ?? defaultStorage()).getItem(WEBGL_ENABLED_KEY) !== "0";
  } catch {
    // 沙箱/opaque origin/隐私模式：读不到偏好按默认开启处理。
    return true;
  }
}

export function persistWebglEnabled(
  enabled: boolean,
  storage?: Pick<Storage, "setItem" | "removeItem">,
): void {
  try {
    const target = storage ?? defaultStorage();
    if (enabled) {
      // 默认值不落键：未来默认策略变化时老用户不被钉死在旧默认。
      target.removeItem(WEBGL_ENABLED_KEY);
    } else {
      target.setItem(WEBGL_ENABLED_KEY, "0");
    }
  } catch {
    // 存储不可用时仅失去记忆，本次会话内开关仍然生效。
  }
}

/** xterm IRenderer addon 的最小结构面（@xterm/addon-webgl 满足）。 */
export interface WebglRendererLike {
  dispose(): void;
  onContextLoss(listener: () => void): { dispose(): void };
}

/** xterm Terminal 的最小结构面（真实 Terminal 满足）。 */
export interface WebglTerminalLike {
  loadAddon(addon: unknown): void;
}

/**
 * 尝试给终端挂 WebGL renderer。构造或加载抛错（无 WebGL context 等）
 * 返回 null——调用方静默保持 DOM 渲染。挂载成功后监听 context loss，
 * 一旦丢失即 dispose 回退 DOM 渲染（xterm 会在原 canvas 上继续用
 * DOM 渲染器）。
 */
export function attachWebglRenderer<T extends WebglRendererLike>(
  terminal: WebglTerminalLike,
  createAddon: () => T,
): T | null {
  let created: T | null = null;
  try {
    created = createAddon();
    terminal.loadAddon(created);
  } catch {
    // 构造或 activate 失败：半初始化的 addon 需要清理（若已构造）。
    try {
      created?.dispose();
    } catch {
      /* noop */
    }
    return null;
  }
  const addon = created;
  addon.onContextLoss(() => {
    try {
      addon.dispose();
    } catch {
      /* noop */
    }
  });
  return addon;
}

/**
 * 设置开关的即时切换语义：返回该终端当前应持有的 renderer（开=已挂载的
 * addon，关=null）。已处于目标状态时返回现状（幂等）。
 */
export function syncWebglRenderer<T extends WebglRendererLike>(
  terminal: WebglTerminalLike,
  enabled: boolean,
  current: T | null,
  createAddon: () => T,
): T | null {
  if (!enabled) {
    current?.dispose();
    return null;
  }
  return current ?? attachWebglRenderer(terminal, createAddon);
}
