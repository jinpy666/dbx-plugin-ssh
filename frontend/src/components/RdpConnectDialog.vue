<script setup lang="ts">
// RDP 连接弹窗（nyaterm-parity P3-4）：Host/Port/NLA 凭据/分辨率/证书策略。
// 纯 UI：不做连接编排，App.vue 持有会话状态；凭据（用户名/密码/域）不落盘，
// 仅记忆主机参数与桌面偏好。密码经 NLA（CredSSP）走 TLS，安全提示与
// Telnet/VNC 同款常驻（远端可读写会话剪贴板，仅连接可信主机）。
import { reactive, ref, watch } from "vue";
import { TriangleAlert, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { loadLastConnectParams, persistLastConnectParams } from "../lib/connectLastParams";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export interface RdpConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  domain?: string;
  width: number;
  height: number;
  certificatePolicy: "prompt" | "strict" | "accept-temporarily";
  clipboard: boolean;
  scaleMode: "fit" | "stretch" | "actual";
}

interface Props {
  locale: string;
  open: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{ "update:open": [boolean]; connect: [RdpConnectOptions] }>();

const t = (key: string, values: Record<string, string | number> = {}) =>
  workbenchMessage(props.locale, key, values);

const form = reactive({
  host: "",
  port: "3389",
  username: "",
  password: "",
  domain: "",
  width: "1280",
  height: "800",
  certificatePolicy: "prompt" as RdpConnectOptions["certificatePolicy"],
  clipboard: true,
  scaleMode: "fit" as RdpConnectOptions["scaleMode"],
});

// 上次连接参数记忆（pluginStore，跨会话保留；凭据类字段（username/password）
// 一律不落盘。domain 是 Windows 域名，非机密，按连接参数一起记忆——与
// sidecar rdp/list 明文回显 domain 的语义一致）。
const RDP_LAST_KEY = "rdp-connect-last";
for (const [key, value] of Object.entries(loadLastConnectParams<RdpConnectOptions>(RDP_LAST_KEY))) {
  if (typeof value === "string" && key in form) (form as unknown as Record<string, unknown>)[key] = value;
  if (typeof value === "boolean" && (key === "clipboard")) form.clipboard = value;
  if (key === "certificatePolicy" && (value === "prompt" || value === "strict" || value === "accept-temporarily")) {
    form.certificatePolicy = value;
  }
  if (key === "scaleMode" && (value === "fit" || value === "stretch" || value === "actual")) {
    form.scaleMode = value;
  }
}
function persistLastRdpForm() {
  persistLastConnectParams(RDP_LAST_KEY, {
    host: form.host,
    port: form.port,
    domain: form.domain,
    width: form.width,
    height: form.height,
    certificatePolicy: form.certificatePolicy,
    clipboard: form.clipboard,
    scaleMode: form.scaleMode,
  });
}

// 桌面尺寸门限（与 sidecar validate_desktop_size 同界：640x480..3840x2160）。
const MIN_WIDTH = 640;
const MAX_WIDTH = 3840;
const MIN_HEIGHT = 480;
const MAX_HEIGHT = 2160;

const hostError = ref(false);
const sizeError = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      hostError.value = false;
      sizeError.value = false;
    }
  },
);

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3389;
}

