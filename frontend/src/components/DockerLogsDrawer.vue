<script setup lang="ts">
// Docker Logs 抽屉（B1 外抽，B3 增加实时跟随）：快照式 docker/logs 保留为
// 降级视图；抽屉打开时用只读 xterm 渲染 `docker/logs/stream/start` 的持续
// 输出（ANSI 颜色 / UTF-8 多字节 / \r 覆盖行都由 xterm 正确处理）。跟随
// 开关只控制是否自动滚到底部；tail 选择仍走父组件的快照刷新，并重启流。
import { Loader2, RefreshCw, X } from "@lucide/vue";
import { onBeforeUnmount, nextTick, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useDockerLogStream } from "../composables/useDockerLogStream";
import { createOutputGate, type OutputGate } from "../lib/terminalBackpressure";
import { createTerminalWriteThrottle, type TerminalWriteThrottle } from "../lib/terminalWriteThrottle";
import { loadTerminalAppearance, terminalOptionPatch } from "../lib/terminalAppearance";
import { loadTerminalFontOverride } from "../lib/terminalFont";
import { DBX_APPEARANCE_PALETTES, TERMINAL_ANSI } from "../lib/appearance";
import { pluginStore } from "../lib/pluginStore";

interface LogsTarget {
  id: string;
  name: string;
}

interface LogsMeta {
  image: string;
  status: string;
  health?: string | null;
}

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  open: boolean;
  target: LogsTarget | null;
  text: string;
  meta: LogsMeta | null;
  busy: boolean;
  error: string;
  tail: string;
  /** 通用参数（target/sessionId/cli/socket/host），由面板的 dockerParams 计算。 */
  streamBase?: Record<string, unknown>;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:tail": [value: string];
  refresh: [];
}>();

const TAIL_OPTIONS = ["100", "200", "500", "1000", "2000"] as const;

const terminalHost = ref<HTMLElement | null>(null);
const follow = ref(true);
const streamError = ref("");
const endedReason = ref("");
let terminal: Terminal | null = null;
let throttle: TerminalWriteThrottle | null = null;
let gate: OutputGate | null = null;

const { active, start, stop } = useDockerLogStream({
  onData(data) {
    if (!terminal || !throttle || !gate) return;
    gate.feed(throttle.pendingBytes);
    for (const part of gate.write(data)) throttle.write(part);
  },
  onEnd(reason) {
    endedReason.value = reason;
  },
  onError(message) {
    streamError.value = message;
  },
});

