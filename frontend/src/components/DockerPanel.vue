<script setup lang="ts">
// Docker 管理面板（IMPL_PLAN v2 Task P2-4 前端半）：容器列表表 + 10s 轮询
// （3 连败自动停轮询）+ 生命周期动作（start/stop/restart 直发；kill/rm 强制
// 确认）+ Logs 抽屉（docker/logs，tail 可选）+ 「在终端打开」。
// 只读采集走 docker/list；动作走 docker/action（后端负责白名单、容器 id 门、
// 只读连接拒绝、执行前审计与 Quick Sudo 回落）。会话 id 由面板自行从
// ssh/sessions/list 解析（最近的存活会话）——SideNavPanel 容器不透传 session。
// 「在终端打开」（M3 遗留 6）：面板不直接写 PTY，改为 emit 语义的 window 自定义
// 事件（SideNavPanel 不透传事件且不在本次改动范围），由 App.vue 走「填入输入行
// 不回车」通道——命令落到 shell 输入行原地，用户确认后再回车执行。
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Check,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Terminal,
  Trash2,
  X,
} from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { normalizeBatchTargets } from "../lib/batchSend";
import {
  confirmDockerAction,
  requestDockerAction,
  type DockerActionDispatch,
  type DockerActionName,
  type DockerActionTarget,
} from "../lib/dockerActions";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
}

interface DockerInspectSummary {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  startedAt: string;
  health: string | null;
  restartPolicy: string;
}

// 动作动词 → 静态 i18n key（i18nKeyReferences.spec 只认字面量 key）。
const ACTION_LABEL_KEYS: Record<DockerActionName, string> = {
  start: "docker.actionStart",
  stop: "docker.actionStop",
  restart: "docker.actionRestart",
  kill: "docker.actionKill",
  rm: "docker.actionRemove",
};

const POLL_MS = 10_000;
const POLL_MAX_FAILURES = 3;
const LIST_TIMEOUT_MS = 20_000;
const LOGS_TIMEOUT_MS = 35_000;
const ACTION_TIMEOUT_MS = 70_000;
const TAIL_OPTIONS = ["100", "200", "500", "1000", "2000"] as const;

function dockerListPayload(raw: unknown): { available: boolean; needsSudo: boolean; containers: DockerContainer[] } {
  const record = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(record.containers) ? record.containers : [];
  const containers: DockerContainer[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id) continue;
    containers.push({
      id,
      name: typeof entry.name === "string" ? entry.name : "",
      image: typeof entry.image === "string" ? entry.image : "",
      state: typeof entry.state === "string" ? entry.state : "",
      status: typeof entry.status === "string" ? entry.status : "",
      ports: typeof entry.ports === "string" ? entry.ports : "",
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    });
  }
  return {
    available: record.available === true,
    needsSudo: record.needsSudo === true,
    containers,
  };
}

/** 「在终端打开」命令：容器内挑一个可用 shell（与 NyaTerm 约定一致）。 */
function dockerExecCommand(containerId: string): string {
  return `docker exec -it ${containerId} sh -lc 'bash || zsh || fish || ash || sh'`;
}

/** 状态徽标 class：已知状态着色，未知状态走中性灰。 */
function dockerStateClass(state: string): string {
  const known = ["running", "exited", "paused", "created", "restarting", "dead", "removing"];
  return known.includes(state) ? `docker-state-${state}` : "docker-state-unknown";
}

// —— 会话解析（SideNavPanel 不透传 session，面板自取最近存活会话）———————
const sessionId = ref("");
const sessionMissing = ref(false);

async function resolveSession(): Promise<boolean> {
  if (sessionId.value) return true;
  try {
    const response = await window.dbxPlugin.invoke<{ sessions: unknown }>("ssh/sessions/list");
    const targets = normalizeBatchTargets(response.sessions)
      .filter((target) => target.connected !== false)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (!targets.length) {
      sessionMissing.value = true;
      return false;
    }
    sessionId.value = targets[0].sessionId;
    sessionMissing.value = false;
    return true;
  } catch {
    sessionMissing.value = true;
    return false;
  }
}

