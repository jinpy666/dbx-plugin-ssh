import { ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import { cursorViewportRow, measureCellSizeFromDom } from "../lib/terminalAnchor";
import type { SuggestionAnchor } from "../lib/overlayPlacement";

/** 光标格换算的共享参数：.xterm-screen 原点 + 单元格尺寸 + buffer 坐标。 */
interface TerminalCellFrame {
  originLeft: number;
  originTop: number;
  cellWidth: number;
  cellHeight: number;
  cursorX: number;
  visibleRow: number;
}

/** 建议浮层的光标锚点（自 useCommandSuggestions 纯搬移，issue #120）：
 * xterm 私有渲染尺寸（css.cell 宽高）× 光标缓冲坐标，以 .xterm-screen（渲染
 * 内容区，位于 .xterm 内边距内侧）为原点——可配置的终端内边距由 screen rect
 * 自动计入，ghost 与两个建议浮层不再各自为政。textarea 平时被 xterm 移出
 * 屏幕（CSS left:-9999em，仅 IME 时定位），不可用作锚点。读不到（渲染器未
 * 就绪/内部结构变化）返回 null，浮层降级贴终端底部。 */
export function useTerminalSuggestionAnchor(options: {
  terminal: () => Terminal | undefined;
  getTerminalHost: () => HTMLElement | null | undefined;
}) {
  const { terminal: terminalGet, getTerminalHost } = options;

  // 翻转定位用的可视底界（terminal-host 实际高度，含让位后的净高）：
  // anchor 计算时顺带刷新，两个建议浮层据此决定下方/上方放置。
  const suggestionViewport = ref({ height: 0 });

  function readTerminalCellFrame(): TerminalCellFrame | null {
    const term = terminalGet();
    const host = getTerminalHost();
    if (!term || !host) return null;
    try {
      const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
      const cell = core?._renderService?.dimensions?.css?.cell;
      let cellWidth = cell?.width ?? 0;
      let cellHeight = cell?.height ?? 0;
      const screen = term.element?.querySelector(".xterm-screen");
      // 渲染器尺寸读不到（未就绪/WebGL 恢复切换窗口期，Windows 上更常见）时用
      // 渲染 DOM 实测兜底：此前直接 null → 浮层永久降级贴底、不跟随不翻转。
      if (!(cellWidth > 0) || !(cellHeight > 0)) {
        const fromDom = measureCellSizeFromDom(
          screen ?? null,
          term.element?.querySelector(".xterm-rows") ?? null,
          term.cols,
        );
        if (!fromDom) return null;
        cellWidth = fromDom.width;
        cellHeight = fromDom.height;
      }
      const buffer = term.buffer.active;
      // cursorY 已是视口内相对行；旧式 `cursorY - viewportY` 在回滚区出现后为负，浮层画出画布。
      const visibleRow = cursorViewportRow(buffer);
      const hostRect = host.getBoundingClientRect();
      const origin = (screen ?? term.element)?.getBoundingClientRect();
      if (!origin) return null;
      return {
        originLeft: origin.left - hostRect.left,
        originTop: origin.top - hostRect.top,
        cellWidth,
        cellHeight,
        cursorX: buffer.cursorX,
        visibleRow,
      };
    } catch {
      return null;
    }
  }

  function readTerminalSuggestionAnchor(): SuggestionAnchor | null {
    const frame = readTerminalCellFrame();
    if (!frame || !getTerminalHost()) return null;
    // 翻转定位的可视底界 = terminal-host 实际高度：batch-bar/标记条让位
    // （inset-bottom）后它比包含块 pane 矮，必须用 host 高度，否则浮层会
    // 越过终端文字区盖住 footer/批量条（issue #120 实机反馈）。
    suggestionViewport.value = { height: getTerminalHost()?.clientHeight ?? 0 };
    return {
      x: Math.round(frame.originLeft + frame.cursorX * frame.cellWidth),
      y: Math.round(frame.originTop + frame.visibleRow * frame.cellHeight),
      cellHeight: frame.cellHeight,
      cellWidth: frame.cellWidth,
    };
  }

  return { suggestionViewport, readTerminalCellFrame, readTerminalSuggestionAnchor };
}
