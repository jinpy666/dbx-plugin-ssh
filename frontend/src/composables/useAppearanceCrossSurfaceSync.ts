import { onBeforeUnmount } from "vue";
import {
  APPEARANCE_SYNC_KEYS,
  createAppearanceSyncModel,
  type AppearanceSyncDecision,
  type AppearanceSyncSnapshot,
} from "../lib/appearanceSync";
import type { TerminalAppearanceState } from "../lib/terminalAppearance";
import type { TerminalFontOverride } from "../lib/terminalFont";

/**
 * 跨表面终端外观同步驱动（tab ↔ dock 面板）：低频轮询直读宿主桥/localStorage
 * 上的外观三键，配合 visibilitychange（隐藏期间停轮询、复现即补一拍）与
 * localStorage 原生 storage 事件（浏览器直连通道的即时通知），让「tab 里改
 * 配色」秒级传导到底部栏终端（反之亦然）。
 *
 * 防自写回落竞态（本端写穿在桥上落地前轮询会读回旧值）由 lib 状态机的两条
 * 独立闸门承担：App 侧在 terminalAppearance / terminalFontOverride 变化时分别
 * 调 noteAppearanceWrite / noteFontWrite。reader 为 null（内存通道/单测）时
 * 同步整体禁用，两个 note 均为空操作。
 */
export function useAppearanceCrossSurfaceSync(options: {
  reader: ((key: string) => Promise<string | null>) | null;
  /** localStorage 档的即时通知（原生 storage 事件）；桥档不传。 */
  subscribe?: (listener: () => void) => () => void;
  currentAppearance: () => TerminalAppearanceState;
  currentFont: () => TerminalFontOverride;
  /** 采纳远端变化：按 decision 的非空部分落地（外观/字体各自独立）。 */
  adopt: (decision: AppearanceSyncDecision) => void;
  intervalMs?: number;
}) {
  if (!options.reader) {
    return { noteAppearanceWrite: () => {}, noteFontWrite: () => {} };
  }

  const model = createAppearanceSyncModel({ currentAppearance: options.currentAppearance, currentFont: options.currentFont });
  const intervalMs = options.intervalMs ?? 1500;
  let timer = 0;
  let ticking = false;
  let rerunQueued = false;

  const visibleNow = () => typeof document === "undefined" || document.visibilityState === "visible";

  async function tick() {
    if (ticking) {
      rerunQueued = true;
      return;
    }
    ticking = true;
    try {
      // 隐藏的 webview 不打扰宿主桥；复现时 visibilitychange 会补一拍。
      while (visibleNow()) {
        rerunQueued = false;
        const [appearance, fontFamily, fontSize] = await Promise.all([
          options.reader!(APPEARANCE_SYNC_KEYS.appearance),
          options.reader!(APPEARANCE_SYNC_KEYS.fontFamily),
          options.reader!(APPEARANCE_SYNC_KEYS.fontSize),
        ]);
        const decision = model.tick({ appearance, fontFamily, fontSize } satisfies AppearanceSyncSnapshot);
        if (decision.appearance || decision.font) {
          options.adopt(decision);
        }
        if (!rerunQueued) break;
      }
    } catch {
      // 桥抖动/文档销毁：跳过本轮，下轮定时器重试。
    } finally {
      ticking = false;
    }
  }

  /** 立即补一拍（去抖到微任务，事件风暴下合并）。 */
  function schedule() {
    queueMicrotask(() => void tick());
  }

  timer = window.setInterval(() => void tick(), intervalMs);
  const unsubscribe = options.subscribe?.(schedule);
  const onVisibility = () => {
    if (visibleNow()) schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onVisibility);

  onBeforeUnmount(() => {
    window.clearInterval(timer);
    unsubscribe?.();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onVisibility);
  });

  return {
    noteAppearanceWrite: () => model.noteAppearanceWrite(),
    noteFontWrite: () => model.noteFontWrite(),
  };
}