// —— 列表 + 轮询（10s；3 连败停轮询，弱化空态）——————————————
const containers = ref<DockerContainer[]>([]);
const available = ref<boolean | null>(null);
const needsSudo = ref(false);
const loading = ref(false);
const listError = ref("");
const pollPaused = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;
let consecutiveFailures = 0;

async function refresh(): Promise<void> {
  if (loading.value) return;
  if (!(await resolveSession())) return;
  loading.value = true;
  try {
    const payload = dockerListPayload(
      await window.dbxPlugin.invoke<unknown>("docker/list", { sessionId: sessionId.value }, { timeoutMs: LIST_TIMEOUT_MS }),
    );
    containers.value = payload.containers;
    available.value = payload.available;
    needsSudo.value = payload.needsSudo;
    listError.value = "";
    consecutiveFailures = 0;
    pollPaused.value = false;
  } catch (cause) {
    consecutiveFailures += 1;
    listError.value = cause instanceof Error ? cause.message : String(cause);
    if (consecutiveFailures >= POLL_MAX_FAILURES) stopPolling();
  } finally {
    loading.value = false;
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => void refresh(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  if (consecutiveFailures >= POLL_MAX_FAILURES) pollPaused.value = true;
}

async function retryPolling(): Promise<void> {
  consecutiveFailures = 0;
  pollPaused.value = false;
  await refresh();
  if (pollPaused.value) return;
  startPolling();
}

onMounted(() => {
  void (async () => {
    await refresh();
    if (!pollPaused.value) startPolling();
  })();
});

onUnmounted(stopPolling);

// —— 生命周期动作（kill/rm 先确认）———————————————————————
const busyContainerId = ref("");
const actionError = ref("");

function rowBusy(container: DockerContainer): boolean {
  return busyContainerId.value === container.id;
}

const confirmTarget = ref<(DockerActionTarget & { action: DockerActionName }) | null>(null);
const confirmBusy = ref(false);

function requestAction(container: DockerContainer, action: DockerActionName): void {
  actionError.value = "";
  const transition = requestDockerAction({ id: container.id, name: container.name || container.id }, action);
  confirmTarget.value = transition.confirmation;
  if (transition.dispatch) void runAction(transition.dispatch);
}

async function runAction(dispatch: DockerActionDispatch): Promise<void> {
  if (!(await resolveSession())) return;
  busyContainerId.value = dispatch.id;
  try {
    await window.dbxPlugin.invoke<{ success: boolean; output: string }>(
      "docker/action",
      { sessionId: sessionId.value, containerId: dispatch.id, action: dispatch.action },
      { timeoutMs: ACTION_TIMEOUT_MS },
    );
    await refresh();
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busyContainerId.value = "";
  }
}

async function confirmAction(accepted: boolean): Promise<void> {
  const transition = confirmDockerAction(confirmTarget.value, accepted);
  confirmTarget.value = transition.confirmation;
  if (!transition.dispatch) return;
  confirmBusy.value = true;
  try {
    await runAction(transition.dispatch);
  } finally {
    confirmBusy.value = false;
  }
}

// —— Logs 抽屉 ———————————————————————————————————————
const logsOpen = ref(false);
const logsTarget = ref<DockerContainer | null>(null);
const logsText = ref("");
const logsMeta = ref<DockerInspectSummary | null>(null);
const logsBusy = ref(false);
const logsError = ref("");
const logsTail = ref<string>("200");

function openLogs(container: DockerContainer): void {
  logsTarget.value = container;
  logsText.value = "";
  logsMeta.value = null;
  logsError.value = "";
  logsOpen.value = true;
  void loadLogs();
}

async function loadLogs(): Promise<void> {
  const target = logsTarget.value;
  if (!target || !(await resolveSession())) return;
  logsBusy.value = true;
  logsError.value = "";
  try {
    const payload = await window.dbxPlugin.invoke<{ logs?: string; container?: DockerInspectSummary | null }>(
      "docker/logs",
      { sessionId: sessionId.value, containerId: target.id, tail: Number(logsTail.value) || 200 },
      { timeoutMs: LOGS_TIMEOUT_MS },
    );
    logsText.value = typeof payload.logs === "string" ? payload.logs : "";
    logsMeta.value = payload.container && typeof payload.container === "object" ? payload.container : null;
  } catch (cause) {
    logsError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    logsBusy.value = false;
  }
}

// —— 「在终端打开」（window 事件 → App.vue 填入输入行，不回车）——————————
// 事件名与 App.vue 的监听保持一致；detail 只带命令字符串。无终端会话时由
// App.vue 侧 toast 提示先连接（面板无法感知终端状态）。
const DOCKER_OPEN_IN_TERMINAL_EVENT = "dbx:docker-open-in-terminal";

const fillRequestedId = ref("");
let fillReset: ReturnType<typeof setTimeout> | undefined;

function openInTerminal(container: DockerContainer): void {
  window.dispatchEvent(
    new CustomEvent(DOCKER_OPEN_IN_TERMINAL_EVENT, { detail: { command: dockerExecCommand(container.id) } }),
  );
  fillRequestedId.value = container.id;
  if (fillReset) clearTimeout(fillReset);
  fillReset = setTimeout(() => {
    fillRequestedId.value = "";
  }, 2000);
}

const running = (container: DockerContainer): boolean => container.state === "running";
</script>

<template>
  <div class="docker-panel">
    <div class="docker-header">
      <strong>{{ props.t("docker.title") }}</strong>
      <span v-if="available && containers.length" class="docker-count">{{ containers.length }}</span>
      <span class="docker-header-spacer" />
      <button
        v-if="pollPaused"
        type="button"
        class="docker-link-button"
        :title="props.t('docker.pollStopped')"
        @click="retryPolling"
      >
        {{ props.t("docker.refresh") }}
      </button>
      <button v-else type="button" class="icon-button" :title="props.t('docker.refresh')" @click="refresh">
        <Loader2 v-if="loading" class="spinning" />
        <RefreshCw v-else />
      </button>
    </div>

    <p v-if="pollPaused" class="docker-hint docker-hint-warn">{{ props.t("docker.pollStopped") }}</p>
    <p v-if="listError && !pollPaused" class="docker-hint docker-hint-warn" :title="listError">
      {{ props.t("docker.listFailed") }}
    </p>
    <p v-if="actionError" class="docker-hint docker-hint-error" :title="actionError">
      {{ props.t("docker.actionFailed", { error: actionError }) }}
    </p>

    <!-- 会话缺失：无可操作对象 -->
    <p v-if="sessionMissing && !loading" class="docker-empty">{{ props.t("docker.sessionMissing") }}</p>

    <!-- 加载中 -->
    <p v-else-if="loading && available === null" class="docker-empty"><Loader2 class="spinning" />{{ props.t("docker.loading") }}</p>

    <!-- Docker 不可用：弱化空态，按探针结果解释原因 -->
    <div v-else-if="available === false" class="docker-empty">
      <p class="docker-empty-title">{{ props.t("docker.unavailableTitle") }}</p>
      <p class="docker-empty-hint">
        {{ needsSudo ? props.t("docker.unavailableSudo") : props.t("docker.unavailableMissing") }}
      </p>
    </div>

    <!-- 空列表 -->
    <p v-else-if="!containers.length" class="docker-empty">{{ props.t("docker.empty") }}</p>

    <!-- 容器表 -->
    <div v-else class="docker-table-wrap">
      <table class="docker-table">
        <thead>
          <tr>
            <th>{{ props.t("docker.colName") }}</th>
            <th>{{ props.t("docker.colImage") }}</th>
            <th>{{ props.t("docker.colState") }}</th>
            <th>{{ props.t("docker.colPorts") }}</th>
            <th class="docker-col-actions">{{ props.t("docker.colActions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="container in containers" :key="container.id">
            <td class="docker-cell-name" :title="container.id">
              <strong class="mono">{{ container.name || container.id.slice(0, 12) }}</strong>
            </td>
            <td class="docker-cell-image mono" :title="container.image">{{ container.image }}</td>
            <td class="docker-cell-state">
              <span class="docker-badge" :class="dockerStateClass(container.state)">{{ container.state }}</span>
              <small class="docker-status" :title="container.status">{{ container.status }}</small>
            </td>
            <td class="docker-cell-ports mono" :title="container.ports">{{ container.ports || "–" }}</td>
            <td class="docker-col-actions">
              <button
                type="button"
                class="icon-button"
                :disabled="running(container) || rowBusy(container)"
                :title="props.t('docker.actionStart')"
                @click="requestAction(container, 'start')"
              >
                <Play />
              </button>
              <button
                type="button"
                class="icon-button"
                :disabled="!running(container) || rowBusy(container)"
                :title="props.t('docker.actionStop')"
                @click="requestAction(container, 'stop')"
              >
                <Square />
              </button>
              <button
                type="button"
                class="icon-button"
                :disabled="!running(container) || rowBusy(container)"
                :title="props.t('docker.actionRestart')"
                @click="requestAction(container, 'restart')"
              >
                <RotateCw />
              </button>
              <button
                type="button"
                class="icon-button"
                :disabled="rowBusy(container)"
                :title="props.t('docker.actionKill')"
                @click="requestAction(container, 'kill')"
              >
                <X />
              </button>
              <button
                type="button"
                class="icon-button"
                :disabled="rowBusy(container)"
                :title="props.t('docker.actionRemove')"
                @click="requestAction(container, 'rm')"
              >
                <Trash2 />
              </button>
              <button
                type="button"
                class="icon-button"
                :title="props.t('docker.logsTitle', { name: container.name || container.id.slice(0, 12) })"
                @click="openLogs(container)"
              >
                <ScrollText />
              </button>
              <button
                type="button"
                class="icon-button"
                :class="{ 'is-copied': fillRequestedId === container.id }"
                :title="props.t('docker.terminalOpenTip')"
                @click="openInTerminal(container)"
              >
                <Check v-if="fillRequestedId === container.id" />
                <Terminal v-else />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="docker-hint">{{ props.t("docker.terminalHint") }}</p>
    </div>

    <!-- kill/rm 强制确认 -->
      <Dialog :open="!!confirmTarget" @update:open="(open: boolean) => { if (!open) void confirmAction(false); }">

      <DialogContent class="docker-dialog" @escape-key-down.prevent>
        <div class="docker-dialog-header">
          <DialogTitle>
            {{ confirmTarget ? props.t("docker.confirmTitle", { action: props.t(ACTION_LABEL_KEYS[confirmTarget.action]) }) : "" }}
          </DialogTitle>
          <button type="button" class="icon-button" :title="props.t('docker.cancel')" @click="confirmAction(false)"><X /></button>
        </div>
        <p class="docker-confirm-body mono">
          {{ confirmTarget ? props.t("docker.confirmBody", { action: confirmTarget.action, name: confirmTarget.name }) : "" }}
        </p>
        <div class="docker-dialog-actions">
          <button type="button" class="docker-secondary-button" :disabled="confirmBusy" @click="confirmAction(false)">
            {{ props.t("docker.cancel") }}
          </button>
          <button type="button" class="docker-danger-button" :disabled="confirmBusy" @click="confirmAction(true)">
            {{ confirmBusy ? props.t("docker.actionBusy") : props.t("docker.confirmOk") }}
          </button>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Logs 抽屉 -->
    <Dialog :open="logsOpen" @update:open="(open: boolean) => { logsOpen = open; }">
      <DialogContent class="docker-dialog docker-logs-dialog" @escape-key-down.prevent>
        <div class="docker-dialog-header">
          <DialogTitle>
            {{ logsTarget ? props.t("docker.logsTitle", { name: logsTarget.name || logsTarget.id.slice(0, 12) }) : "" }}
          </DialogTitle>
          <button type="button" class="icon-button" :title="props.t('docker.close')" @click="logsOpen = false"><X /></button>
        </div>
        <div class="docker-logs-bar">
          <label class="docker-tail-label">
            <span>{{ props.t("docker.logsTail") }}</span>
            <Select
              :model-value="logsTail"
              @update:model-value="(value: unknown) => { logsTail = String(value); void loadLogs(); }"
            >
              <SelectTrigger size="xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in TAIL_OPTIONS" :key="option" :value="option">{{ option }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <button type="button" class="icon-button" :title="props.t('docker.logsRefresh')" @click="loadLogs">
            <Loader2 v-if="logsBusy" class="spinning" />
            <RefreshCw v-else />
          </button>
        </div>
        <p v-if="logsError" class="docker-hint docker-hint-error">{{ props.t("docker.logsLoadFailed", { error: logsError }) }}</p>
        <div v-if="logsMeta" class="docker-logs-meta mono">
          {{ logsMeta.image }} · {{ logsMeta.status }}<template v-if="logsMeta.health"> · {{ logsMeta.health }}</template>
        </div>
        <pre v-if="logsText" class="docker-logs-pre mono">{{ logsText }}</pre>
        <p v-else-if="!logsBusy && !logsError" class="docker-empty">{{ props.t("docker.logsEmpty") }}</p>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.docker-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  padding: 4px 2px;
}

.docker-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.docker-header-spacer {
  flex: 1;
}

.docker-count {
  font-size: 11px;
  opacity: 0.65;
}

.docker-table-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.docker-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.docker-table th {
  text-align: left;
  font-weight: 600;
  opacity: 0.6;
  padding: 2px 6px 4px;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  white-space: nowrap;
}

.docker-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.15));
  vertical-align: top;
}

.docker-cell-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-cell-image {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.docker-cell-state {
  white-space: nowrap;
}

.docker-status {
  display: block;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.6;
}

.docker-cell-ports {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-col-actions {
  white-space: nowrap;
  text-align: right;
}

.docker-col-actions .icon-button {
  display: inline-flex;
  margin-left: 2px;
}

.docker-badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  background: rgba(128, 128, 128, 0.18);
}

.docker-state-running {
  background: rgba(34, 160, 94, 0.22);
}

.docker-state-exited,
.docker-state-created,
.docker-state-removing,
.docker-state-unknown {
  background: rgba(128, 128, 128, 0.18);
}

.docker-state-paused,
.docker-state-restarting {
  background: rgba(217, 154, 35, 0.25);
}

.docker-state-dead {
  background: rgba(214, 69, 69, 0.25);
}

.docker-empty {
  opacity: 0.65;
  font-size: 12px;
  padding: 8px 4px;
}

.docker-empty-title {
  font-weight: 600;
  opacity: 0.85;
}

.docker-empty-hint {
  margin-top: 2px;
}

.docker-hint {
  font-size: 11px;
  opacity: 0.7;
}

.docker-hint-warn {
  opacity: 0.85;
}

.docker-hint-error {
  color: var(--danger, #d64545);
  opacity: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-link-button {
  background: none;
  border: none;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  padding: 2px;
}

.icon-button.is-copied {
  color: var(--success, #22a05e);
}

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

.docker-confirm-body {
  margin: 10px 0;
  word-break: break-all;
}

.docker-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.docker-secondary-button,
.docker-danger-button {
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
}

.docker-danger-button {
  background: var(--danger, #d64545);
  border-color: var(--danger, #d64545);
  color: #fff;
}

.docker-danger-button:disabled,
.docker-secondary-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.docker-logs-bar {
  display: flex;
  align-items: center;
  gap: 8px;
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
