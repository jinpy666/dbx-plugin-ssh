<script setup lang="ts">
// 端口映射管理弹窗（-L/-R，ssh(1)/Xshell 语义）：列表 + 添加表单 + 停止。
// 状态、RPC 编排与 ssh/forward/state 事件订阅都在本组件内；App.vue 只负责
// 工具栏入口。纯逻辑（解析/校验/格式化）在 lib/portForward.ts。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Loader2, Plus, Square, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import {
  applyForwardState,
  findForwardConflict,
  formatForwardBytes,
  formatForwardRoute,
  forwardStartParams,
  listenHostOptions,
  parseForwards,
  parseInterfaces,
  validateForwardForm,
  type ForwardFormDraft,
  type ForwardFormError,
  type HostInterface,
  type PortForward,
} from "../lib/portForward";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { deleteTunnelProfile, loadTunnelProfiles, saveTunnelProfile, type TunnelProfile } from "../lib/tunnelProfiles";

interface Props {
  locale: string;
  open: boolean;
  /** 转发跟随的连接；面板按它拉取 `ssh/forward/list`。 */
  connectionId: string;
  /** 新建映射要挂到的会话；未连接（null）时添加表单禁用。 */
  sessionId: string | null;
  /** Independent manager starts mappings using connectionId and needs no PTY. */
  independent?: boolean;
  standalone?: boolean;
  quickStart?: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{ "update:open": [boolean]; error: [unknown] }>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const forwards = ref<PortForward[]>([]);
const profiles = ref<TunnelProfile[]>([]);
const startingSaved = ref(false);
const savedMessage = ref("");
let quickStartHandled = false;
const profileRoute = (profile: TunnelProfile) => formatForwardRoute({ ...profile, listenPort: Number(profile.listenPort), boundPort: 0, targetPort: Number(profile.targetPort) });
const normalizedHost = (host: string) => host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase() || "127.0.0.1";
function runningForward(profile: TunnelProfile): PortForward | undefined {
  return forwards.value.find((row) => row.state !== "stopped" && row.state !== "error"
    && row.kind === profile.kind && row.listenHost === normalizedHost(profile.listenHost)
    && row.listenPort === Number(profile.listenPort)
    && (profile.kind === "dynamic" || (row.targetHost === normalizedHost(profile.targetHost) && row.targetPort === Number(profile.targetPort))));
}
const inactiveProfiles = computed(() => profiles.value.filter((profile) => !runningForward(profile)));
function refreshProfiles() { profiles.value = loadTunnelProfiles(props.connectionId); }
const forwardsLoading = ref(false);
let forwardListRevision = 0;
const forwardsBusyId = ref<string | null>(null);
const forwardForm = reactive<ForwardFormDraft>({
  kind: "local",
  listenHost: "127.0.0.1",
  listenPort: "",
  targetHost: "",
  targetPort: "",
});
/** 已翻译的表单错误（校验码或冲突预检文案），空串即无错误。 */
const forwardFormMessage = ref("");
const interfaces = ref<HostInterface[]>([]);
/** datalist id：绑定监听输入框与网卡候选列表。 */
const hostOptionListId = "forward-listen-host-options";
/** 按方向的静态默认候选：远程（-R）绑定在 SSH 服务器上，默认给服务器侧的
 * 回环/全接口/通配组；本地（-L）给本机的全接口 + 回环字面量。 */
const hostOptions = computed(() => listenHostOptions(forwardForm.kind));
/** 本机网卡探测候选只在本地方向追加（远程方向的监听地址属于服务器，客户机
 * 网卡是误导）；与静态候选按地址去重，探测失败自然退化为纯静态组。 */
const probedInterfaceOptions = computed(() => {
  if (forwardForm.kind === "remote") return [];
  const known = new Set(hostOptions.value.map((option) => option.value));
  return interfaces.value.filter((iface) => !known.has(iface.addr));
});

async function refreshForwards() {
  if (!props.connectionId) return;
  const revision = ++forwardListRevision;
  forwardsLoading.value = true;
  try {
    const payload = await window.dbxPlugin.invoke("ssh/forward/list", { connectionId: props.connectionId });
    if (revision === forwardListRevision) forwards.value = parseForwards(payload);
  } catch (cause) {
    if (revision !== forwardListRevision) return;
    console.warn("[port-forward] list failed", cause);
    emit("error", cause);
  } finally {
    if (revision === forwardListRevision) forwardsLoading.value = false;
  }
}

/** 网卡地址探测（含回环）：失败静默降级为仅手输，选择器隐藏。 */
async function refreshInterfaces() {
  try {
    interfaces.value = parseInterfaces(await window.dbxPlugin.invoke("ssh/forward/interfaces"));
  } catch (cause) {
    console.warn("[port-forward] interface probe failed", cause);
    interfaces.value = [];
  }
}

function applyForwardFormError(code: ForwardFormError) {
  forwardFormMessage.value = code ? t(`forwards.error.${code}`) : "";
}

const submitting = ref(false);

async function startDraft(draft: ForwardFormDraft) {
  const startParams = forwardStartParams(draft, props.independent ? props.connectionId : props.sessionId!, !!props.independent);
  let payload: unknown;
  try {
    payload = await window.dbxPlugin.invoke("ssh/forward/start", startParams);
  } catch (cause) {
    if (!props.independent || !String(cause).includes("Connection is not active")) throw cause;
    if (window.dbxPlugin.reopenConnection) await window.dbxPlugin.reopenConnection(props.connectionId);
    else await window.dbxPlugin.request("host.reopenConnection", { connectionId: props.connectionId });
    payload = await window.dbxPlugin.invoke("ssh/forward/start", startParams);
  }
  const started = parseForwards(payload);
  if (started.length) forwards.value = [...forwards.value.filter((row) => row.id !== started[0].id), ...started];
}

async function submitForward() {
  const error = validateForwardForm(forwardForm);
  if (error) {
    applyForwardFormError(error);
    return;
  }
  const conflict = findForwardConflict(forwards.value, forwardForm);
  if (conflict) {
    forwardFormMessage.value = t("forwards.error.conflict", {
      route: `${forwardForm.listenHost.trim() || "127.0.0.1"}:${forwardForm.listenPort.trim()}`,
      existing: formatForwardRoute(conflict),
    });
    return;
  }
  // 无会话时按钮本身已禁用，这里再兜底一次并给出可见提示，避免静默无响应。
  if (!props.independent && !props.sessionId) {
    forwardFormMessage.value = t("forwards.error.noSession");
    return;
  }
  if (submitting.value) return;
  submitting.value = true;
  forwardFormMessage.value = "";
  try {
    await startDraft(forwardForm);
    forwardFormMessage.value = "";
  } catch (cause) {
    // 既在弹窗内显示错误文案，又向父级冒泡，确保任何失败都有可见反馈。
    forwardFormMessage.value = cause instanceof Error ? cause.message : String(cause);
    emit("error", cause);
  } finally {
    submitting.value = false;
  }
}

function saveCurrentProfile() {
  const error = validateForwardForm(forwardForm);
  if (error) { applyForwardFormError(error); return; }
  try {
    saveTunnelProfile(props.connectionId, forwardForm);
    refreshProfiles();
    savedMessage.value = t("forwards.profileSaved");
  } catch (cause) { forwardFormMessage.value = String(cause); }
}

function removeProfile(id: string) {
  deleteTunnelProfile(id);
  refreshProfiles();
}

async function startSaved(profilesToStart = profiles.value) {
  if (startingSaved.value) return;
  startingSaved.value = true;
  savedMessage.value = "";
  const failures: string[] = [];
  let started = 0;
  for (const profile of profilesToStart) {
    if (runningForward(profile)) continue;
    if (findForwardConflict(forwards.value, profile)) continue;
    try { await startDraft(profile); started += 1; }
    catch (cause) { failures.push(`${profileRoute(profile)}: ${String(cause)}`); }
  }
  savedMessage.value = failures.length ? failures.join("\n") : t("forwards.profilesStarted", { count: started });
  startingSaved.value = false;
}

async function toggleProfile(profile: TunnelProfile) {
  const running = runningForward(profile);
  if (running) await stopForward(running.id);
  else await startSaved([profile]);
}

async function stopForward(id: string) {
  if (forwardsBusyId.value) return;
  forwardsBusyId.value = id;
  try {
    await window.dbxPlugin.invoke("ssh/forward/stop", { id });
    forwards.value = forwards.value.filter((row) => row.id !== id);
  } catch (cause) {
    console.warn("[port-forward] stop failed", cause);
    emit("error", cause);
  } finally {
    forwardsBusyId.value = null;
  }
}

// ssh/forward/state 是 sidecar 的广播事件（含本工作台未发起的变更），挂在
// 自己的监听器上，面板关着也保持列表新鲜；停止的行由事件摘除。
function handleForwardEvent(event: DbxPluginEvent) {
  if (event.type === "env") return; // 宿主环境推送（locale/theme）不携带 method
  if (event.method !== "ssh/forward/state") return;
  if (event.params.connectionId !== props.connectionId) return;
  // An event can arrive while the opening list request is still in flight.
  // Its snapshot may predate the event, so it must not overwrite the newer state.
  ++forwardListRevision;
  forwardsLoading.value = false;
  const known = forwards.value.some((row) => row.id === event.params.id);
  forwards.value = applyForwardState(forwards.value, event.params);
  if (event.params.state === "stopped") {
    forwards.value = forwards.value.filter((row) => row.id !== event.params.id);
  } else if (!known) {
    // The context menu starts tunnels outside this workbench. State events do
    // not contain a complete row, so fetch it from the sidecar on first sight.
    void refreshForwards();
  }
}

let unsubscribeEvent: (() => void) | undefined;
onMounted(() => {
  unsubscribeEvent = window.dbxPlugin.onEvent(handleForwardEvent);
});
onBeforeUnmount(() => {
  unsubscribeEvent?.();
});

watch(
  () => props.open,
  (open) => {
    if (open) {
      forwardFormMessage.value = "";
      void refreshForwards().then(() => {
        refreshProfiles();
        if (props.quickStart && !quickStartHandled) {
          quickStartHandled = true;
          void startSaved();
        }
      });
      void refreshInterfaces();
    }
  },
  { immediate: true },
);
</script>

<template>
  <component :is="props.standalone ? 'div' : Dialog" :open="props.open" @update:open="(open: boolean) => emit('update:open', open)">
    <component :is="props.standalone ? 'section' : DialogContent" class="modal forwards-modal" :class="{ 'forwards-modal--standalone': props.standalone, 'forwards-modal--manager': props.independent }" @escape-key-down.prevent>
      <header>
        <component :is="props.standalone ? 'h1' : DialogTitle">{{ t("forwards.title") }}</component>
        <button v-if="!props.standalone" :title="t('close')" :aria-label="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <div class="forwards-body">
        <section v-if="props.independent" class="forward-profiles">
          <header><h2>{{ t("forwards.savedTitle") }}</h2><button v-if="!profiles.length || inactiveProfiles.length" type="button" class="primary-button" :disabled="startingSaved || !inactiveProfiles.length" @click="startSaved()">{{ t("forwards.startAllSaved") }}</button></header>
          <p v-if="!profiles.length" class="forward-form-hint">{{ t("forwards.noProfiles") }}</p>
          <ul v-else class="forwards-list">
            <li v-for="profile in profiles" :key="profile.id" class="forward-row">
              <span class="forward-kind" :class="`forward-kind--${profile.kind}`">{{ t(`forwards.${profile.kind}`) }}</span>
              <span class="forward-route">{{ profileRoute(profile) }}</span>
              <button type="button" class="primary-button" :disabled="startingSaved || !!forwardsBusyId" @click="toggleProfile(profile)">{{ t(runningForward(profile) ? "forwards.stop" : "forwards.startSaved") }}</button>
              <button type="button" class="forward-stop" :title="t('forwards.deleteSaved')" :aria-label="t('forwards.deleteSaved')" @click="removeProfile(profile.id)"><X /></button>
            </li>
          </ul>
          <p v-if="savedMessage" class="forward-form-hint" role="status">{{ savedMessage }}</p>
        </section>
        <h2 v-if="props.independent" class="forward-section-title">{{ t("forwards.activeTitle") }}</h2>
        <div v-if="forwardsLoading && !forwards.length" class="empty"><Loader2 class="spinning" />{{ t("loading") }}</div>
        <div v-else-if="!forwards.length" class="empty">{{ t("forwards.empty") }}</div>
        <ul v-else class="forwards-list">
          <li v-for="row in forwards" :key="row.id" class="forward-row">
            <span class="forward-kind" :class="`forward-kind--${row.kind}`">{{ t(`forwards.${row.kind}`) }}</span>
            <span class="forward-route">{{ formatForwardRoute(row) }}</span>
            <span class="forward-state" :class="`forward-state--${row.state}`" :title="row.error || ''">{{ t(`forwards.state.${row.state}`) }}</span>
            <span class="forward-stats" :title="t('forwards.statsTitle')">
              {{ row.connectionsActive }}/{{ row.connectionsTotal }} · ↑{{ formatForwardBytes(row.bytesUp) }} ↓{{ formatForwardBytes(row.bytesDown) }}
            </span>
            <button class="forward-stop" :title="t('forwards.stop')" :aria-label="t('forwards.stop')" :disabled="forwardsBusyId !== null" @click="stopForward(row.id)"><Square v-if="forwardsBusyId === row.id" /><X v-else /></button>
          </li>
        </ul>
        <form class="forward-form" @submit.prevent="submitForward">
          <!-- fieldset 的 disabled 才是真正禁用内部控件；原 <form disabled> 是无效
               属性，会导致输入框仍可用、只有按钮变灰，造成「填了内容却点不动」的
               静默死按钮。无会话或提交中统一禁用并给出可见提示。 -->
          <fieldset class="forward-form-fields" :disabled="(!props.independent && !props.sessionId) || submitting" style="border:0;margin:0;padding:0;min-inline-size:0">
            <div class="forward-form-row forward-form-kinds">
              <label class="forward-kind-picker">
                <input v-model="forwardForm.kind" type="radio" value="local" />{{ t("forwards.local") }}
              </label>
              <label class="forward-kind-picker">
                <input v-model="forwardForm.kind" type="radio" value="remote" />{{ t("forwards.remote") }}
              </label>
              <label class="forward-kind-picker">
                <input v-model="forwardForm.kind" type="radio" value="dynamic" />{{ t("forwards.dynamic") }}
              </label>
            </div>
            <div class="forward-form-row forward-form-addresses">
              <label class="forward-field">
                <span>{{ t("forwards.listen") }}</span>
                <span class="forward-field-pair">
                  <input
                    v-model="forwardForm.listenHost"
                    :placeholder="t('forwards.listenHostPlaceholder')"
                    :list="hostOptionListId"
                  />
                  <!-- 候选随方向切换：静态默认在前，本机网卡（仅 -L）去重后追加。
                       ip+网卡名同框：datalist 候选 value=可绑定 IP，网卡名作说明
                       文案；手输与点选同一输入框，探测失败自动退化为纯手输。 -->
                  <datalist :id="hostOptionListId">
                    <option v-for="option in hostOptions" :key="option.value" :value="option.value">
                      {{ t(option.labelKey) }}
                    </option>
                    <option v-for="iface in probedInterfaceOptions" :key="iface.addr" :value="iface.addr">
                      {{ iface.isLoopback ? t("forwards.loopback") : iface.name }}
                    </option>
                  </datalist>
                  <input v-model="forwardForm.listenPort" inputmode="numeric" :placeholder="t('forwards.portPlaceholder')" />
                </span>
              </label>
              <label v-if="forwardForm.kind !== 'dynamic'" class="forward-field">
                <span>{{ t("forwards.target") }}</span>
                <span class="forward-field-pair">
                  <input v-model="forwardForm.targetHost" :placeholder="t('forwards.targetHostPlaceholder')" />
                  <input v-model="forwardForm.targetPort" inputmode="numeric" :placeholder="t('forwards.portPlaceholder')" />
                </span>
              </label>
            </div>
          </fieldset>
          <p v-if="forwardForm.kind === 'remote'" class="forward-form-hint">{{ t("forwards.remoteListenTip") }}</p>
          <p v-if="!props.independent && !props.sessionId" class="forward-form-hint">{{ t("forwards.error.noSession") }}</p>
          <p v-if="forwardFormMessage" class="forward-form-error">{{ forwardFormMessage }}</p>
          <footer>
            <button v-if="props.independent" type="button" :disabled="submitting" @click="saveCurrentProfile">{{ t("forwards.saveProfile") }}</button>
            <button type="submit" class="primary-button" :disabled="(!props.independent && !props.sessionId) || submitting">
              <Loader2 v-if="submitting" class="spinning" /><Plus v-else />{{ t("forwards.add") }}
            </button>
          </footer>
        </form>
      </div>
    </component>
  </component>
</template>
