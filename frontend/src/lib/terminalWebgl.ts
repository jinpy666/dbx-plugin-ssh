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
//   不报错——xterm DOM 渲染器始终在底层可用。传入恢复选项的调用方（主终端）
//   会在有限预算内重建 renderer（Tabby 同款策略），预算耗尽静默留在 DOM；
//   不传选项保持旧行为（一次性 dispose，GIF 导出的离屏终端等短命场景）。
// - 存储统一走 pluginStore（宿主 host.storage → guarded localStorage → 内存）；
//   默认参数位同样安全（适配器内部全 guarded，opaque origin 不抛错；历史上
//   直读 window.localStorage 曾因「访问属性即抛」导致 setup 期崩溃、整个
//   工作台空白，2026-09-14 修复的回归——保持存储访问不在 try 之外裸露）。

import { pluginStore } from "./pluginStore";

const WEBGL_ENABLED_KEY = "ssh-terminal-webgl";

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  // 默认走 pluginStore（宿主 host.storage → guarded localStorage → 内存），
  // opaque origin 下不再抛 SecurityError；显式注入 storage 仅测试用。
  return pluginStore;
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

/** context loss 后的有限预算重建选项；不传保持一次性 dispose 的旧行为。 */
export interface WebglRecoveryOptions<T extends WebglRendererLike> {
  /** 重建总预算（默认 2）：跨整个会话递减，预算耗尽后 context loss 只回退 DOM。 */
  retries?: number;
  /** 重建尝试前的延迟毫秒（默认 1000，给 GPU 重置留出恢复时间）。 */
  delayMs?: number;
  /** 替代 setTimeout 的延迟调度（单测注入手动调度器）；重建单次触发，无需取消句柄，偏好关闭走 enabled 谓词。 */
  schedule?: (callback: () => void) => unknown;
  /** 重建成功回调：调用方同步其持有的 renderer 引用（如 webglRenderer.value）。 */
  onRecovered?: (addon: T) => void;
  /** 返回 false 时放弃重建（偏好已被用户关闭）。 */
  enabled?: () => boolean;
}

/**
 * 尝试给终端挂 WebGL renderer。构造或加载抛错（无 WebGL context 等）
 * 返回 null——调用方静默保持 DOM 渲染。挂载成功后监听 context loss，
 * 一旦丢失即 dispose 回退 DOM 渲染（xterm 会在原 canvas 上继续用
 * DOM 渲染器）；传入恢复选项时在延迟后按预算重建，成功经 onRecovered
 * 交还调用方，重建后的 renderer 自带剩余预算的同类监听。
 */
export function attachWebglRenderer<T extends WebglRendererLike>(
  terminal: WebglTerminalLike,
  createAddon: () => T,
  options?: WebglRecoveryOptions<T>,
): T | null {
  const retries = options?.retries ?? 2;
  const delayMs = options?.delayMs ?? 1000;
  const schedule =
    options?.schedule ?? ((callback: () => void) => setTimeout(callback, delayMs));

  function scheduleRecovery(remaining: number) {
    if (remaining <= 0 || options?.enabled?.() === false) return;
    schedule(() => {
      if (options?.enabled?.() === false) return;
      let created: T | null = null;
      try {
        created = createAddon();
        terminal.loadAddon(created);
      } catch {
        // context 仍不可用：清理半初始化 addon，留待下一次（若有预算）。
        try {
          created?.dispose();
        } catch {
          /* noop */
        }
        created = null;
      }
      if (created) {
        wireRecovery(created, remaining - 1);
        options?.onRecovered?.(created);
      } else {
        scheduleRecovery(remaining - 1);
      }
    });
  }

  function wireRecovery(addon: T, remaining: number) {
    addon.onContextLoss(() => {
      try {
        addon.dispose();
      } catch {
        /* noop */
      }
      scheduleRecovery(remaining);
    });
  }

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
  // 初始挂载失败不重试（无 WebGL 是能力缺失，重试无意义）；只有成功挂载
  // 后丢 context 才值得重建。无选项时 remaining=0，等价于一次性 dispose。
  wireRecovery(addon, options ? retries : 0);
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
  options?: WebglRecoveryOptions<T>,
): T | null {
  if (!enabled) {
    current?.dispose();
    return null;
  }
  return current ?? attachWebglRenderer(terminal, createAddon, options);
}
