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
import { computed, onMounted, onScopeDispose, onUnmounted, ref, watch } from "vue";
import {
  Check,
  ChevronDown,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Settings,
  Square,
  Terminal,
  Trash2,
  X,
} from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { normalizeBatchTargets } from "../lib/batchSend";
import {
  dockerEngineParams,
  loadDockerEngineSettings,
  saveDockerEngineSettings,
  validateDockerEngineSettings,
  type DockerEngineSettings,
} from "../lib/dockerEngine";
import {
  confirmDockerAction,
  requestDockerAction,
  type DockerActionDispatch,
  type DockerActionName,
  type DockerActionTarget,
} from "../lib/dockerActions";
import { createRowMenuController } from "../lib/dockerRowMenu";

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

/** 「在终端打开」命令：容器内挑一个可用 shell（与 NyaTerm 约定一致）。
 *  CLI 跟随引擎设置（podman 等自定义命令同样可进终端 exec）。 */
function dockerExecCommand(containerId: string): string {
  const cli = engineSettings.value.cli || "docker";
  return `${cli} exec -it ${containerId} sh -lc 'bash || zsh || fish || ash || sh'`;
}

/** 状态徽标 class：已知状态着色，未知状态走中性灰。 */
function dockerStateClass(state: string): string {
  const known = ["running", "exited", "paused", "created", "restarting", "dead", "removing"];
  return known.includes(state) ? `docker-state-${state}` : "docker-state-unknown";
}

// —— 会话解析（SideNavPanel 不透传 session，面板自取最近存活会话）———————
// 无存活 SSH 会话时回落 target:"local"——查询 sidecar 所在机器的 docker
// daemon（Docker Desktop/OrbStack），面板不再是「没连服务器就空转」。
type PanelMode = "ssh" | "local";
const sessionId = ref("");
const mode = ref<PanelMode>("ssh");

// —— 引擎连接设置（Podman / 自定义 socket / tcp host）———————————————————
// 按连接持久化（connectionId 为键，local 模式 "local"）；随每次 docker 家族
// invoke 以 cli/socket/host 附加参数下发，sidecar 负责归一与最终校验。
const connectionKey = ref("");
const engineSettings = ref<DockerEngineSettings>({ ...loadDockerEngineSettings("") });
const engineOpen = ref(false);
const engineDraft = ref<DockerEngineSettings>({ cli: "", socket: "", host: "" });
const engineErrors = computed(() => validateDockerEngineSettings(engineDraft.value).errors);

function toggleEngineSettings(): void {
  engineOpen.value = !engineOpen.value;
  if (engineOpen.value) engineDraft.value = { ...engineSettings.value };
}

/** 保存即生效并重采列表；非法草稿（红线不满足）不落盘。 */
function applyEngineSettings(): void {
  const { settings, errors } = validateDockerEngineSettings(engineDraft.value);
  if (errors.cli || errors.endpoints) return;
  engineSettings.value = settings;
  saveDockerEngineSettings(connectionKey.value, settings);
  void refresh();
}

async function resolveMode(): Promise<PanelMode> {
  if (mode.value === "ssh" && sessionId.value) return "ssh";
  try {
    const response = await window.dbxPlugin.invoke<{ sessions: unknown }>("ssh/sessions/list");
    const targets = normalizeBatchTargets(response.sessions)
      .filter((target) => target.connected !== false)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (targets.length) {
      sessionId.value = targets[0].sessionId;
      mode.value = "ssh";
      adoptConnection(targets[0].connectionId);
      return "ssh";
    }
  } catch {
    // 会话枚举失败（旧 sidecar 等）同样回落本机探测。
  }
  mode.value = "local";
  adoptConnection("");
  return "local";
}

/** 切换持久化键并装载该连接的引擎设置（新连接不继承上一台主机配置）。 */
function adoptConnection(connectionId: string): void {
  const nextKey = connectionId || "local";
  if (nextKey === connectionKey.value) return;
  connectionKey.value = nextKey;
  engineSettings.value = loadDockerEngineSettings(nextKey);
  if (engineOpen.value) engineDraft.value = { ...engineSettings.value };
}