function ensureTerminal(): boolean {
  if (terminal) return true;
  const host = terminalHost.value;
  if (!host) return false;
  const settings = loadTerminalAppearance(pluginStore).settings;
  const patch = terminalOptionPatch(settings);
  const font = loadTerminalFontOverride(pluginStore);
  const scheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const palette = DBX_APPEARANCE_PALETTES[scheme];
  terminal = new Terminal({
    disableStdin: true,
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
  terminal.open(host);
  throttle = createTerminalWriteThrottle({
    sink(data) {
      terminal?.write(data);
      if (follow.value) terminal?.scrollToBottom();
    },
  });
  gate = createOutputGate();
  return true;
}

function disposeTerminal(): void {
  throttle?.dispose();
  throttle = null;
  gate = null;
  terminal?.dispose();
  terminal = null;
}

async function beginStream(): Promise<void> {
  const target = props.target;
  if (!target) return;
  streamError.value = "";
  endedReason.value = "";
  await nextTick();
  if (!ensureTerminal()) return;
  const started = await start({
    ...(props.streamBase ?? {}),
    containerId: target.id,
    tail: Number(props.tail) || 200,
    timestamps: false,
  });
  if (!started && !streamError.value) {
    streamError.value = props.t("docker.logsStreamUnavailable");
  }
}

async function endStream(): Promise<void> {
  await stop();
  disposeTerminal();
}

function toggleFollow(): void {
  follow.value = !follow.value;
  if (follow.value) terminal?.scrollToBottom();
}

watch(
  () => props.open,
  (open) => {
    if (open) void beginStream();
    else void endStream();
  },
  { flush: "post" },
);

watch(
  () => props.target?.id,
  () => {
    if (props.open) void beginStream();
  },
);

watch(
  () => props.tail,
  () => {
    if (props.open) void beginStream();
  },
);

onBeforeUnmount(() => {
  void stop({ notify: true });
  disposeTerminal();
});
</script>

<template>
  <!-- Logs 抽屉 -->
  <Dialog :open="props.open" @update:open="(open: boolean) => emit('update:open', open)">
    <DialogContent class="docker-dialog docker-logs-dialog" @escape-key-down.prevent>
      <div class="docker-dialog-header">
        <DialogTitle>
          {{ props.target ? props.t("docker.logsTitle", { name: props.target.name || props.target.id.slice(0, 12) }) : "" }}
        </DialogTitle>
        <button type="button" class="icon-button" :title="props.t('docker.close')" :aria-label="props.t('docker.close')" @click="emit('update:open', false)"><X /></button>
      </div>
      <div class="docker-logs-bar">
        <label class="docker-tail-label">
          <span>{{ props.t("docker.logsTail") }}</span>
          <Select
            :model-value="props.tail"
            @update:model-value="(value: unknown) => { emit('update:tail', String(value)); emit('refresh'); }"
          >
            <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in TAIL_OPTIONS" :key="option" :value="option">{{ option }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <button
          type="button"
          class="docker-follow-toggle"
          :class="{ 'is-on': follow }"
          :aria-pressed="follow"
          @click="toggleFollow"
        >
          {{ props.t("docker.logsFollow") }}
        </button>
        <button type="button" class="icon-button" :title="props.t('docker.logsRefresh')" :aria-label="props.t('docker.logsRefresh')" @click="emit('refresh')">
          <Loader2 v-if="props.busy" class="spinning" />
          <RefreshCw v-else />
        </button>
      </div>
      <p v-if="props.error" class="docker-hint docker-hint-error">{{ props.t("docker.logsLoadFailed", { error: props.error }) }}</p>
      <p v-if="streamError" class="docker-hint docker-hint-error">{{ props.t("docker.logsStreamError", { error: streamError }) }}</p>
      <p v-else-if="endedReason && !active" class="docker-hint">{{ props.t("docker.logsStreamEnded", { reason: endedReason }) }}</p>
      <div v-if="props.meta" class="docker-logs-meta mono">
        {{ props.meta.image }} · {{ props.meta.status }}<template v-if="props.meta.health"> · {{ props.meta.health }}</template>
      </div>
      <div ref="terminalHost" v-show="active" class="docker-logs-term"></div>
      <pre v-if="!active && props.text" class="docker-logs-pre mono">{{ props.text }}</pre>
      <p v-else-if="!active && !props.busy && !props.error" class="docker-empty">{{ props.t("docker.logsEmpty") }}</p>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.docker-dialog {
  max-width: 460px;
}

.docker-logs-dialog {
  max-width: 820px;
  width: min(820px, 90vw);
}

.docker-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.docker-empty {
  opacity: 0.65;
  font-size: 12px;
  padding: 8px 4px;
}

.docker-hint {
  font-size: 11px;
  opacity: 0.7;
}

.docker-hint-error {
  color: var(--danger, #d64545);
  opacity: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-logs-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.docker-follow-toggle {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border, #d4d4d8);
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}

.docker-follow-toggle.is-on {
  opacity: 1;
  border-color: var(--accent, #3b82f6);
  color: var(--accent, #3b82f6);
}

.docker-tail-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.docker-logs-meta {
  font-size: 11px;
  opacity: 0.65;
}

.docker-logs-term {
  height: min(50vh, 420px);
  padding: 6px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--terminal-bg, rgba(0, 0, 0, 0.4));
}

.docker-logs-pre {
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.1);
  max-height: 50vh;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}

.spinning {
  animation: docker-spin 1s linear infinite;
}

@keyframes docker-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
