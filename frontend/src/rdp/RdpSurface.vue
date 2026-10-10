<script setup lang="ts">
// RDP 画布表面（nyaterm-parity P3-4）：接收 App.vue 解码好的帧补丁做
// putImageData 增量绘制（rAF 合帧），fit/stretch/actual 三种前端缩放，
// 键鼠事件经扫描码映射后交给父组件发送（rdp/input），服务端光标形状
// （rdp/pointer）落到画布 CSS cursor。与 VncSurface 同构：同一 44 字节
// patch 头解码复用 vncFrame，状态覆盖层（connecting/reconnecting/closed）
// 由 App.vue 的 terminal-overlay 分支承担，本组件只负责活的桌面画面与
// 输入采集。
import { computed, onBeforeUnmount, ref } from "vue";
import {
  buildRdpKeyDownEvent,
  buildRdpKeyUpEvent,
  decodeRdpFramePatch,
  mapDomButtonToRdpButton,
  type RdpFramePatch,
  type RdpInputEvent,
  type RdpPointerEvent,
} from "../lib/rdpFrame";

interface Props {
  scaleMode: "fit" | "stretch" | "actual";
}
const props = defineProps<Props>();
const emit = defineEmits<{ input: [RdpInputEvent]; "clipboard-out": [string] }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const holderRef = ref<HTMLDivElement | null>(null);
const desktopSize = ref<{ width: number; height: number } | null>(null);
const focused = ref(false);
const cursorStyle = ref("");

// rAF 合帧队列：同一帧内的多个补丁一次绘制，避免高频 update 撕裂。
let pendingPatches: RdpFramePatch[] = [];
let drawScheduled = false;
let lastSequence = -1;

const scaleClass = computed(() => `vnc-scale-${props.scaleMode}`);

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

function drawPatch(patch: RdpFramePatch) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  if (canvas.width !== patch.desktopWidth || canvas.height !== patch.desktopHeight) {
    canvas.width = patch.desktopWidth;
    canvas.height = patch.desktopHeight;
    desktopSize.value = { width: patch.desktopWidth, height: patch.desktopHeight };
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
  let patch: RdpFramePatch;
  try {
    patch = decodeRdpFramePatch(frame);
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
  cursorStyle.value = "";
  const canvas = canvasRef.value;
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

// —— rdp/pointer：服务端光标形状 → CSS cursor ————————————————

/** bitmap 光标：原始 RGBA → canvas → PNG data URL（CSS cursor 只吃图片 URL）。 */
function bitmapCursorUrl(pointer: Extract<RdpPointerEvent, { type: "bitmap" }>): string | null {
  if (pointer.width <= 0 || pointer.height <= 0 || pointer.width > 256 || pointer.height > 256) return null;
  let bytes: Uint8Array;
  try {
    bytes = window.dbxPlugin.decodeBase64(pointer.rgbaBase64);
  } catch {
    return null;
  }
  const expected = pointer.width * pointer.height * 4;
  if (bytes.byteLength < expected) return null;
  const canvas = document.createElement("canvas");
  canvas.width = pointer.width;
  canvas.height = pointer.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(bytes.subarray(0, expected)), pointer.width, pointer.height), 0, 0);
  return canvas.toDataURL("image/png");
}

function applyPointer(pointer: RdpPointerEvent) {
  if (pointer.type === "default") {
    cursorStyle.value = "";
    return;
  }
  if (pointer.type === "hidden") {
    cursorStyle.value = "none";
    return;
  }
  // position 只回报服务端坐标，不改变本地光标形状（NyaTerm 同语义）。
  if (pointer.type === "position") return;
  const url = bitmapCursorUrl(pointer);
  cursorStyle.value = url
    ? `url(${url}) ${Math.max(0, pointer.hotspotX)} ${Math.max(0, pointer.hotspotY)}, default`
    : "";
}

defineExpose({ acceptFrame, reset, applyPointer });

// —— 指针事件 → rdp/input ——

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

function onMouseMove(event: MouseEvent) {
  const point = desktopPoint(event);
  if (!point) return;
  emit("input", { kind: "mouse-move", x: point.x, y: point.y });
}

function onMouseDown(event: MouseEvent) {
  event.preventDefault();
  canvasRef.value?.focus();
  const point = desktopPoint(event);
  const button = mapDomButtonToRdpButton(event.button);
  if (!point || !button) return;
  emit("input", { kind: "mouse-button", button, pressed: true, x: point.x, y: point.y });
}

function onMouseUp(event: MouseEvent) {
  const point = desktopPoint(event);
  const button = mapDomButtonToRdpButton(event.button);
  if (!point || !button) return;
  emit("input", { kind: "mouse-button", button, pressed: false, x: point.x, y: point.y });
}

function onMouseLeave(event: MouseEvent) {
  // 拖拽移出画布时补发 release，避免远端粘键。
  const point = desktopPoint(event);
  const button = mapDomButtonToRdpButton(event.button);
  if (!point || !button) return;
  emit("input", { kind: "mouse-button", button, pressed: false, x: point.x, y: point.y });
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault();
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const point = desktopPoint(event);
  if (!point) return;
  // 浏览器增量原样下发（deltaX/deltaY），取反映射为 RDP 旋转单位由 sidecar 负责。
  if (!event.deltaX && !event.deltaY) return;
  emit("input", { kind: "mouse-wheel", deltaX: event.deltaX, deltaY: event.deltaY, x: point.x, y: point.y });
}

// —— 键盘事件 → rdp/input ——

function onKeyDown(event: KeyboardEvent) {
  // Ctrl/Cmd+V：把本地剪贴板发给远端（rdp/set-clipboard 同步）。
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyV") {
    event.preventDefault();
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (text) emit("clipboard-out", text);
      })
      .catch(() => undefined);
    return;
  }
  // 浏览器留用的组合（刷新/查找等）不转发，避免远端与本地双重响应。
  if (event.ctrlKey || event.metaKey) return;
  const input = buildRdpKeyDownEvent(event);
  if (input === null) return;
  event.preventDefault();
  emit("input", input);
}

function onKeyUp(event: KeyboardEvent) {
  const input = buildRdpKeyUpEvent(event);
  if (input === null) return;
  event.preventDefault();
  emit("input", input);
}

function onBlur() {
  focused.value = false;
  // 焦点丢失（切窗/切面板）发 release-all，避免远端粘键。
  emit("input", { kind: "release-all" });
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text");
  if (text) {
    event.preventDefault();
    emit("clipboard-out", text);
  }
}

onBeforeUnmount(() => {
  pendingPatches = [];
});
</script>

<template>
  <div ref="holderRef" class="vnc-surface-holder" :class="[scaleClass, { 'is-focused': focused }]">
    <canvas
      ref="canvasRef"
      class="vnc-canvas"
      tabindex="0"
      :style="cursorStyle ? { cursor: cursorStyle } : undefined"
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
/* 与 VncSurface 同构的画布几何/缩放样式（scoped 各自持有，类名复用同一套
   语义：fit 等比、stretch 铺满、actual 1:1 滚动）。 */
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
  /* 帧到来前 canvas 尺寸为 0，给画布一个可点击聚焦的最小区域。 */
  min-width: 320px;
  min-height: 200px;
}
.vnc-surface-holder.is-focused .vnc-canvas {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary, #2563eb) 35%, transparent);
}
/* fit：等比缩放到视图内（默认）。 */
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
