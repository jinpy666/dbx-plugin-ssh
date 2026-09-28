// Docker 容器行「操作」悬浮下拉的开关状态机（DockerPanel 用）。
// hover 触发器延迟开（防扫行误开）；移出触发器/菜单延迟关（留出跨
// side-offset 间隙的时间）；进入菜单内容立即取消关闭；click 直接切换
// （触屏/键盘兜底）。纯状态逻辑，便于假定时器单测。
import { ref } from "vue";

export interface RowMenuControllerOptions {
  /** hover 触发器后延迟开启（ms）。 */
  openDelayMs?: number;
  /** 移出触发器/菜单后延迟关闭（ms）。 */
  closeDelayMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

/** 菜单开启途径：hover 延迟开，click/键盘/触屏立即开。 */
type OpenSource = "hover" | "click";

export interface RowMenuController {
  /** 当前打开菜单的行 id（空串 = 全关）。 */
  openId: ReturnType<typeof ref<string>>;
  isOpen(id: string): boolean;
  /** 当前打开的菜单是否由 hover 开启（DockerPanel 据此决定是否迁移焦点）。 */
  openedByHover(): boolean;
  hoverTrigger(id: string): void;
  leaveToClose(): void;
  hoverContent(): void;
  toggle(id: string): void;
  close(): void;
}

export function createRowMenuController(options: RowMenuControllerOptions = {}): RowMenuController {
  const openDelayMs = options.openDelayMs ?? 120;
  const closeDelayMs = options.closeDelayMs ?? 220;
  let openTimer: Timer | undefined;
  let closeTimer: Timer | undefined;

  const openId = ref("");
  let openSource: OpenSource = "hover";

  function clearTimers(): void {
    if (openTimer !== undefined) {
      clearTimeout(openTimer);
      openTimer = undefined;
    }
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  }

  function isOpen(id: string): boolean {
    return openId.value === id;
  }

  function openedByHover(): boolean {
    return openId.value !== "" && openSource === "hover";
  }

  /** 指针进入触发器：延迟开启该行菜单；已是当前菜单则只取消待关闭（回移不闪关）。 */
  function hoverTrigger(id: string): void {
    if (openId.value === id) {
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      return;
    }
    clearTimers();
    openTimer = setTimeout(() => {
      openTimer = undefined;
      openId.value = id;
      openSource = "hover";
    }, openDelayMs);
  }

  /** 指针移出触发器或菜单：延迟关闭（期间进入内容会被 hoverContent 取消）。
   *  click 开启的菜单已「钉住」，移出不关，等外部点击/Esc/选项点击/re-toggle 收口。 */
  function leaveToClose(): void {
    if (openId.value !== "" && openSource === "click") return;
    clearTimers();
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      openId.value = "";
    }, closeDelayMs);
  }

  /** 指针进入菜单内容：取消待关闭。 */
  function hoverContent(): void {
    clearTimers();
  }

  /** 点击触发器：直接切换（触屏/键盘场景，无延迟）。对 hover 已开的菜单，
   *  点击视为「钉住」——保持开启并转为 click 来源，再点一次才收口；
   *  否则悬停后想固定菜单的鼠标点击会被误判成关闭。 */
  function toggle(id: string): void {
    clearTimers();
    if (openId.value === id && openSource === "hover") {
      openSource = "click";
      return;
    }
    openSource = "click";
    openId.value = openId.value === id ? "" : id;
  }

  /** 立即关闭（选项点击、外部点击、Esc、组件卸载）。 */
  function close(): void {
    clearTimers();
    openId.value = "";
  }

  return { openId, isOpen, openedByHover, hoverTrigger, leaveToClose, hoverContent, toggle, close };
}
