import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { TerminalThemeLike } from "../lib/terminalScheme";
import { createRequestEpoch } from "../lib/requestEpoch";
import { buildTimeline, eventIndexAtTime, mergeEventPages, replayDuration, type ReplayEvent, type ReplayEventPage } from "../lib/replayScheduler";
import { terminalOptionPatch } from "../lib/terminalAppearance";
import { resolveTerminalFont, type TerminalFontOverride } from "../lib/terminalFont";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";

/** 回放播放器（自 useRecording 纯搬移）：事件一次性拉全（分页合并，封顶
 * 2 万事件）→ 离屏 xterm 跟随终端外观（配色/字体/字号/字重/行高/字间距）
 * → rAF 按时间轴推进。播放头与倍速锚定语义（倍速切档重锚墙钟）、seek 重放
 * 与请求序号守卫（快速连点两条录制时晚到的旧加载不得顶替新回放）都在此
 * 收口；录制列表/导出只经返回面读 replayState。 */
export function useReplayPlayer(options: {
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  appearance: Ref<{ terminal: { fontSize: number } }>;
  terminalTheme: () => TerminalThemeLike;
  terminalFontOverride: Ref<TerminalFontOverride>;
  terminalAppearance: Ref<import("../lib/terminalAppearance").TerminalAppearanceState>;
  hostFontFamily: () => string;
}) {
  const { showError, appearance, terminalTheme, terminalFontOverride, terminalAppearance, hostFontFamily } = options;

  const replayState = ref<{ summary: import("../lib/replayScheduler").RecordingSummary; events: ReplayEvent[] } | null>(null);
  const replayPlaying = ref(false);
  const replaySpeed = ref(1);
  const replayPlayheadMs = ref(0);
  const replayHost = ref<HTMLDivElement | null>(null);

  const REPLAY_EVENT_CAP = 20000;
  let replayTerminal: Terminal | null = null;
  let replayTimeline: number[] = [];
  let replayWriteIndex = 0;
  let replayRaf = 0;
  let replayStartWall = 0;
  let replayStartPlayhead = 0;
  const replayDurationMs = computed(() => (replayState.value ? replayDuration(replayState.value.events) * 1000 : 0));

  async function loadReplayEvents(recordingId: string): Promise<ReplayEvent[]> {
    const pages: ReplayEventPage[] = [];
    let offset = 0;
    for (;;) {
      const page = await window.dbxPlugin.invoke<ReplayEventPage>("ssh/recording/get", { recordingId, offset, limit: 500 });
      pages.push(page);
      offset += page.events.length;
      if (!page.hasMore || offset >= page.total || offset >= REPLAY_EVENT_CAP) break;
    }
    return mergeEventPages(pages);
  }

  // 回放打开也走请求序号守卫：大录制（2 万事件封顶）分页拉取可达数秒，快速
  // 连点两条录制时，晚到的旧加载不得关闭/顶替用户新打开的回放。
  const replayEpoch = createRequestEpoch();

  async function openReplay(item: import("../lib/replayScheduler").RecordingSummary) {
    const epoch = replayEpoch.next();
    try {
      const events = await loadReplayEvents(item.recordingId);
      if (!replayEpoch.isCurrent(epoch)) return;
      closeReplay();
      replayState.value = { summary: item, events };
      replayTimeline = buildTimeline(events, 1);
      replayWriteIndex = 0;
      replayPlayheadMs.value = 0;
      replayPlaying.value = false;
      await nextTick();
      if (replayHost.value) {
        // 回放终端跟随终端外观（配色/字体/字号/字重/行高/字间距），
        // 不再是默认纯黑 xterm，也不与主终端产生字形差异。
        const font = resolveTerminalFont(terminalFontOverride.value, {
          fontFamily: hostFontFamily(),
          fontSize: appearance.value.terminal.fontSize,
        });
        const optionPatch = terminalOptionPatch(terminalAppearance.value.settings);
        replayTerminal = new Terminal({
          cols: 100,
          rows: 26,
          convertEol: false,
          // 下方 unicode.activeVersion 属 proposed API；缺此开关会在弹窗打开时
          // 直接抛 "allowProposedApi option" 错误横幅（与主终端 2391 同因）。
          allowProposedApi: true,
          theme: terminalTheme(),
          fontFamily: font.fontFamily,
          fontSize: font.fontSize,
          fontWeight: optionPatch.fontWeight,
          fontWeightBold: optionPatch.fontWeightBold,
          lineHeight: optionPatch.lineHeight,
          letterSpacing: optionPatch.letterSpacing,
          drawBoldTextInBrightColors: optionPatch.drawBoldTextInBrightColors,
        });
        replayTerminal.open(replayHost.value);
        // 与主终端同用 Unicode 11 宽度表：emoji/宽字符行在回放里保持相同折行。
        replayTerminal.loadAddon(new Unicode11Addon());
        replayTerminal.unicode.activeVersion = "11";
      }
    } catch (cause) {
      if (replayEpoch.isCurrent(epoch)) showError(cause);
    }
  }

  function closeReplay() {
    cancelAnimationFrame(replayRaf);
    replayPlaying.value = false;
    replayTerminal?.dispose();
    replayTerminal = null;
    replayState.value = null;
  }

  function stopReplayLoop() {
    cancelAnimationFrame(replayRaf);
    replayPlaying.value = false;
  }

  function replayFrame() {
    const state = replayState.value;
    if (!state || !replayPlaying.value) return;
    const elapsed = (performance.now() - replayStartWall) * replaySpeed.value;
    replayPlayheadMs.value = Math.min(replayDurationMs.value, replayStartPlayhead + elapsed);
    const target = eventIndexAtTime(replayTimeline, replayPlayheadMs.value);
    while (replayWriteIndex < target) {
      replayTerminal?.write(state.events[replayWriteIndex]!.data);
      replayWriteIndex += 1;
    }
    if (replayPlayheadMs.value >= replayDurationMs.value) {
      stopReplayLoop();
      return;
    }
    replayRaf = requestAnimationFrame(replayFrame);
  }

  function toggleReplayPlay() {
    if (!replayState.value) return;
    if (replayPlaying.value) {
      stopReplayLoop();
      return;
    }
    replayStartWall = performance.now();
    replayStartPlayhead = replayPlayheadMs.value;
    replayPlaying.value = true;
    replayRaf = requestAnimationFrame(replayFrame);
  }

  // 倍速只改推进速率，不改进度本身：播放中改档必须以当前进度重新锚定墙钟
  // 基准，否则 elapsed = (now - startWall) × 新倍率会把已播时长整段放大
  // （1x 播到 60s 切 2x，播放头直接跳到 120s）。
  watch(replaySpeed, () => {
    if (!replayPlaying.value) return;
    replayStartPlayhead = replayPlayheadMs.value;
    replayStartWall = performance.now();
  });

  function onReplaySeek(event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || !replayState.value) return;
    cancelAnimationFrame(replayRaf);
    replayPlaying.value = false;
    replayPlayheadMs.value = value;
    replayStartPlayhead = value;
    replayStartWall = performance.now();
    replayWriteIndex = eventIndexAtTime(replayTimeline, value);
    replayTerminal?.reset();
    for (let index = 0; index < replayWriteIndex; index += 1) {
      replayTerminal?.write(replayState.value.events[index]!.data);
    }
  }

  onBeforeUnmount(() => {
    cancelAnimationFrame(replayRaf);
    replayTerminal?.dispose();
    replayTerminal = null;
  });

  return {
    REPLAY_EVENT_CAP,
    replayState,
    replayPlaying,
    replaySpeed,
    replayPlayheadMs,
    replayDurationMs,
    replayHost,
    loadReplayEvents,
    openReplay,
    closeReplay,
    stopReplayLoop,
    replayFrame,
    toggleReplayPlay,
    onReplaySeek,
  };
}
