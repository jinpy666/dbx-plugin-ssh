<script setup lang="ts">
// Docker 容器终端（B5）：工作台「终端」tab。xterm ↔ `docker/terminal/*`。
//
// 输出走二进制通道（已按帧序号解码/合流/背压），键入走
// `createTerminalInputQueue`（8 字节序号 + 串行发送，只发
// `docker/terminal/in/{id}`）。容器退出/关闭显示终态；错误就地展示。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Loader2, RotateCw } from "@lucide/vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useDockerTerminal } from "../composables/useDockerTerminal";
import { writeDockerTerminalFrames } from "../lib/dockerTerminalFrames";
import { createOutputGate, type OutputGate } from "../lib/terminalBackpressure";
import { createTerminalWriteThrottle, type TerminalWriteThrottle } from "../lib/terminalWriteThrottle";
import { loadTerminalAppearance, terminalOptionPatch } from "../lib/terminalAppearance";
import { loadTerminalFontOverride } from "../lib/terminalFont";
import { DBX_APPEARANCE_PALETTES, TERMINAL_ANSI } from "../lib/appearance";

interface TerminalTarget {
  id: string;
  name?: string;
}

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  target: TerminalTarget;
  /** 通用参数（target/sessionId/cli/socket/host/needsSudo）。 */
  params: () => Record<string, unknown>;
  active: boolean;
}>();

const host = ref<HTMLElement | null>(null);
const error = ref("");
const endedReason = ref("");
const exitCode = ref<number | null>(null);
const connecting = ref(false);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let throttle: TerminalWriteThrottle | null = null;
let gate: OutputGate | null = null;
let resizeObserver: ResizeObserver | null = null;

const handle = useDockerTerminal({
  onData(data) {
    if (!terminal || !gate || !throttle) return;
    writeDockerTerminalFrames(
      [{ stream: 0, sequence: 0, data }],
      gate,
      throttle,
    );
  },
  onEnd(reason, code) {
    endedReason.value = reason;
    exitCode.value = code;
  },
  onError(message) {
    error.value = message;
  },
});

const statusText = computed(() => {
  if (error.value) return error.value;
  if (endedReason.value === "closed") return props.t("docker.terminalClosed");
  if (endedReason.value === "exited") {
    const code = exitCode.value;
    return code === null
      ? props.t("docker.terminalExited")
      : props.t("docker.terminalExitedCode", { code });
  }
  if (endedReason.value === "error") return props.t("docker.terminalError");
  return "";
});

function ensureTerminal(): boolean {
  if (terminal) return true;
  if (!host.value) return false;
  const appearance = loadTerminalAppearance();
  const patch = terminalOptionPatch(appearance.settings);
  const font = loadTerminalFontOverride();
  const scheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const palette = DBX_APPEARANCE_PALETTES[scheme];
  terminal = new Terminal({
    convertEol: false,
    scrollback: 5000,
    fontFamily: font.fontFamily ?? undefined,
    fontSize: font.fontSize ?? 12,
    fontWeight: patch.fontWeight,
    lineHeight: patch.lineHeight,
    letterSpacing: patch.letterSpacing,
    theme: {
      background: palette.background,
      foreground: palette.foreground,
      cursor: palette.foreground,
      selectionBackground: palette.muted,
      ...TERMINAL_ANSI[scheme],
    },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host.value);
  terminal.onData((data) => {
    handle.sendInput(new TextEncoder().encode(data));
  });
  terminal.onResize(({ cols, rows }) => {
    void handle.resize(cols, rows);
  });
  throttle = createTerminalWriteThrottle({
    sink(data) {
      terminal?.write(data);
      terminal?.scrollToBottom();
    },
  });
  gate = createOutputGate();
  fitAddon.fit();
  return true;
}

function disposeTerminal(): void {
  throttle?.dispose();
  throttle = null;
  gate = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
}

async function begin(): Promise<void> {
  if (!props.active) return;
  error.value = "";
  endedReason.value = "";
  exitCode.value = null;
  await nextTick();
  if (!ensureTerminal()) return;
  fitAddon?.fit();
  const size = terminal;
  connecting.value = true;
  const started = await handle.open({
    ...props.params(),
    containerId: props.target.id,
    shell: "auto",
    cols: size?.cols ?? 80,
    rows: size?.rows ?? 24,
  });
  connecting.value = false;
  if (!started) {
    error.value = error.value || props.t("docker.terminalStartFailed");
  }
}

async function retry(): Promise<void> {
  await handle.close();
  await begin();
}

watch(
  () => props.active,
  (active) => {
    if (active) void begin();
    else void handle.close();
  },
  { immediate: true },
);

watch(
  () => props.target.id,
  () => {
    if (props.active) void retry();
  },
);

onMounted(() => {
  if (host.value && typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => {
      fitAddon?.fit();
      if (terminal) void handle.resize(terminal.cols, terminal.rows);
    });
    resizeObserver.observe(host.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  void handle.close();
  disposeTerminal();
});
</script>

<template>
  <div class="docker-terminal-pane">
    <div class="docker-terminal-host" ref="host" />
    <div v-if="connecting" class="docker-terminal-status">
      <Loader2 class="docker-terminal-spinner" />
      <span>{{ props.t("docker.terminalConnecting") }}</span>
    </div>
    <div v-else-if="statusText" class="docker-terminal-status" :title="statusText">
      <span class="docker-terminal-status-text">{{ statusText }}</span>
      <button type="button" class="docker-terminal-retry" :title="props.t('docker.terminalRetry')" :aria-label="props.t('docker.terminalRetry')" @click="retry">
        <RotateCw />
      </button>
    </div>
  </div>
</template>

<style scoped>
.docker-terminal-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  gap: 0.25rem;
}
.docker-terminal-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--terminal-background, #111);
  padding: 0.25rem;
}
.docker-terminal-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  color: var(--muted-foreground, #888);
  border-top: 1px solid var(--border, #333);
}
.docker-terminal-status-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.docker-terminal-spinner {
  width: 0.9rem;
  height: 0.9rem;
  animation: spin 1s linear infinite;
}
.docker-terminal-retry {
  display: inline-flex;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.docker-terminal-retry svg {
  width: 0.9rem;
  height: 0.9rem;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