/** 按当前模式组装 docker 家族参数：local 不需要 sessionId；引擎设置随行。 */
function dockerParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base =
    mode.value === "local"
      ? { target: "local" as const, ...extra }
      : { sessionId: sessionId.value, ...extra };
  return { ...base, ...dockerEngineParams(engineSettings.value) };
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
  await resolveMode();
  loading.value = true;
  try {
    const payload = dockerListPayload(
      await window.dbxPlugin.invoke<unknown>(
        "docker/list",
        dockerParams(),
        { timeoutMs: LIST_TIMEOUT_MS },
      ),
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
  await resolveMode();
  busyContainerId.value = dispatch.id;
  try {
    await window.dbxPlugin.invoke<{ success: boolean; output: string }>(
      "docker/action",
      dockerParams({ containerId: dispatch.id, action: dispatch.action }),
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

// kill/rm 确认弹窗的 Esc 取消：面板内状态不在 App 的分层 Esc 链里，而
// DialogContent 的 @escape-key-down.prevent 又挡掉了 reka 自带关闭（Esc 此前
// 完全失效）。document 捕获阶段监听先于 App 冒泡链与 reka 触发，打开时挂、
// 关闭即卸；stopPropagation 防止同一次 Esc 再关掉底层弹层。
function onConfirmEsc(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  void confirmAction(false);
}
watch(confirmTarget, (target) => {
  if (target) document.addEventListener("keydown", onConfirmEsc, true);
  else document.removeEventListener("keydown", onConfirmEsc, true);
});
onScopeDispose(() => document.removeEventListener("keydown", onConfirmEsc, true));

// —— 行操作悬浮下拉（hover 开合，状态机在 lib/dockerRowMenu）—————————————
// 触发器 hover 延迟开、移出延迟关（跨 side-offset 间隙不闪断）、click 兜底
// 切换；7 个内联按钮收纳为单项下拉，操作列不再挤占容器表宽度。
const rowMenu = createRowMenuController();
onScopeDispose(() => rowMenu.close());

/** reka 打开弹层默认把焦点迁入首控件；hover 开启的菜单不迁移——用户可能正在
 *  终端输入，焦点被抢走后按键（Space/Enter）会落到菜单项上误触容器操作。
 *  click/键盘/触屏开启的菜单保留默认迁移，方向键与 Esc 才能在菜单内工作。 */
function onRowMenuOpenAutoFocus(event: Event): void {
  if (rowMenu.openedByHover()) event.preventDefault();
}

/** 菜单选项统一入口：先收菜单再派发（kill/rm 仍走确认弹层）。 */
function runMenuAction(container: DockerContainer, action: DockerActionName): void {
  rowMenu.close();
  requestAction(container, action);
}

function menuOpenLogs(container: DockerContainer): void {
  rowMenu.close();
  openLogs(container);
}

function menuOpenInTerminal(container: DockerContainer): void {
  rowMenu.close();
  openInTerminal(container);
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
  if (!target) return;
  await resolveMode();
  logsBusy.value = true;
  logsError.value = "";
  try {
    const payload = await window.dbxPlugin.invoke<{ logs?: string; container?: DockerInspectSummary | null }>(
      "docker/logs",
      dockerParams({ containerId: target.id, tail: Number(logsTail.value) || 200 }),
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

onUnmounted(() => {
  if (fillReset) clearTimeout(fillReset);
});

const running = (container: DockerContainer): boolean => container.state === "running";
</script>

<template>
  <div class="docker-panel">
    <div class="docker-header">
      <strong>{{ props.t("docker.title") }}</strong>
      <span v-if="mode === 'local'" class="docker-source-badge">{{ props.t("docker.localSource") }}</span>
      <span v-if="available && containers.length" class="docker-count">{{ containers.length }}</span>
      <span class="docker-header-spacer" />
      <button v-if="engineSettings.cli" type="button" class="docker-engine-badge" :title="props.t('docker.engineBadge', { cli: engineSettings.cli })" @click="toggleEngineSettings">
        {{ engineSettings.cli }}
      </button>
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
      <Popover :open="engineOpen" @update:open="(open: boolean) => { if (!open) engineOpen = false; }">
        <PopoverAnchor as-child>
          <button type="button" class="icon-button" :class="{ 'is-active': engineOpen }" :title="props.t('docker.engineSettings')" @click="toggleEngineSettings">
            <Settings />
          </button>
        </PopoverAnchor>
        <PopoverContent class="popover docker-engine-popover" align="end" :side-offset="5">
          <h3>{{ props.t("docker.engineSettings") }}</h3>
          <label class="docker-engine-field">
            <span>{{ props.t("docker.engineCli") }}</span>
            <input
              v-model="engineDraft.cli"
              class="mono"
              :placeholder="props.t('docker.engineCliPlaceholder')"
              spellcheck="false"
              @change="applyEngineSettings"
            />
          </label>
          <label class="docker-engine-field">
            <span>{{ props.t("docker.engineSocket") }}</span>
            <input
              v-model="engineDraft.socket"
              class="mono"
              :placeholder="props.t('docker.engineSocketPlaceholder')"
              spellcheck="false"
              @change="applyEngineSettings"
            />
          </label>
          <label class="docker-engine-field">
            <span>{{ props.t("docker.engineHost") }}</span>
            <input
              v-model="engineDraft.host"
              class="mono"
              :placeholder="props.t('docker.engineHostPlaceholder')"
              spellcheck="false"
              @change="applyEngineSettings"
            />
          </label>
          <p v-if="engineErrors.cli" class="docker-hint docker-hint-error">{{ props.t("docker.engineInvalidCli") }}</p>
          <p v-else-if="engineErrors.endpoints === 'conflict'" class="docker-hint docker-hint-error">{{ props.t("docker.engineConflict") }}</p>
          <p v-else-if="engineErrors.endpoints" class="docker-hint docker-hint-error">{{ props.t("docker.engineInvalidEndpoint") }}</p>
          <p class="docker-hint">{{ props.t("docker.engineHint") }}</p>
        </PopoverContent>
      </Popover>
    </div>

    <p v-if="pollPaused" class="docker-hint docker-hint-warn">{{ props.t("docker.pollStopped") }}</p>
    <p v-if="listError && !pollPaused" class="docker-hint docker-hint-warn" :title="listError">
      {{ props.t("docker.listFailed") }}
    </p>
    <p v-if="actionError" class="docker-hint docker-hint-error" :title="actionError">
      {{ props.t("docker.actionFailed", { error: actionError }) }}
    </p>

    <!-- 加载中 -->
    <p v-if="loading && available === null" class="docker-empty"><Loader2 class="spinning" />{{ props.t("docker.loading") }}</p>

    <!-- Docker 不可用：弱化空态，按探针结果解释原因（本机 daemon 拒绝走本地文案） -->
    <div v-else-if="available === false" class="docker-empty">
      <p class="docker-empty-title">{{ props.t("docker.unavailableTitle") }}</p>
      <p class="docker-empty-hint">
        <template v-if="!needsSudo">{{ props.t("docker.unavailableMissing") }}</template>
        <template v-else-if="mode === 'local'">{{ props.t("docker.unavailableSudoLocal") }}</template>
        <template v-else>{{ props.t("docker.unavailableSudo") }}</template>
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
              <Popover :open="rowMenu.isOpen(container.id)" @update:open="(open: boolean) => { if (!open) rowMenu.close(); }">
                <PopoverAnchor as-child>
                  <button
                    type="button"
                    class="icon-button docker-row-trigger"
                    :class="{ 'is-active': rowMenu.isOpen(container.id) }"
                    :title="props.t('docker.colActions')"
                    :aria-label="props.t('docker.colActions')"
                    aria-haspopup="menu"
                    :aria-expanded="rowMenu.isOpen(container.id)"
                    @pointerenter="rowMenu.hoverTrigger(container.id)"
                    @pointerleave="rowMenu.leaveToClose()"
                    @click="rowMenu.toggle(container.id)"
                  >
                    <Check v-if="fillRequestedId === container.id" />
                    <ChevronDown v-else />
                  </button>
                </PopoverAnchor>
                <PopoverContent
                  class="docker-row-menu w-auto gap-1 p-1"
                  align="end"
                  :side-offset="4"
                  @open-auto-focus="onRowMenuOpenAutoFocus"
                  @pointerenter="rowMenu.hoverContent()"
                  @pointerleave="rowMenu.leaveToClose()"
                >
                  <button type="button" class="docker-row-menu-item" :disabled="running(container) || rowBusy(container)" @click="runMenuAction(container, 'start')">
                    <Play />{{ props.t("docker.actionStart") }}
                  </button>
                  <button type="button" class="docker-row-menu-item" :disabled="!running(container) || rowBusy(container)" @click="runMenuAction(container, 'stop')">
                    <Square />{{ props.t("docker.actionStop") }}
                  </button>
                  <button type="button" class="docker-row-menu-item" :disabled="!running(container) || rowBusy(container)" @click="runMenuAction(container, 'restart')">
                    <RotateCw />{{ props.t("docker.actionRestart") }}
                  </button>
                  <button type="button" class="docker-row-menu-item docker-row-menu-item--danger" :disabled="rowBusy(container)" @click="runMenuAction(container, 'kill')">
                    <X />{{ props.t("docker.actionKill") }}
                  </button>
                  <button type="button" class="docker-row-menu-item docker-row-menu-item--danger" :disabled="rowBusy(container)" @click="runMenuAction(container, 'rm')">
                    <Trash2 />{{ props.t("docker.actionRemove") }}
                  </button>
                  <div class="docker-row-menu-sep" role="separator" />
                  <button type="button" class="docker-row-menu-item" @click="menuOpenLogs(container)">
                    <ScrollText />{{ props.t("docker.actionLogs") }}
                  </button>
                  <button v-if="mode === 'ssh'" type="button" class="docker-row-menu-item" @click="menuOpenInTerminal(container)">
                    <Terminal />{{ props.t("docker.actionTerminal") }}
                  </button>
                </PopoverContent>
              </Popover>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="mode === 'ssh'" class="docker-hint">{{ props.t("docker.terminalHint") }}</p>
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
          {{ confirmTarget ? props.t("docker.confirmBody", { cli: engineSettings.cli || "docker", action: confirmTarget.action, name: confirmTarget.name }) : "" }}
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

.docker-source-badge {
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  background: rgba(90, 140, 220, 0.22);
  white-space: nowrap;
}

/* 引擎设置（齿轮弹层）：紧凑表单，保存即生效。 */
.docker-engine-badge {
  border: none;
  background: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
  background: rgba(90, 140, 220, 0.22);
  white-space: nowrap;
}

.docker-engine-popover {
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.docker-engine-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
}

.docker-engine-field input {
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--background, transparent);
  color: inherit;
}

.docker-engine-field input::placeholder {
  opacity: 0.45;
}

.docker-table-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  /* 列多超出面板宽时横向滚动兜底（面板本身可拖宽，见 App.vue 的 docker divider）。 */
  overflow-x: auto;
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

/* 列设最小宽度：窄面板下表格总宽超过容器 → wrap 横向滚动展示完整内容，
   而不是各列被省略号挤没；宽面板下仍按 max-width 截长内容。 */
.docker-cell-name {
  min-width: 110px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-cell-image {
  min-width: 130px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.docker-cell-state {
  min-width: 96px;
  white-space: nowrap;
}

.docker-status {
  display: block;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.6;
}

/* 端口映射串很长且逗号分隔：允许换行展示全部映射（省略号会吞信息），
   列宽在 min/max 间自适应，默认面板宽度下五列 + 操作列即可全部见。 */
.docker-cell-ports {
  min-width: 130px;
  max-width: 220px;
}

.docker-col-actions {
  min-width: 44px;
  white-space: nowrap;
  text-align: right;
}

/* 行操作悬浮下拉：触发器（⌄，终端回填成功短暂显示 ✓）+ hover 菜单。 */
.docker-row-trigger svg {
  width: 14px;
  height: 14px;
}

.docker-row-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  border-radius: 6px;
  padding: 5px 10px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.docker-row-menu-item svg {
  width: 14px;
  height: 14px;
  flex-basis: 14px;
  opacity: 0.75;
}

.docker-row-menu-item:hover:not(:disabled),
.docker-row-menu-item:focus-visible {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  outline: none;
}

.docker-row-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.docker-row-menu-item--danger:hover:not(:disabled),
.docker-row-menu-item--danger:focus-visible {
  background: color-mix(in srgb, var(--danger, #d64545) 16%, transparent);
  color: var(--danger, #d64545);
}

.docker-row-menu-sep {
  height: 1px;
  margin: 3px 6px;
  background: var(--border, rgba(128, 128, 128, 0.25));
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