function parseDimension(raw: string, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function submit() {
  const host = form.host.trim();
  if (!host) {
    hostError.value = true;
    return;
  }
  const width = parseDimension(form.width, MIN_WIDTH, MAX_WIDTH, 1280);
  const height = parseDimension(form.height, MIN_HEIGHT, MAX_HEIGHT, 800);
  if (!Number.isInteger(Number(form.width)) || !Number.isInteger(Number(form.height))) {
    sizeError.value = true;
    return;
  }
  if (width !== Number(form.width) || height !== Number(form.height)) {
    sizeError.value = true;
    return;
  }
  const port = parsePort(form.port);
  persistLastRdpForm();
  emit("update:open", false);
  emit("connect", {
    host,
    port,
    username: form.username.trim(),
    ...(form.password ? { password: form.password } : {}),
    ...(form.domain.trim() ? { domain: form.domain.trim() } : {}),
    width,
    height,
    certificatePolicy: form.certificatePolicy,
    clipboard: form.clipboard,
    scaleMode: form.scaleMode,
  });
  form.password = "";
}
</script>

<template>
  <Dialog :open="open" @update:open="(open) => emit('update:open', open)">
    <DialogContent class="modal small-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("rdp.dialogTitle") }}</DialogTitle>
        <button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <p class="muted vnc-security-note"><TriangleAlert class="h-3.5 w-3.5" />{{ t("rdp.security") }}</p>
      <div class="vnc-form-grid">
        <label class="settings-field">
          <span>{{ t("rdp.host") }}</span>
          <input v-model="form.host" class="mono" :placeholder="t('rdp.hostPlaceholder')" spellcheck="false" :aria-invalid="hostError" @keydown.enter="submit" @input="hostError = false" />
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.port") }}</span>
          <input v-model="form.port" class="mono" inputmode="numeric" spellcheck="false" @keydown.enter="submit" />
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.username") }}</span>
          <input v-model="form.username" class="mono" autocomplete="off" spellcheck="false" :placeholder="t('rdp.usernamePlaceholder')" @keydown.enter="submit" />
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.password") }}</span>
          <input v-model="form.password" type="password" autocomplete="off" spellcheck="false" :placeholder="t('rdp.passwordHint')" @keydown.enter="submit" />
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.domain") }}</span>
          <input v-model="form.domain" class="mono" autocomplete="off" spellcheck="false" :placeholder="t('rdp.domainHint')" @keydown.enter="submit" />
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.desktopSize") }}</span>
          <div class="rdp-size-row">
            <input v-model="form.width" class="mono" inputmode="numeric" :placeholder="t('rdp.width')" spellcheck="false" :aria-invalid="sizeError" @keydown.enter="submit" @input="sizeError = false" />
            <span class="rdp-size-x">×</span>
            <input v-model="form.height" class="mono" inputmode="numeric" :placeholder="t('rdp.height')" spellcheck="false" :aria-invalid="sizeError" @keydown.enter="submit" @input="sizeError = false" />
          </div>
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.certPolicy") }}</span>
          <select v-model="form.certificatePolicy">
            <option value="prompt">{{ t("rdp.certPolicy.prompt") }}</option>
            <option value="strict">{{ t("rdp.certPolicy.strict") }}</option>
            <option value="accept-temporarily">{{ t("rdp.certPolicy.acceptTemporarily") }}</option>
          </select>
        </label>
        <label class="settings-field">
          <span>{{ t("rdp.scaleMode") }}</span>
          <select v-model="form.scaleMode">
            <option value="fit">{{ t("rdp.scaleMode.fit") }}</option>
            <option value="stretch">{{ t("rdp.scaleMode.stretch") }}</option>
            <option value="actual">{{ t("rdp.scaleMode.actual") }}</option>
          </select>
        </label>
      </div>
      <label class="rdp-clipboard-toggle">
        <input v-model="form.clipboard" type="checkbox" />
        <span>{{ t("rdp.clipboard") }}</span>
      </label>
      <p v-if="sizeError" class="muted vnc-password-error">{{ t("rdp.sizeError") }}</p>
      <footer>
        <button @click="emit('update:open', false)">{{ t("cancel") }}</button>
        <button class="primary-button" @click="submit">{{ t("rdp.connect") }}</button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* 弹窗沿用 VNC 连接表单的布局类（vnc-security-note / vnc-form-grid /
   vnc-password-error 语义相同），仅补充 RDP 特有的尺寸行与剪贴板开关。 */
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
.rdp-size-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rdp-size-row input {
  min-width: 0;
  width: 100%;
}
.rdp-size-x {
  flex: none;
  color: var(--muted-foreground, #888);
}
.rdp-clipboard-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
}
</style>
