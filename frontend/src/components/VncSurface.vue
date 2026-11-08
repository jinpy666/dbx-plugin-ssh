<script setup lang="ts">
// VNC 画布表面（nyaterm-parity P2 2d）：接收 App.vue 解码好的帧补丁做
// putImageData 增量绘制（rAF 合帧），fit/stretch/actual 三种前端缩放，
// 键鼠事件经 keysym 映射后交给父组件发送（vnc/input）。状态覆盖层
// （connecting/closed）由 App.vue 的 terminal-overlay 分支承担，本组件
// 只负责活的桌面画面与输入采集。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { decodeVncFramePatch, mapKeyboardEventToVncKeysym, pointerButtonMask, type VncFramePatch, type VncInputEvent } from "../lib/vncFrame";

interface Props {
  scaleMode: "fit" | "stretch" | "actual";
}
const props = defineProps<Props>();
const emit = defineEmits<{ input: [VncInputEvent]; "clipboard-out": [string] }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const holderRef = ref<HTMLDivElement | null>(null);
const desktopSize = ref<{ width: number; height: number } | null>(null);
const focused = ref(false);

// rAF 合帧队列：同一帧内的多个补丁一次绘制，避免高频 update 撕裂。
let pendingPatches: VncFramePatch[] = [];
let drawScheduled = false;
let lastSequence = -1;

/** 上一次按 fit 算出的画布显示尺寸（CSS 像素）；null 表示交给样式表。 */
const fittedSize = ref<{ width: number; height: number } | null>(null);
/** fit 模式下画布相对 holder 的偏移（letterbox），指针换算要减掉。 */
const fittedOffset = ref<{ x: number; y: number }>({ x: 0, y: 0 });

const scaleClass = computed(() => `vnc-scale-${props.scaleMode}`);

const canvasStyle = computed(() => {
  const size = fittedSize.value;
  if (props.scaleMode !== "fit" || !size) return undefined;
  return { width: `${size.width}px`, height: `${size.height}px` };
});

let resizeObserver: ResizeObserver | undefined;

/**
 * fit 缩放必须在脚本里算：只靠 CSS `width/height:100%` + object-fit，
 * canvas 的 CSS 尺寸会被撑到面板大小，而位图仍是远端分辨率，两者比例
 * 一旦不同就是拉伸；同时 `max-width/max-height` 又不会放大，于是画面
 * 缩在角落、四周留白。这里按含比例算出唯一尺寸，并把剩余空间作为居中
 * 偏移，指针换算用同一套偏移，点哪打哪。
 */
function applyDisplaySize() {
  const holder = holderRef.value;
  const size = desktopSize.value;
  if (!holder || !size || size.width === 0 || size.height === 0) {
    fittedSize.value = null;
    fittedOffset.value = { x: 0, y: 0 };
    return;
  }
  if (props.scaleMode !== "fit") {
    fittedSize.value = null;
    fittedOffset.value = { x: 0, y: 0 };
    return;
  }
  const availableWidth = holder.clientWidth;
  const availableHeight = holder.clientHeight;
  if (availableWidth <= 0 || availableHeight <= 0) return;
  const scale = Math.min(availableWidth / size.width, availableHeight / size.height);
  const width = Math.floor(size.width * scale);
  const height = Math.floor(size.height * scale);
  fittedSize.value = { width, height };
  fittedOffset.value = {
    x: Math.floor((availableWidth - width) / 2),
    y: Math.floor((availableHeight - height) / 2),
  };
}

onMounted(() => {
  window.addEventListener("keydown", onWindowKeyDown, true);
  const holder = holderRef.value;
  if (!holder || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(() => applyDisplaySize());
  resizeObserver.observe(holder);
  applyDisplaySize();
});

watch(
  () => props.scaleMode,
  () => applyDisplaySize(),
);

function scheduleDraw() {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    const queued = pendingPatches;
    pendingPatches = [];
    for (const patch of queued) drawPatch(patch);
  });
}

