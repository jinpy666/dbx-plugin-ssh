import type { TerminalBehaviorSettings } from "../lib/terminalBehavior";
import { onBeforeUnmount } from "vue";
import { ref, type Ref } from "vue";
import { Terminal } from "@xterm/xterm";

/** 终端响铃（对标 Tabby「Terminal → Sound」）：xterm 6.x 只抛 onBell，
 * 视觉/听觉两态按设置自行实现；听觉用 WebAudio 现场合成（沙箱拒绝或
 * 自动播放静默时退化为视觉闪，保证至少有可见反馈）。 */
export function useTerminalBell(options: { terminalBehavior: Ref<TerminalBehaviorSettings> }) {
  const { terminalBehavior } = options;

/** 视觉响铃高亮时长（对标 Tabby bell: visual 的一次闪烁）。 */
const TERMINAL_BELL_FLASH_MS = 150;
/** 连响时先摘类、下一帧再加回，否则浏览器认为动画仍在播放不会重播。 */
const TERMINAL_BELL_RETRIGGER_MS = 0;
/** 听觉响铃的合成参数：短促一声 A5 正弦音，音量取保守值避免惊吓。 */
const TERMINAL_BELL_FREQUENCY_HZ = 880;
const TERMINAL_BELL_GAIN = 0.08;
const TERMINAL_BELL_DURATION_S = 0.15;
/** 响铃视觉提示的短暂高亮（xterm 6.x 无 bellStyle，须自行实现）。 */
const terminalBellFlash = ref(false);
let terminalBellFlashTimer = 0;
let bellAudioContext: AudioContext | undefined;

/**
 * 终端响铃（对标 Tabby「Terminal → Sound」）：xterm 6.x 只抛 onBell、
 * 不再有 bellStyle，「视觉 / 听觉」两态在这里按设置自行实现。
 */
function handleTerminalBell() {
  if (terminalBehavior.value.bell === "visual") flashTerminalBell();
  else if (terminalBehavior.value.bell === "audible") playTerminalBell();
}

/**
 * 视觉响铃：给终端区域加一个短暂高亮类。先摘掉类、下一帧再加回，否则连续
 * 响铃时浏览器认为动画已在播放，不会重新触发。
 */
function flashTerminalBell() {
  window.clearTimeout(terminalBellFlashTimer);
  terminalBellFlash.value = false;
  terminalBellFlashTimer = window.setTimeout(() => {
    terminalBellFlash.value = true;
    terminalBellFlashTimer = window.setTimeout(() => {
      terminalBellFlash.value = false;
    }, TERMINAL_BELL_FLASH_MS);
  }, TERMINAL_BELL_RETRIGGER_MS);
}

/**
 * 听觉响铃：不引入音频资源（仓库规则禁止新增运行时依赖，二进制资源也无必要），
 * 用 WebAudio 现场合成一声短促正弦提示音。AudioContext 懒建并复用。沙箱可能
 * 直接拒绝构造，或自动播放策略让声音静默挂起；两种情况下都退化为视觉闪动，
 * 保证响铃至少有可见反馈，不抛错打断终端。
 */
function playTerminalBell() {
  try {
    bellAudioContext ??= new AudioContext();
    const context = bellAudioContext;
    void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = TERMINAL_BELL_FREQUENCY_HZ;
    const startedAt = context.currentTime;
    // 用指数包络避免方波式的爆音；起止值不能为 0（指数斜坡不接受 0）。
    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(TERMINAL_BELL_GAIN, startedAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + TERMINAL_BELL_DURATION_S);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startedAt);
    oscillator.stop(startedAt + TERMINAL_BELL_DURATION_S);
  } catch {
    flashTerminalBell();
  }
}

  onBeforeUnmount(() => {
    window.clearTimeout(terminalBellFlashTimer);
    terminalBellFlash.value = false;
  });

  return {
    terminalBellFlash,
    handleTerminalBell,
  };
}
