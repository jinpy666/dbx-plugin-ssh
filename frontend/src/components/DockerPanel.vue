<script setup lang="ts">
// Docker 管理面板（IMPL_PLAN v2 Task P2-4 前端半）：容器列表表 + 10s 轮询
// （3 连败自动停轮询）+ 生命周期动作（start/stop/restart 直发；kill/rm 强制
// 确认）+ Logs 抽屉（docker/logs，tail 可选）+ 「在终端打开」。
// 只读采集走 docker/list；动作走 docker/action（后端负责白名单、容器 id 门、
// 只读连接拒绝、执行前审计与 Quick Sudo 回落）。会话 id 由面板自行从
// ssh/sessions/list 解析（最近的存活会话）——SideNavPanel 容器不透传 session。
// 「在终端打开」（B5）：直接打开容器工作台的终端 tab（PTY 在 sidecar 内建立，
// 键入走 docker/terminal/in，输出走 docker/terminal/out）。不再向主终端输入行
// 填命令，也不再派发 dbx:docker-open-in-terminal window 事件。
import { computed, onMounted, onScopeDispose, onUnmounted, ref, watch } from "vue";
import {
  Loader2,
  RefreshCw,
  Settings,
  X,
} from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import DockerContainerList, { type DockerContainerRow } from "./DockerContainerList.vue";
import DockerLogsDrawer from "./DockerLogsDrawer.vue";
import DockerStatsBar from "./DockerStatsBar.vue";
import DockerWorkbench from "./DockerWorkbench.vue";
import { useDockerStats } from "../composables/useDockerStats";
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

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  /** 工作台当前连接的 SSH 会话（App 传入）：多台服务器同时有存活会话时，
   * “全局最新会话”猜测会把面板绑到别的机器（#168 错乱主因）；绑定一律以
   * 工作台会话为准，缺省时才回落旧启发式。 */
  sessionId?: string;
  connectionId?: string;
  /** 当前工作台目标：显式本机模式不得被其他存活 SSH 会话覆盖。 */
  targetMode?: "ssh" | "local";
}>();

type DockerContainer = DockerContainerRow;

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
  // 本地工作台由 App 明确标记：不能被其他存活 SSH 会话覆盖。
  if (props.targetMode === "local") {
    sessionId.value = "";
    mode.value = "local";
    adoptConnection("");
    return "local";
  }
  // 工作台绑定会话优先（#168）：有 sessionId prop 就严格绑定本工作台的
  // 连接，绝不按“全局最新会话”猜测其他机器。
  if (props.sessionId) {
    sessionId.value = props.sessionId;
    mode.value = "ssh";
    adoptConnection(props.connectionId || "");
    return "ssh";
  }
  if (props.targetMode === "ssh") {
    // 显式 SSH 工作台失去当前会话时，不要沿用之前缓存的旧 session。
    sessionId.value = "";
    mode.value = "ssh";
    adoptConnection(props.connectionId || "");
  } else if (mode.value === "ssh" && sessionId.value) {
    return "ssh";
  }
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
  // needsSudo 是只读探针结果；容器终端据此决定是否要求 sudo 预热（不是授权依据）。
  return {
    ...base,
    ...dockerEngineParams(engineSettings.value),
    ...(needsSudo.value ? { needsSudo: true } : {}),
  };
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
let targetRevision = 0;
let refreshQueued = false;

async function refresh(): Promise<void> {
  if (loading.value) {
    refreshQueued = true;
    return;
  }
  loading.value = true;
  const revision = targetRevision;
  try {
    await resolveMode();
    if (revision !== targetRevision) {
      refreshQueued = true;
      return;
    }
    const payload = dockerListPayload(
      await window.dbxPlugin.invoke<unknown>(
        "docker/list",
        dockerParams(),
        { timeoutMs: LIST_TIMEOUT_MS },
      ),
    );
    if (revision !== targetRevision) {
      refreshQueued = true;
      return;
    }
    containers.value = payload.containers;
    available.value = payload.available;
    needsSudo.value = payload.needsSudo;
    listError.value = "";
    consecutiveFailures = 0;
    pollPaused.value = false;
  } catch (cause) {
    if (revision !== targetRevision) {
      refreshQueued = true;
      return;
    }
    consecutiveFailures += 1;
    listError.value = cause instanceof Error ? cause.message : String(cause);
    if (consecutiveFailures >= POLL_MAX_FAILURES) stopPolling();
  } finally {
    loading.value = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh();
    }
  }
}

watch(
  () => [props.targetMode, props.sessionId, props.connectionId],
  () => {
    targetRevision += 1;
    containers.value = [];
    available.value = null;
    needsSudo.value = false;
    listError.value = "";
    void refresh();
  },
);

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