function drawPatch(patch: VncFramePatch) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  if (canvas.width !== patch.desktopWidth || canvas.height !== patch.desktopHeight) {
    canvas.width = patch.desktopWidth;
    canvas.height = patch.desktopHeight;
    desktopSize.value = { width: patch.desktopWidth, height: patch.desktopHeight };
    applyDisplaySize();
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(patch.width, patch.height);
  const rowBytes = patch.width * 4;
  if (patch.stride === rowBytes) {
    image.data.set(patch.payload.subarray(0, rowBytes * patch.height));
  } else {
    for (let row = 0; row < patch.height; row += 1) {
      const sourceStart = row * patch.stride;
      image.data.set(patch.payload.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
    }
  }
  context.putImageData(image, patch.x, patch.y);
}

/** App.vue 帧通道入口：原始二进制帧在这里解码、乱序丢弃后入绘制队列。 */
function acceptFrame(frame: Uint8Array): boolean {
  let patch: VncFramePatch;
  try {
    patch = decodeVncFramePatch(frame);
  } catch {
    // 非法帧直接丢弃（sidecar 侧同样的校验不该让坏帧走到这里）。
    return false;
  }
  if (patch.sequence <= lastSequence) return false;
  lastSequence = patch.sequence;
  pendingPatches.push(patch);
  scheduleDraw();
  return true;
}

/** 重连整幅重绘/新会话：清空本地绘制状态，等下一帧。 */
function reset() {
  pendingPatches = [];
  lastSequence = -1;
  desktopSize.value = null;
  fittedSize.value = null;
  const canvas = canvasRef.value;
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

defineExpose({ acceptFrame, reset });

// —— 指针事件 → vnc/input ——

function desktopPoint(event: MouseEvent): { x: number; y: number } | null {
  const canvas = canvasRef.value;
  const size = desktopSize.value;
  if (!canvas || !size || size.width === 0 || size.height === 0) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const x = Math.min(size.width - 1, Math.max(0, Math.floor(((event.clientX - rect.left) * size.width) / rect.width)));
  const y = Math.min(size.height - 1, Math.max(0, Math.floor(((event.clientY - rect.top) * size.height) / rect.height)));
  return { x, y };
}

function sendPointer(event: MouseEvent, extraMask = 0) {
  const point = desktopPoint(event);
  if (!point) return;
  emit("input", { kind: "pointer", x: point.x, y: point.y, buttonMask: pointerButtonMask(event.buttons) | extraMask });
}

function onMouseDown(event: MouseEvent) {
  event.preventDefault();
  canvasRef.value?.focus();
  sendPointer(event);
}

function onMouseMove(event: MouseEvent) {
  sendPointer(event);
}

function onMouseUp(event: MouseEvent) {
  sendPointer(event);
}

function onMouseLeave(event: MouseEvent) {
  // 拖拽选择移出画布时发送 release（掩码随 buttons 归零）。
  sendPointer(event);
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault();
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const wheelMask = event.deltaY < 0 ? 8 : event.deltaY > 0 ? 16 : 0;
  if (!wheelMask) return;
  const point = desktopPoint(event);
  if (!point) return;
  // 滚轮是瞬时脉冲：按下 + 释放两个指针事件。
  emit("input", { kind: "pointer", x: point.x, y: point.y, buttonMask: wheelMask });
  emit("input", { kind: "pointer", x: point.x, y: point.y, buttonMask: 0 });
}

// —— 键盘事件 → vnc/input ——

const pressedKeysyms = new Set<number>();

const KEY_CONTROL_LEFT = 0xffe3;
const KEY_LOWER_V = 0x76;

/** 把一次完整的 Ctrl+V 击键送给远端（RFB 不携带修饰键状态，只能显式按下/释放）。 */
function sendPasteKeystroke() {
  emit("input", { kind: "key", keysym: KEY_CONTROL_LEFT, pressed: true });
  emit("input", { kind: "key", keysym: KEY_LOWER_V, pressed: true });
  emit("input", { kind: "key", keysym: KEY_LOWER_V, pressed: false });
  emit("input", { kind: "key", keysym: KEY_CONTROL_LEFT, pressed: false });
}

function releaseAllKeys() {
  for (const keysym of pressedKeysyms) {
    emit("input", { kind: "key", keysym, pressed: false });
  }
  pressedKeysyms.clear();
}

/**
 * 本地剪贴板 → 远端的取文本通道。
 *
 * `navigator.clipboard.readText()` 在宿主 webview 里经常被权限拦掉（Promise
 * 直接拒绝，界面上什么也不提示），表现就是「Ctrl+V 没反应、右键粘贴也没
 * 内容」。这里改走浏览器原生粘贴路径：按 Ctrl+V 时把焦点挪到隐藏 textarea，
 * 让宿主自己把剪贴板内容写进去（用户手势触发，不需要读权限），再取文本；
 * 粘贴事件与输入事件都没来时，才退回 readText。
 */
const pasteSinkRef = ref<HTMLTextAreaElement | null>(null);
let pasteFallbackTimer: number | undefined;
let synthPasteTimer: number | undefined;
/** 合成粘贴期间屏蔽本地修饰键转发，避免与合成按键交错（会打出裸 v）。 */
let suppressModifierUntil = 0;

function isModifierKeysym(keysym: number): boolean {
  return keysym >= 0xffe1 && keysym <= 0xffee;
}

function deliverClipboardText(text: string) {
  if (pasteFallbackTimer !== undefined) {
    window.clearTimeout(pasteFallbackTimer);
    pasteFallbackTimer = undefined;
  }
  const sink = pasteSinkRef.value;
  if (sink) {
    sink.value = "";
    sink.blur();
  }
  canvasRef.value?.focus({ preventScroll: true });
  if (text) emit("clipboard-out", text);
  // 远端要先处理完 ClientCutText 再收到按键，粘贴才有内容可贴（首次按键
  // 只把剪贴板写过去、服务端还没应用时，紧接着的 Ctrl+V 会贴出旧内容或
  // 贴不出来，表现为「要按两次」），间隔按经验取 400ms。
  if (synthPasteTimer !== undefined) window.clearTimeout(synthPasteTimer);
  synthPasteTimer = window.setTimeout(() => {
    synthPasteTimer = undefined;
    // 合成期间用户还在按/放 Ctrl，若把物理 Ctrl 的按下/抬起也转发过去，
    // 会和合成序列交错，远端看到的是「Ctrl 抬起 + v」→ 打出一个字母 v。
    suppressModifierUntil = Date.now() + 600;
    sendPasteKeystroke();
  }, 400);
}

function readClipboardFallback() {
  pasteFallbackTimer = undefined;
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) {
    deliverClipboardText("");
    return;
  }
  void clipboard
    .readText()
    .then((text) => deliverClipboardText(text ?? ""))
    .catch(() => deliverClipboardText(""));
}

function requestClipboardPaste() {
  const sink = pasteSinkRef.value;
  if (!sink) {
    readClipboardFallback();
    return;
  }
  sink.value = "";
  sink.focus({ preventScroll: true });
  if (pasteFallbackTimer !== undefined) window.clearTimeout(pasteFallbackTimer);
  pasteFallbackTimer = window.setTimeout(readClipboardFallback, 220);
}

function onSinkPaste(event: ClipboardEvent) {
  event.preventDefault();
  deliverClipboardText(event.clipboardData?.getData("text") ?? "");
}

function onSinkInput() {
  const value = pasteSinkRef.value?.value ?? "";
  if (value) deliverClipboardText(value);
}

function isEditableElement(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return element.isContentEditable === true;
}

/**
 * 窗口级 Ctrl+V 接管：画布/隐藏输入框任何一方失焦时，画布上的 keydown 都
 * 收不到事件，用户就会觉得「第一次要按两下、之后干脆失效」。这里在捕获
 * 阶段统一拦截，只要 VNC 画面还在显示、事件也不来自别的输入框，就按粘贴
 * 处理；输入框（比如 SFTP 路径）里的 Ctrl+V 仍然走浏览器默认行为。
 */
function onWindowKeyDown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.code !== "KeyV") return;
  if (event.defaultPrevented) return;
  const holder = holderRef.value;
  if (!holder || holder.offsetParent === null) return;
  const target = event.target as HTMLElement | null;
  if (target && target !== pasteSinkRef.value && isEditableElement(target)) return;
  requestClipboardPaste();
}

