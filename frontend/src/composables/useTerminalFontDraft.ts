import { ref } from "vue";
import { clampFontSize } from "../lib/terminalZoom";

/** 终端字体设置控件态（issue #31，自 SettingsDialog 纯搬移）：预设等宽字体 +
 * 跟随宿主 + 自定义；哨兵值只作选择器键，不会作为字体串写入（写入前映射回
 * null/真实字体串）。应用动作经 applyFont 回调上抛（落 xterm、持久化与 toast
 * 在 App），应用后本地控件立即回显真实覆盖态（避免草稿漂移）。 */
export const TERMINAL_FONT_FOLLOW_HOST = "__follow-host__";
export const TERMINAL_FONT_CUSTOM = "__custom__";
export const TERMINAL_FONT_PRESETS: Array<{ value: string; label: string }> = [
  { value: "'JetBrains Mono', Consolas, monospace", label: "JetBrains Mono" },
  { value: "'Cascadia Code', 'Cascadia Mono', monospace", label: "Cascadia Code" },
  { value: "'Fira Code', monospace", label: "Fira Code" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro" },
  { value: "Menlo, Monaco, monospace", label: "Menlo" },
  { value: "Consolas, 'Courier New', monospace", label: "Consolas" },
  { value: "'DejaVu Sans Mono', monospace", label: "DejaVu Sans Mono" },
  { value: "monospace", label: "monospace" },
];

export function useTerminalFontDraft(options: {
  /** 终端当前生效字号（缩放链路在 App）。 */
  terminalFontSize: () => number;
  /** 宿主主题基准字号（「恢复默认」与非法输入的回落值）。 */
  hostFontSize: () => number;
  /** 应用字体覆盖（null = 跟随宿主）。 */
  applyFont: (payload: { family: string | null; size: number }) => void;
}) {
  const { terminalFontSize, hostFontSize, applyFont } = options;

  const terminalFontFamilyChoice = ref(TERMINAL_FONT_FOLLOW_HOST);
  const terminalFontCustomDraft = ref("");
  const terminalFontSizeDraft = ref(String(terminalFontSize()));

  /** 字体控件回显当前覆盖态：初始化与应用/恢复默认后都会刷新，避免草稿漂移。 */
  function syncFontControls(family: string | null, size: number) {
    if (!family) {
      terminalFontFamilyChoice.value = TERMINAL_FONT_FOLLOW_HOST;
      terminalFontCustomDraft.value = "";
    } else if (TERMINAL_FONT_PRESETS.some((preset) => preset.value === family)) {
      terminalFontFamilyChoice.value = family;
      terminalFontCustomDraft.value = "";
    } else {
      terminalFontFamilyChoice.value = TERMINAL_FONT_CUSTOM;
      terminalFontCustomDraft.value = family;
    }
    terminalFontSizeDraft.value = String(size);
  }

  /// 应用用户字体设置：应用侧（App）负责落到 xterm、持久化与 toast。
  function applyTerminalFont(family: string | null, size: number) {
    applyFont({ family, size });
    syncFontControls(family, size);
  }

  /** 设置页字体族下拉：跟随宿主/预设即时应用并持久化；选「自定义」时仅展开
   *  输入框，待输入 @change 再应用（applyTerminalFontFromControls）。 */
  function onTerminalFontFamilyChoice(choice: string) {
    terminalFontFamilyChoice.value = choice;
    if (choice === TERMINAL_FONT_CUSTOM) return;
    applyTerminalFont(choice === TERMINAL_FONT_FOLLOW_HOST ? null : choice, terminalFontSize());
  }

  function applyTerminalFontFromControls() {
    let family: string | null;
    if (terminalFontFamilyChoice.value === TERMINAL_FONT_CUSTOM) {
      const custom = terminalFontCustomDraft.value.trim();
      family = custom.length > 0 ? custom : null; // 空自定义视作跟随宿主
    } else if (terminalFontFamilyChoice.value === TERMINAL_FONT_FOLLOW_HOST) {
      family = null;
    } else {
      family = terminalFontFamilyChoice.value;
    }
    const parsed = Number(terminalFontSizeDraft.value);
    const size = Number.isFinite(parsed) && parsed > 0 ? clampFontSize(parsed, 0) : hostFontSize();
    applyTerminalFont(family, size);
  }

  return {
    terminalFontFamilyChoice,
    terminalFontCustomDraft,
    terminalFontSizeDraft,
    syncFontControls,
    applyTerminalFont,
    onTerminalFontFamilyChoice,
    applyTerminalFontFromControls,
  };
}
