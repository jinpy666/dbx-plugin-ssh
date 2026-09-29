import type { Terminal } from "@xterm/xterm";
import type { TerminalAppearanceState } from "../lib/terminalAppearance";
import type { TerminalFontOverride } from "../lib/terminalFont";
import { onBeforeUnmount, type Ref } from "vue";
import { persistTerminalFontFamily, persistTerminalFontSize } from "../lib/terminalFont";
import { clampFontSize } from "../lib/terminalZoom";

/** 终端缩放与字体设置落地：缩放只动字号（主题基准优先，其次宿主基准）；
 * 字体落地唯一入口 setTerminalFont（内存覆盖态 + terminalFont 两键 + xterm
 * 生效值），null = 跟随宿主（主题快照的「未指定」语义）。 */
export function useTerminalFontZoom(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  appearance: Ref<DbxPluginAppearance & { ui: { fontFamily: string } }>;
  terminalAppearance: Ref<TerminalAppearanceState>;
  terminalFontOverride: Ref<TerminalFontOverride>;
  terminalFontSize: Ref<number>;
  terminal: () => Terminal | undefined;
  scheduleFit: () => void;
  hostTerminalFontFamily: (resolved: DbxPluginAppearance & { ui: { fontFamily: string } }) => string;
}) {
  const { terminal: terminalGet, t, showNotice, appearance, terminalAppearance, terminalFontOverride, terminalFontSize, scheduleFit, hostTerminalFontFamily } = options;

  let zoomNoticeTimer = 0;

function adjustTerminalZoom(delta: number) {
  const current = terminalFontSize.value;
  const next = clampFontSize(current, delta);
  if (next === current) return;
  applyTerminalFontSize(next);
}

function resetTerminalZoom() {
  // 主题可能自带字号（外观快照的 font.size）：复位回到「主题基准」，没有主题
  // 或主题未指定字号时才回宿主基准（= 既有行为）。
  const base = terminalAppearance.value.font.size ?? appearance.value.terminal.fontSize;
  if (terminalFontSize.value === base) return;
  applyTerminalFontSize(base);
}

/**
 * 字体落地唯一入口：内存覆盖态 + terminalFont 两个键 + xterm 生效值。
 * `size` 允许为 null（跟随宿主字号）——主题快照的「未指定」语义靠它表达，
 * 若在此处把 null 折成宿主具体值，快照与实况就会永远不相等、主题无法高亮。
 */
function setTerminalFont(family: string | null, size: number | null) {
  terminalFontOverride.value = { fontFamily: family, fontSize: size };
  persistTerminalFontFamily(family);
  persistTerminalFontSize(size);
  const effectiveSize = size ?? appearance.value.terminal.fontSize;
  terminalFontSize.value = effectiveSize;
  const term = terminalGet();
  if (term) {
    term.options.fontFamily = family ?? hostTerminalFontFamily(appearance.value);
    term.options.fontSize = effectiveSize;
    scheduleFit();
  }
}

// 缩放只动字号：同步内存覆盖态并经 lib 持久化（键与解析逻辑集中在 terminalFont.ts）。
function applyTerminalFontSize(size: number) {
  setTerminalFont(terminalFontOverride.value.fontFamily, size);
  window.clearTimeout(zoomNoticeTimer);
  zoomNoticeTimer = window.setTimeout(() => showNotice(t("terminalZoom.fontSize", { size })), 500);
}

// 应用用户字体设置并持久化：family null = 恢复跟随宿主。立即生效并 toast 反馈。
function applyTerminalFontSettings(family: string | null, size: number) {
  const followHost = family == null;
  setTerminalFont(family, size);
  showNotice(followHost ? t("terminalFont.resetDone") : t("terminalFont.applied", { size }));
}


  onBeforeUnmount(() => {
    window.clearTimeout(zoomNoticeTimer);
  });

  return {
    adjustTerminalZoom,
    resetTerminalZoom,
    setTerminalFont,
    applyTerminalFontSize,
    applyTerminalFontSettings,
  };
}