function onKeyDown(event: KeyboardEvent) {
  // Ctrl/Cmd+V：把本地剪贴板发给远端（RFB 剪贴板同步），再把真正的
  // Ctrl+V 击键送给远端——只同步剪贴板而不转发按键的话，远端应用收不到
  // 粘贴动作，表现为「本地复制的内容贴不进远端」。
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyV") {
    // 不 preventDefault：需要宿主把内容按默认粘贴流程写进隐藏 textarea。
    requestClipboardPaste();
    return;
  }
  // 浏览器留用的组合（刷新/查找等）不转发，避免远端与本地双重响应。
  if (event.ctrlKey || event.metaKey) return;
  const keysym = mapKeyboardEventToVncKeysym(event);
  if (keysym === null) return;
  // 合成粘贴窗口内丢掉物理修饰键，避免和合成序列交错。
  if (isModifierKeysym(keysym) && Date.now() < suppressModifierUntil) return;
  event.preventDefault();
  pressedKeysyms.add(keysym);
  emit("input", { kind: "key", keysym, pressed: true });
}

function onKeyUp(event: KeyboardEvent) {
  const keysym = mapKeyboardEventToVncKeysym(event);
  if (keysym === null) return;
  if (isModifierKeysym(keysym) && Date.now() < suppressModifierUntil) {
    // 拦住物理 Ctrl 的抬起：合成序列自己会把 Ctrl 复位。
    pressedKeysyms.delete(keysym);
    return;
  }
  // 没发过按下的修饰键也不发抬起（按下时被组合键判断挡掉了），否则远端
  // 会在合成粘贴序列中间收到一个「Ctrl 抬起」，把 v 当成普通字符打出来。
  if (isModifierKeysym(keysym) && !pressedKeysyms.has(keysym)) return;
  event.preventDefault();
  pressedKeysyms.delete(keysym);
  emit("input", { kind: "key", keysym, pressed: false });
}

