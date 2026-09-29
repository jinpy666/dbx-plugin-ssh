<script setup lang="ts">
// 端口映射管理弹窗（-L/-R，ssh(1)/Xshell 语义）：列表 + 添加表单 + 停止。
// 状态、RPC 编排与 ssh/forward/state 事件订阅都在本组件内；App.vue 只负责
// 工具栏入口。纯逻辑（解析/校验/格式化）在 lib/portForward.ts。
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Loader2, Plus, Square, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import {
  applyForwardState,
  findForwardConflict,
  formatForwardBytes,
  formatForwardRoute,
  forwardStartParams,
  parseForwards,
  parseInterfaces,
  validateForwardForm,
  type ForwardFormDraft,
  type ForwardFormError,
  type HostInterface,
  type PortForward,
} from "../lib/portForward";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface Props {
  locale: string;
  open: boolean;
  /** 转发跟随的连接；面板按它拉取 `ssh/forward/list`。 */
  connectionId: string;
  /** 新建映射要挂到的会话；未连接（null）时添加表单禁用。 */
  sessionId: string | null;
}
const props = defineProps<Props>();
const emit = defineEmits<{ "update:open": [boolean]; error: [unknown] }>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const forwards = ref<PortForward[]>([]);
const forwardsLoading = ref(false);
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

async function refreshForwards() {
  if (!props.connectionId) return;
  forwardsLoading.value = true;
  try {
    const payload = await window.dbxPlugin.invoke("ssh/forward/list", { connectionId: props.connectionId });
    forwards.value = parseForwards(payload);
  } catch (cause) {
    console.warn("[port-forward] list failed", cause);
    emit("error", cause);
  } finally {
    forwardsLoading.value = false;
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
  if (!props.sessionId) {
    forwardFormMessage.value = t("forwards.error.noSession");
    return;
  }
  if (submitting.value) return;
  submitting.value = true;
  forwardFormMessage.value = "";
  try {
    const payload = await window.dbxPlugin.invoke(
      "ssh/forward/start",
      forwardStartParams(forwardForm, props.sessionId),
    );
    const started = parseForwards(payload);
    if (started.length) {
      forwards.value = [...forwards.value.filter((row) => row.id !== started[0].id), ...started];
    }
    forwardFormMessage.value = "";
  } catch (cause) {
    // 既在弹窗内显示错误文案，又向父级冒泡，确保任何失败都有可见反馈。
    forwardFormMessage.value = cause instanceof Error ? cause.message : String(cause);
    emit("error", cause);
  } finally {
    submitting.value = false;
  }
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
function handleForwardEvent(event: { method: string; params: Record<string, unknown> }) {
  if (event.method !== "ssh/forward/state") return;
  forwards.value = applyForwardState(forwards.value, event.params);
  if (event.params.state === "stopped") {
    forwards.value = forwards.value.filter((row) => row.id !== event.params.id);
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
      void refreshForwards();
      void refreshInterfaces();
    }
  },
);
</script>

<template>
  <Dialog :open="props.open" @update:open="(open) => emit('update:open', open)">
    <DialogContent class="modal forwards-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("forwards.title") }}</DialogTitle>
        <button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <div class="forwards-body">
        <div v-if="forwardsLoading && !forwards.length" class="empty"><Loader2 class="spinning" />{{ t("loading") }}</div>
        <div v-else-if="!forwards.length" class="empty">{{ t("forwards.empty") }}</div>
        <ul v-else class="forwards-list">
          <li v-for="row in forwards" :key="row.id" class="forward-row">
            <span class="forward-kind" :class="`forward-kind--${row.kind}`">{{ row.kind === "remote" ? t("forwards.remote") : t("forwards.local") }}</span>
            <span class="forward-route">{{ formatForwardRoute(row) }}</span>
            <span class="forward-state" :class="`forward-state--${row.state}`" :title="row.error || ''">{{ t(`forwards.state.${row.state}`) }}</span>
            <span class="forward-stats" :title="t('forwards.statsTitle')">
              {{ row.connectionsActive }}/{{ row.connectionsTotal }} · ↑{{ formatForwardBytes(row.bytesUp) }} ↓{{ formatForwardBytes(row.bytesDown) }}
            </span>
            <button class="forward-stop" :title="t('forwards.stop')" :disabled="forwardsBusyId !== null" @click="stopForward(row.id)"><Square v-if="forwardsBusyId === row.id" /><X v-else /></button>
          </li>
        </ul>
        <form class="forward-form" @submit.prevent="submitForward">
          <!-- fieldset 的 disabled 才是真正禁用内部控件；原 <form disabled> 是无效
               属性，会导致输入框仍可用、只有按钮变灰，造成「填了内容却点不动」的
               静默死按钮。无会话或提交中统一禁用并给出可见提示。 -->
          <fieldset class="forward-form-fields" :disabled="!props.sessionId || submitting" style="border:0;margin:0;padding:0;min-inline-size:0">
            <div class="forward-form-row forward-form-kinds">
              <label class="forward-kind-picker">
                <input v-model="forwardForm.kind" type="radio" value="local" />{{ t("forwards.local") }}
              </label>
              <label class="forward-kind-picker">
                <input v-model="forwardForm.kind" type="radio" value="remote" />{{ t("forwards.remote") }}
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
                  <!-- ip+网卡名同框：datalist 候选 value=可绑定 IP，网卡名作说明
                       文案；手输与点选同一输入框，探测失败自动退化为纯手输。 -->
                  <datalist :id="hostOptionListId">
                    <option value="0.0.0.0">{{ t("forwards.allInterfaces") }}</option>
                    <option v-for="iface in interfaces" :key="iface.addr" :value="iface.addr">
                      {{ iface.isLoopback ? t("forwards.loopback") : iface.name }}
                    </option>
                  </datalist>
                  <input v-model="forwardForm.listenPort" inputmode="numeric" :placeholder="t('forwards.portPlaceholder')" />
                </span>
              </label>
              <label class="forward-field">
                <span>{{ t("forwards.target") }}</span>
                <span class="forward-field-pair">
                  <input v-model="forwardForm.targetHost" :placeholder="t('forwards.targetHostPlaceholder')" />
                  <input v-model="forwardForm.targetPort" inputmode="numeric" :placeholder="t('forwards.portPlaceholder')" />
                </span>
              </label>
            </div>
          </fieldset>
          <p v-if="!props.sessionId" class="forward-form-hint">{{ t("forwards.error.noSession") }}</p>
          <p v-if="forwardFormMessage" class="forward-form-error">{{ forwardFormMessage }}</p>
          <footer>
            <button type="submit" class="primary-button" :disabled="!props.sessionId || submitting">
              <Loader2 v-if="submitting" class="spinning" /><Plus v-else />{{ t("forwards.add") }}
            </button>
          </footer>
        </form>
      </div>
    </DialogContent>
  </Dialog>
</template>