// —— B2 容器指标（只读，3s 轮询；页面隐藏即停）——————————————————
const { snapshot: statsSnapshot, history: statsHistory, error: statsError } = useDockerStats({
  params: dockerParams,
  containerIds: () => containers.value.filter((c) => c.state === "running").map((c) => c.id),
  enabled: () => available.value === true,
});

// —— 生命周期动作（kill/rm 先确认）———————————————————————
const busyContainerId = ref("");
const actionError = ref("");

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

// —— 列表事件（行操作/工作台；菜单开合在 DockerContainerList 内部）———————
/** 行操作入口：kill/rm 仍走确认弹层，其余直接派发。 */
function handleListAction(container: DockerContainer, action: DockerActionName): void {
  requestAction(container, action);
}

// —— 容器工作台（B4 文件只读 + B5 终端）——————————————
const filesOpen = ref(false);
const filesTarget = ref<DockerContainer | null>(null);
const workbenchTab = ref<"files" | "terminal">("files");

function openContainerFiles(container: DockerContainer): void {
  filesTarget.value = container;
  workbenchTab.value = "files";
  filesOpen.value = true;
}

function openContainerTerminal(container: DockerContainer): void {
  filesTarget.value = container;
  workbenchTab.value = "terminal";
  filesOpen.value = true;
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

const running = (container: DockerContainer): boolean => container.state === "running";
</script>

<template>
  <div class="docker-panel">
    <div class="docker-header">
      <strong>{{ props.t("docker.title") }}</strong>
      <span v-if="mode === 'local'" class="docker-source-badge">{{ props.t("docker.localSource") }}</span>
      <span v-if="available && containers.length" class="docker-count">{{ containers.length }}</span>
      <span class="docker-header-spacer" />
      <button v-if="engineSettings.cli" type="button" class="docker-engine-badge" :title="props.t('docker.engineBadge', { cli: engineSettings.cli })" :aria-label="props.t('docker.engineBadge', { cli: engineSettings.cli })" @click="toggleEngineSettings">
        {{ engineSettings.cli }}
      </button>
      <button
        v-if="pollPaused"
        type="button"
        class="docker-link-button"
        :title="props.t('docker.pollStopped')" :aria-label="props.t('docker.pollStopped')"
        @click="retryPolling"
      >
        {{ props.t("docker.refresh") }}
      </button>
      <button v-else type="button" class="icon-button" :title="props.t('docker.refresh')" :aria-label="props.t('docker.refresh')" @click="refresh">
        <Loader2 v-if="loading" class="spinning" />
        <RefreshCw v-else />
      </button>
      <Popover :open="engineOpen" @update:open="(open: boolean) => { if (!open) engineOpen = false; }">
        <PopoverAnchor as-child>
          <button type="button" class="icon-button" :class="{ 'is-active': engineOpen }" :title="props.t('docker.engineSettings')" :aria-label="props.t('docker.engineSettings')" @click="toggleEngineSettings">
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

    <DockerStatsBar v-if="available === true" :t="props.t" :snapshot="statsSnapshot" :history="statsHistory" :error="statsError" />

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

    <!-- 容器表 + 本地搜索/状态筛选（行操作与过滤在 DockerContainerList） -->
    <DockerContainerList
      v-else
      :t="props.t"
      :containers="containers"
      :busy-ids="busyContainerId ? [busyContainerId] : []"
      @action="handleListAction"
      @logs="openLogs"
      @files="openContainerFiles"
      @terminal="openContainerTerminal"
    />

    <!-- kill/rm 强制确认 -->
      <Dialog :open="!!confirmTarget" @update:open="(open: boolean) => { if (!open) void confirmAction(false); }">

      <DialogContent class="docker-dialog" @escape-key-down.prevent>
        <div class="docker-dialog-header">
          <DialogTitle>
            {{ confirmTarget ? props.t("docker.confirmTitle", { action: props.t(ACTION_LABEL_KEYS[confirmTarget.action]) }) : "" }}
          </DialogTitle>
          <button type="button" class="icon-button" :title="props.t('docker.cancel')" :aria-label="props.t('docker.cancel')" @click="confirmAction(false)"><X /></button>
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
    <!-- 容器文件工作台（B4，只读） -->
    <DockerWorkbench v-model:open="filesOpen" :t="props.t" :target="filesTarget" :params="dockerParams" :initial-tab="workbenchTab" />
    <!-- Logs 抽屉（B1 外抽，状态仍在本组件） -->
    <DockerLogsDrawer
      :t="props.t"
      :open="logsOpen"
      :target="logsTarget"
      :text="logsText"
      :meta="logsMeta"
      :busy="logsBusy"
      :error="logsError"
      :tail="logsTail"
      :stream-base="dockerParams()"
      @update:open="(open: boolean) => { logsOpen = open; }"
      @update:tail="(value: string) => { logsTail = value; void loadLogs(); }"
      @refresh="loadLogs"
    />
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

.spinning {
  animation: docker-spin 1s linear infinite;
}

@keyframes docker-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
