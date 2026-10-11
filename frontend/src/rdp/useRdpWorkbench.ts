// RDP 会话工作台专属逻辑（P1 隔离收口）：SSH 工具在 RDP 连接上整类隐藏后，
// 远程桌面自己需要的操作面——缩放三档（纯模板态，留守 App.vue）+ 大文本粘贴
// 双通道（写远端剪贴板 / 按键注入）+ 分辨率入口（预设/窗口比例/自定义）。
//
// 依赖单向：本模块只吃注入的 refs/回调（rdpSession/rdpSurface/sendRdpInput/
// sendRdpClipboard/persistState...），不 import App.vue，也不 import 任何
// SSH 内部符号——App.vue 是唯一消费方。
import { ref, type Ref } from "vue";
import type { RdpInputEvent } from "./rdpFrame";

/** RDP 会话内用户选择的桌面尺寸（持久化到 workbenchState 的 rdpWidth/Height，
 * 恢复 tab 时优先于连接表单的 rdp_resolution——会话内显式选择是更近的意图）。*/
export interface RdpPersistedSize {
  width: number;
  height: number;
}

export function useRdpWorkbench(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  showNotice: (message: string) => void;
  persistState: () => void;
  isRdpMode: Ref<boolean>;
  rdpSession: Ref<{ sessionId: string } | null>;
  rdpSurface: Ref<{ $el?: any } | null>;
  sendRdpInput: (event: RdpInputEvent) => void;
  sendRdpClipboard: (text: string) => void;
}) {
  const { t, showError, showNotice, persistState, isRdpMode, rdpSession, rdpSurface, sendRdpInput, sendRdpClipboard } =
    options;

  // —— 大文本粘贴（与连接表单同一组文案）：写入远端剪贴板（快，远端 Ctrl+V）
  // 或按键注入（慢，剪贴板被禁时兜底，4k 字符/次为后端上限，分片发送）。——
  const rdpPasteOpen = ref(false);
  const rdpPasteText = ref("");
  const rdpTypingBusy = ref(false);
  const rdpTypingSent = ref(0);
  const rdpTypingTotal = ref(0);

  function rdpWriteRemoteClipboard() {
    const text = rdpPasteText.value;
    if (!text) return;
    sendRdpClipboard(text);
  }

  async function rdpTypeAsKeystrokes() {
    const text = rdpPasteText.value;
    if (!text || rdpTypingBusy.value) return;
    rdpTypingBusy.value = true;
    rdpTypingSent.value = 0;
    rdpTypingTotal.value = text.length;
    const chunkSize = 512;
    try {
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        if (!isRdpMode.value) break;
        sendRdpInput({ kind: "unicode", text: text.slice(offset, offset + chunkSize) });
        rdpTypingSent.value = Math.min(offset + chunkSize, text.length);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } finally {
      rdpTypingBusy.value = false;
    }
  }

  // —— 分辨率入口（P0-2）：预设 + 自定义宽高，走 rdp/resize。后端语义是
  // “以新尺寸重连”（会话内 display control PDU 真机不生效），sessionId 不变，
  // 状态由 rdp/session/state 事件驱动回 connecting→running。选择持久化进
  // workbenchState（rdpWidth/rdpHeight），恢复 tab 时优先于连接表单。 ——
  const RDP_RESOLUTION_PRESETS: ReadonlyArray<{ width: number; height: number }> = [
    { width: 1280, height: 800 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ];
  const rdpResolutionOpen = ref(false);
  const rdpCustomWidth = ref("");
  const rdpCustomHeight = ref("");
  const rdpResizing = ref(false);
  const rdpDesktopSize = ref<{ width: number; height: number } | null>(null);
  const rdpPersistedSize = ref<RdpPersistedSize | null>(null);

  function rdpResolutionLabel(width: number, height: number): string {
    return `${width}×${height}`;
  }

  function isRdpResolutionActive(width: number, height: number): boolean {
    return rdpDesktopSize.value?.width === width && rdpDesktopSize.value?.height === height;
  }

  /** “窗口比例”预设：按画布容器当前可视区宽高比生成偶数宽高（高度上限 1440，
   * 再夹进 640x480..3840x2160 契约门限），保持与视口一致的宽高比。 */
  function rdpWindowProportionPreset(): { width: number; height: number } {
    const holder = rdpSurface.value?.$el as HTMLElement | undefined;
    const rect = holder?.getBoundingClientRect();
    const ratio = rect && rect.height > 0 ? rect.width / rect.height : 16 / 9;
    const height = Math.min(1440, Math.max(720, Math.round(1440 / ratio / 2) * 2));
    const width = Math.max(640, Math.min(3840, Math.round((height * ratio) / 2) * 2));
    return { width, height: Math.max(480, Math.min(2160, height)) };
  }

  async function applyRdpResolution(width: number, height: number) {
    const sessionId = rdpSession.value?.sessionId;
    if (!sessionId || rdpResizing.value) return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || width > 3840 || height < 480 || height > 2160) {
      showError(new Error(t("rdp.sizeError")), "terminal");
      return;
    }
    rdpResizing.value = true;
    try {
      await window.dbxPlugin.invoke("rdp/resize", { sessionId, width, height });
      rdpPersistedSize.value = { width, height };
      persistState();
      showNotice(t("rdp.resolution.applied", { width, height }));
      rdpResolutionOpen.value = false;
    } catch (cause) {
      showError(cause, "terminal");
    } finally {
      rdpResizing.value = false;
    }
  }

  async function applyRdpCustomResolution() {
    const width = Number.parseInt(rdpCustomWidth.value, 10);
    const height = Number.parseInt(rdpCustomHeight.value, 10);
    await applyRdpResolution(width, height);
  }

  return {
    rdpPasteOpen,
    rdpPasteText,
    rdpTypingBusy,
    rdpTypingSent,
    rdpTypingTotal,
    rdpWriteRemoteClipboard,
    rdpTypeAsKeystrokes,
    RDP_RESOLUTION_PRESETS,
    rdpResolutionOpen,
    rdpCustomWidth,
    rdpCustomHeight,
    rdpResizing,
    rdpDesktopSize,
    rdpPersistedSize,
    rdpResolutionLabel,
    isRdpResolutionActive,
    rdpWindowProportionPreset,
    applyRdpResolution,
    applyRdpCustomResolution,
  };
}
