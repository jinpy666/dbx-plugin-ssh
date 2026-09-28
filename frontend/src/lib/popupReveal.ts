/**
 * 弹层动画冻结保险（"鬼影弹层"兜底）。
 *
 * reka 弹层（Popover/Dialog 等）的入场动画由 tw-animate-css 的 `enter`
 * keyframes 驱动，首帧 opacity=0。宿主渲染器一旦冻结 CSS 动画（GPU 合成
 * 停摆、动画被节流的 Linux webview 等），弹层会永远停在透明帧——用户点击
 * 按钮后"弹窗出不来"，控制台也没有任何报错（mockDbxHost 的 ?noanim 注释
 * 记载过同款现象）。
 *
 * 应对：watchPopupReveal 以 body 级 MutationObserver 监听弹层挂载（reka
 * portal 到 body；组件 ref 只能拿到 portal 锚点注释节点，够不着真正的弹层
 * 元素），安排一次延迟观察——届时弹层仍不足全不透明，就把卡住的动画
 * finish 到终态：fill-mode 为 none，动画结束后回落自然样式（opacity 1），
 * 弹窗立即显形。正常宿主动画 duration-100 远早于观察点结束，这里不会出手，
 * 零视觉差异；只处理入场，退场冻结只影响卸载时机、不影响可见性。
 */
const REVEAL_DELAY_MS = 300;

/** 弹层本体（wrapper 统一携带的 data-slot），定位/装饰性外层不在其列。 */
const POPUP_LAYER_SELECTOR =
  '[data-slot="popover-content"], [data-slot="dialog-content"], [data-slot="select-content"], [data-slot="context-menu-content"]';

/** 立即检查一次：不足全不透明则把 running/paused 的冻结动画推到终态。
 *  返回是否实际出手（供单测断言）。 */
export function popupRevealKick(el: Element): boolean {
  if (!el.isConnected) return false;
  const win = el.ownerDocument?.defaultView;
  if (!win) return false;
  if (Number.parseFloat(win.getComputedStyle(el).opacity) >= 1) return false;
  if (typeof (el as HTMLElement).getAnimations === "function") {
    let kicked = false;
    for (const anim of (el as HTMLElement).getAnimations()) {
      if (anim.playState === "running" || anim.playState === "paused") {
        anim.finish();
        kicked = true;
      }
    }
    return kicked;
  }
  // 无 WAAPI 的老引擎兜底：直接摘除动画，落到自然可见样式。
  (el as HTMLElement).style.animation = "none";
  return true;
}

/** 弹层挂载后安排一次延迟观察；返回取消函数（单测用，生产路径可忽略）。 */
export function schedulePopupReveal(el: Element, delayMs: number = REVEAL_DELAY_MS): () => void {
  const timer = window.setTimeout(() => popupRevealKick(el), delayMs);
  return () => window.clearTimeout(timer);
}

let revealObserver: MutationObserver | undefined;

/** 全局监听弹层挂载并安排各自的 reveal。MutationObserver 回调走微任务，
 *  不依赖渲染帧——动画冻结的宿主里照样触发（定时器亦不受渲染停摆影响）。 */
export function watchPopupReveal(root: ParentNode = document.body): void {
  if (revealObserver || typeof MutationObserver === "undefined") return;
  revealObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const layer = node.matches(POPUP_LAYER_SELECTOR)
          ? node
          : node.querySelector(POPUP_LAYER_SELECTOR);
        if (layer) schedulePopupReveal(layer);
      }
    }
  });
  revealObserver.observe(root, { childList: true, subtree: true });
}