function onBlur() {
  focused.value = false;
  // 焦点丢失（切窗/切面板）释放全部按下的键，避免远端粘键。
  releaseAllKeys();
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text");
  if (text) {
    event.preventDefault();
    emit("clipboard-out", text);
  }
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeyDown, true);
  pendingPatches = [];
  resizeObserver?.disconnect();
  resizeObserver = undefined;
});
</script>

<template>
  <div ref="holderRef" class="vnc-surface-holder" :class="[scaleClass, { 'is-focused': focused }]">
    <!-- 隐藏粘贴接收器：Ctrl+V 时接住宿主写进来的剪贴板文本（免读权限）。 -->
    <textarea
      ref="pasteSinkRef"
      class="vnc-paste-sink"
      tabindex="-1"
      aria-hidden="true"
      autocomplete="off"
      spellcheck="false"
      @paste="onSinkPaste"
      @input="onSinkInput"
    ></textarea>
    <canvas
      ref="canvasRef"
      class="vnc-canvas"
      :style="canvasStyle"
      tabindex="0"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @contextmenu="onContextMenu"
      @wheel="onWheel"
      @keydown="onKeyDown"
      @keyup="onKeyUp"
      @focus="focused = true"
      @blur="onBlur"
      @paste="onPaste"
    ></canvas>
  </div>
</template>

<style scoped>
.vnc-surface-holder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--background);
  z-index: 2;
}
.vnc-canvas {
  image-rendering: auto;
  outline: none;
  cursor: default;
  display: block;
  /* 帧到来前 canvas 尺寸为 0，给画布一个可点击聚焦的最小区域。 */
  min-width: 320px;
  min-height: 200px;
}
/* 粘贴接收器：1px 且不可见，但必须保持可聚焦、可接收原生粘贴。 */
.vnc-paste-sink {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  resize: none;
  overflow: hidden;
  pointer-events: none;
}
.vnc-surface-holder.is-focused .vnc-canvas {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary, #2563eb) 35%, transparent);
}
/* fit：等比缩放到视图内（默认），尺寸由脚本按比例算出。 */
.vnc-scale-fit .vnc-canvas {
  max-width: 100%;
  max-height: 100%;
}
/* stretch：铺满视图（不保比例）。 */
.vnc-scale-stretch .vnc-canvas {
  width: 100%;
  height: 100%;
}
/* actual：1:1 原始像素，超出滚动。 */
.vnc-scale-actual {
  justify-content: flex-start;
  align-items: flex-start;
  overflow: auto;
}
.vnc-scale-actual .vnc-canvas {
  max-width: none;
  max-height: none;
}
</style>
