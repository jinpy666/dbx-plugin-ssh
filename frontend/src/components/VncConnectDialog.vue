<script setup lang="ts">
// VNC 连接弹窗（nyaterm-parity P2 2d）：Host/Port/密码/缩放模式。
// 纯 UI：不做连接编排，App.vue 持有会话状态；密码 ≤8 字符是 classic VNC
// 认证的协议上限（sidecar 也会拒绝），明文安全提示与 Telnet 同款常驻。
import { reactive, ref, watch } from "vue";
import { TriangleAlert } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { loadLastConnectParams, persistLastConnectParams } from "../lib/connectLastParams";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export interface VncConnectOptions {
  host: string;
  port: number;
  password?: string;
  scaleMode: "fit" | "stretch" | "actual";
}

interface Props {
  locale: string;
  open: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{ "update:open": [boolean]; connect: [VncConnectOptions] }>();

const t = (key: string, values: Record<string, string | number> = {}) =>
  workbenchMessage(props.locale, key, values);

const form = reactive({
  host: "",
  port: "5900",
  password: "",
  scaleMode: "fit" as VncConnectOptions["scaleMode"],
});

// 上次连接参数记忆（pluginStore，跨会话保留；VNC 密码不落盘）。
const VNC_LAST_KEY = "vnc-connect-last";
for (const [key, value] of Object.entries(loadLastConnectParams<VncConnectOptions>(VNC_LAST_KEY))) {
  if (typeof value === "string" && key in form) (form as unknown as Record<string, unknown>)[key] = value;
}
function persistLastVncForm() {
  persistLastConnectParams(VNC_LAST_KEY, {
    host: form.host,
    port: form.port,
    scaleMode: form.scaleMode,
  });
}
const hostError = ref(false);
const passwordError = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      hostError.value = false;
      passwordError.value = false;
    }
  },
);

function submit() {
  const host = form.host.trim();
  if (!host) {
    hostError.value = true;
    return;
  }
  // classic VNC-Auth 密码按字节计最多 8；超限在表单层即拒（sidecar 同校验）。
  if (form.password.length > 8) {
    passwordError.value = true;
    return;
  }
  const port = Number.parseInt(form.port, 10);
  persistLastVncForm();
  emit("update:open", false);
  emit("connect", {
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 5900,
    scaleMode: form.scaleMode,
    ...(form.password ? { password: form.password } : {}),
  });
  form.password = "";
}
</script>

<template>
  <Dialog :open="open" @update:open="(open) => emit('update:open', open)">
    <DialogContent class="modal small-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("vnc.dialogTitle") }}</DialogTitle>
        <button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <p class="muted vnc-security-note"><TriangleAlert class="h-3.5 w-3.5" />{{ t("vnc.security") }}</p>
      <div class="vnc-form-grid">
        <label class="settings-field">
          <span>{{ t("vnc.host") }}</span>
          <input v-model="form.host" class="mono" :placeholder="t('vnc.hostPlaceholder')" spellcheck="false" :aria-invalid="hostError" @keydown.enter="submit" @input="hostError = false" />
        </label>
        <label class="settings-field">
          <span>{{ t("vnc.port") }}</span>
          <input v-model="form.port" class="mono" inputmode="numeric" spellcheck="false" @keydown.enter="submit" />
        </label>
        <label class="settings-field">
          <span>{{ t("vnc.password") }}</span>
          <input v-model="form.password" type="password" autocomplete="off" spellcheck="false" :placeholder="t('vnc.passwordHint')" :aria-invalid="passwordError" @keydown.enter="submit" @input="passwordError = false" />
        </label>
        <label class="settings-field">
          <span>{{ t("vnc.scaleMode") }}</span>
          <select v-model="form.scaleMode">
            <option value="fit">{{ t("vnc.scaleMode.fit") }}</option>
            <option value="stretch">{{ t("vnc.scaleMode.stretch") }}</option>
            <option value="actual">{{ t("vnc.scaleMode.actual") }}</option>
          </select>
        </label>
      </div>
      <p v-if="passwordError" class="muted vnc-password-error">{{ t("vnc.passwordError") }}</p>
      <footer>
        <button @click="emit('update:open', false)">{{ t("cancel") }}</button>
        <button class="primary-button" @click="submit">{{ t("vnc.connect") }}</button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.vnc-security-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.5;
}
.vnc-security-note svg {
  flex: 0 0 14px;
  margin-top: 1px;
  color: var(--warning, #b45309);
}
.vnc-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
  margin-bottom: 8px;
}
.vnc-form-grid select {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
}
.vnc-password-error {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--danger, #dc2626);
}
</style>
