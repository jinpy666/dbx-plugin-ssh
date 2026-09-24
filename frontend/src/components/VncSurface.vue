<script setup lang="ts">
// VNC 画布表面（nyaterm-parity P2 2d）：接收 App.vue 解码好的帧补丁做
// putImageData 增量绘制（rAF 合帧），fit/stretch/actual 三种前端缩放，
// 键鼠事件经 keysym 映射后交给父组件发送（vnc/input）。状态覆盖层
// （connecting/closed）由 App.vue 的 terminal-overlay 分支承担，本组件
// 只负责活的桌面画面与输入采集。
import { computed, onBeforeUnmount, ref } from "vue";
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

function drawPatch(patch: VncFramePatch) {
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

function releaseAllKeys() {
  for (const keysym of pressedKeysyms) {
    emit("input", { kind: "key", keysym, pressed: false });
  }
  pressedKeysyms.clear();
}

function onKeyDown(event: KeyboardEvent) {
  // Ctrl/Cmd+V：把本地剪贴板发给远端（RFB 剪贴板同步）。
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
  const keysym = mapKeyboardEventToVncKeysym(event);
  if (keysym === null) return;
  event.preventDefault();
  pressedKeysyms.add(keysym);
  emit("input", { kind: "key", keysym, pressed: true });
}

function onKeyUp(event: KeyboardEvent) {
  const keysym = mapKeyboardEventToVncKeysym(event);
  if (keysym === null) return;
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
  pendingPatches = [];
});
</script>

<template>
  <div ref="holderRef" class="vnc-surface-holder" :class="[scaleClass, { 'is-focused': focused }]">
    <canvas
      ref="canvasRef"
      class="vnc-canvas"
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
