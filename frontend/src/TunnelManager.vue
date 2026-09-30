<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import PortForwardDialog from "./components/PortForwardDialog.vue";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { workbenchMessage } from "./lib/i18n";
import { tunnelManagerConnectionId } from "./lib/pluginContext";

const { context } = defineProps<{ context: Record<string, unknown> }>();
const connectionId = tunnelManagerConnectionId(context);
const quickStart = context.quickStart === true;
const locale = ref(window.dbxPlugin.locale || "zh-CN");
const t = (key: string) => workbenchMessage(locale.value, key);
const error = ref("");
const prompt = ref<{ challengeId: string; operationId: string; host: string; port: number; keyType: string; fingerprint: string } | null>(null);
const remember = ref(true);

const unsubscribe = window.dbxPlugin.onEvent((event) => {
  if (event.type === "env") {
    if (event.locale) locale.value = event.locale;
    return;
  }
  if (event.method !== "connection/challenge" && event.method !== "ssh/host-key/prompt") return;
  const params = event.params;
  if (params.connectionId && params.connectionId !== connectionId) return;
  prompt.value = {
    challengeId: String(params.challengeId || ""),
    operationId: String(params.operationId || ""),
    host: String(params.host || ""),
    port: Number(params.port) || 22,
    keyType: String(params.keyType || ""),
    fingerprint: String(params.fingerprint || ""),
  };
});
onBeforeUnmount(unsubscribe);

async function resolveHostKey(accept: boolean) {
  const current = prompt.value;
  if (!current) return;
  prompt.value = null;
  try {
    await window.dbxPlugin.invoke("connection/challenge/resolve", {
      challengeId: current.challengeId,
      operationId: current.operationId,
      accept,
      remember: accept && remember.value,
    });
  } catch (cause) {
    error.value = String(cause);
  }
}
</script>

<template>
  <main class="workbench tunnel-manager-root">
    <p v-if="error" class="forward-form-error">{{ error }}</p>
    <PortForwardDialog
      :locale="locale"
      :open="true"
      :connection-id="connectionId"
      :session-id="null"
      independent
      standalone
      :quick-start="quickStart"
      @error="error = String($event)"
    />
    <Dialog :open="!!prompt">
      <DialogContent class="modal host-key-modal" @escape-key-down.prevent @pointer-down-outside.prevent>
        <template v-if="prompt">
          <header><DialogTitle>{{ t("hostKeyDialog.title") }}</DialogTitle></header>
          <p>{{ t("hostKeyDialog.desc") }}</p>
          <dl><dt>{{ t("hostKeyDialog.server") }}</dt><dd>{{ prompt.host }}:{{ prompt.port }}</dd><dt>{{ t("hostKeyDialog.keyType") }}</dt><dd>{{ prompt.keyType }}</dd><dt>{{ t("hostKeyDialog.fingerprint") }}</dt><dd class="fingerprint">{{ prompt.fingerprint }}</dd></dl>
          <label class="remember"><input v-model="remember" type="checkbox" /> {{ t("hostKeyDialog.remember") }}</label>
          <footer><button @click="resolveHostKey(false)">{{ t("hostKeyDialog.reject") }}</button><button class="primary-button" @click="resolveHostKey(true)">{{ t("hostKeyDialog.trust") }}</button></footer>
        </template>
      </DialogContent>
    </Dialog>
  </main>
</template>
