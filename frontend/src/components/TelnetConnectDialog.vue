<script setup lang="ts">
// Telnet 连接弹窗（P2-3）：Host/Port/退格键/回车键 + 两种可选自动登录：
// - 声明式（NyaTerm 对齐 P0-1）：提示正则 + 用户名/密码 + 成功/失败正则 +
//   重试次数，空白正则由 sidecar 落到内置默认提示词表；
// - Expect 规则（进阶）：与 SSH 触发器同款 tssh Expect* / JSON 语法 +
//   两个密文槽。两种形态互斥，声明式启用时忽略规则区（sidecar 仍会拒绝）。
// 提交时整体交给 sidecar 校验（telnet/start 返回错误即回显）。
// 纯 UI：不做连接编排，App.vue 持有会话状态。
import { reactive, ref, watch } from "vue";
import { TriangleAlert, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Switch } from "./ui/switch";

export interface TelnetDeclarativeLogin {
  username?: string;
  password?: string;
  usernamePromptRegex?: string;
  passwordPromptRegex?: string;
  successRegex?: string;
  failureRegex?: string;
  maxRetries?: number;
}

export interface TelnetConnectOptions {
  host: string;
  port: number;
  enterMode: "crlf" | "cr" | "lf";
  backspaceMode: "del" | "ctrl_h";
  rules?: string;
  secret1?: string;
  secret2?: string;
  declarative?: TelnetDeclarativeLogin;
}

interface Props {
  locale: string;
  open: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{ "update:open": [boolean]; connect: [TelnetConnectOptions] }>();

const t = (key: string, values: Record<string, string | number> = {}) =>
  workbenchMessage(props.locale, key, values);

const form = reactive({
  host: "",
  port: "23",
  enterMode: "crlf" as TelnetConnectOptions["enterMode"],
  backspaceMode: "del" as TelnetConnectOptions["backspaceMode"],
  rules: "",
  secret1: "",
  secret2: "",
});
// 声明式自动登录：enabled 为提交开关；正则留空 = 用 sidecar 内置默认。
const decl = reactive({
  enabled: false,
  username: "",
  usernamePromptRegex: "",
  password: "",
  passwordPromptRegex: "",
  successRegex: "",
  failureRegex: "",
  retries: "0",
});
const hostError = ref(false);
const declError = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      hostError.value = false;
      declError.value = false;
    }
  },
);

/** 声明式表单 → start 载荷；未启用返回 null，凭据缺失置错误并返回 null。 */
function buildDeclarative(): TelnetDeclarativeLogin | null {
  if (!decl.enabled) return null;
  const username = decl.username.trim();
  if (!username && !decl.password) {
    declError.value = true;
    return null;
  }
  declError.value = false;
  const value: TelnetDeclarativeLogin = {};
  if (username) value.username = username;
  if (decl.password) value.password = decl.password;
  const usernamePrompt = decl.usernamePromptRegex.trim();
  if (usernamePrompt) value.usernamePromptRegex = usernamePrompt;
  const passwordPrompt = decl.passwordPromptRegex.trim();
  if (passwordPrompt) value.passwordPromptRegex = passwordPrompt;
  const success = decl.successRegex.trim();
  if (success) value.successRegex = success;
  const failure = decl.failureRegex.trim();
  if (failure) value.failureRegex = failure;
  const retries = Number.parseInt(decl.retries, 10);
  // 与 sidecar 的 0..=10 上限一致；非法输入视为 0（不重试）。
  if (Number.isInteger(retries) && retries > 0) value.maxRetries = Math.min(retries, 10);
  return value;
}

function submit() {
  const host = form.host.trim();
  if (!host) {
    hostError.value = true;
    return;
  }
  const declarative = buildDeclarative();
  if (decl.enabled && !declarative) return;
  const port = Number.parseInt(form.port, 10);
  emit("update:open", false);
  emit("connect", {
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 23,
    enterMode: form.enterMode,
    backspaceMode: form.backspaceMode,
    // 两种形态互斥：声明式优先；规则区的密文槽只在规则形态下随请求下发
    //（sidecar 将空串视为功能关闭，语义等价）。
    ...(declarative
      ? { declarative }
      : form.rules.trim()
        ? { rules: form.rules }
        : {}),
    ...(!declarative && form.secret1 ? { secret1: form.secret1 } : {}),
    ...(!declarative && form.secret2 ? { secret2: form.secret2 } : {}),
  });
  form.secret1 = "";
  form.secret2 = "";
  decl.password = "";
}
</script>

<template>
  <Dialog :open="open" @update:open="(open) => emit('update:open', open)">
    <DialogContent class="modal small-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("telnet.dialogTitle") }}</DialogTitle>
        <button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <p class="muted telnet-security-note"><TriangleAlert class="h-3.5 w-3.5" />{{ t("telnet.security") }}</p>
      <div class="telnet-form-grid">
        <label class="settings-field">
          <span>{{ t("telnet.host") }}</span>
          <input v-model="form.host" class="mono" :placeholder="t('telnet.hostPlaceholder')" spellcheck="false" :aria-invalid="hostError" @keydown.enter="submit" @input="hostError = false" />
        </label>
        <label class="settings-field">
          <span>{{ t("telnet.port") }}</span>
          <input v-model="form.port" class="mono" inputmode="numeric" spellcheck="false" @keydown.enter="submit" />
        </label>
        <label class="settings-field">
          <span>{{ t("telnet.backspaceMode") }}</span>
          <select v-model="form.backspaceMode">
            <option value="del">{{ t("telnet.backspaceMode.del") }}</option>
            <option value="ctrl_h">{{ t("telnet.backspaceMode.ctrlH") }}</option>
          </select>
        </label>
        <label class="settings-field">
          <span>{{ t("telnet.enterMode") }}</span>
          <select v-model="form.enterMode">
            <option value="crlf">{{ t("telnet.enterMode.crlf") }}</option>
            <option value="cr">{{ t("telnet.enterMode.cr") }}</option>
            <option value="lf">{{ t("telnet.enterMode.lf") }}</option>
          </select>
        </label>
      </div>
      <details class="telnet-auto-login">
        <summary class="muted">{{ t("telnet.declTitle") }}</summary>
        <p class="muted settings-note">{{ t("telnet.declHint") }}</p>
        <div class="telnet-decl-switch">
          <Switch id="telnet-decl-enable" size="sm" :model-value="decl.enabled" @update:model-value="(v: unknown) => { decl.enabled = v === true; declError = false; }" />
          <label for="telnet-decl-enable">{{ t("telnet.declEnable") }}</label>
        </div>
        <template v-if="decl.enabled">
          <div class="telnet-form-grid">
            <label class="settings-field">
              <span>{{ t("telnet.declUsername") }}</span>
              <input v-model="decl.username" class="mono" autocomplete="off" spellcheck="false" :aria-invalid="declError" @input="declError = false" />
            </label>
            <label class="settings-field">
              <span>{{ t("telnet.declPassword") }}</span>
              <input v-model="decl.password" type="password" autocomplete="off" spellcheck="false" :aria-invalid="declError" @input="declError = false" />
            </label>
            <label class="settings-field">
              <span>{{ t("telnet.declUsernamePrompt") }}</span>
              <input v-model="decl.usernamePromptRegex" class="mono" spellcheck="false" :placeholder="t('telnet.declRegexDefault')" />
            </label>
            <label class="settings-field">
              <span>{{ t("telnet.declPasswordPrompt") }}</span>
              <input v-model="decl.passwordPromptRegex" class="mono" spellcheck="false" :placeholder="t('telnet.declRegexDefault')" />
            </label>
            <label class="settings-field">
              <span>{{ t("telnet.declSuccess") }}</span>
              <input v-model="decl.successRegex" class="mono" spellcheck="false" :placeholder="t('telnet.declRegexDefault')" />
            </label>
            <label class="settings-field">
              <span>{{ t("telnet.declFailure") }}</span>
              <input v-model="decl.failureRegex" class="mono" spellcheck="false" :placeholder="t('telnet.declRegexDefault')" />
            </label>
            <label class="settings-field">
              <span>{{ t("telnet.declRetries") }}</span>
              <input v-model="decl.retries" class="mono" inputmode="numeric" spellcheck="false" />
            </label>
          </div>
          <p v-if="declError" class="muted telnet-decl-error">{{ t("telnet.declNeedsCredentials") }}</p>
        </template>
      </details>
      <details class="telnet-auto-login">
        <summary class="muted">{{ t("telnet.autoLogin") }}</summary>
        <p class="muted settings-note">{{ decl.enabled ? t("telnet.declExclusiveHint") : t("telnet.autoLoginHint") }}</p>
        <textarea v-model="form.rules" class="mono telnet-rules-input" rows="4" :placeholder="t('telnet.rulesPlaceholder')" spellcheck="false" :disabled="decl.enabled"></textarea>
        <div class="telnet-form-grid">
          <label class="settings-field">
            <span>{{ t("telnet.secret1") }}</span>
            <input v-model="form.secret1" type="password" autocomplete="off" spellcheck="false" :disabled="decl.enabled" />
          </label>
          <label class="settings-field">
            <span>{{ t("telnet.secret2") }}</span>
            <input v-model="form.secret2" type="password" autocomplete="off" spellcheck="false" :disabled="decl.enabled" />
          </label>
        </div>
      </details>
      <footer>
        <button @click="emit('update:open', false)">{{ t("cancel") }}</button>
        <button class="primary-button" @click="submit">{{ t("telnet.connect") }}</button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.telnet-security-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.5;
}
.telnet-security-note svg {
  flex: 0 0 14px;
  margin-top: 1px;
  color: var(--warning, #b45309);
}
.telnet-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
  margin-bottom: 8px;
}
.telnet-form-grid select {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
}
.telnet-auto-login summary {
  cursor: pointer;
  font-size: 11px;
  user-select: none;
}
.telnet-auto-login[open] summary {
  margin-bottom: 6px;
}
.telnet-rules-input {
  width: 100%;
  margin-bottom: 8px;
  resize: vertical;
  font-size: 11px;
  line-height: 1.5;
}
.telnet-decl-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
}
.telnet-decl-error {
  margin: 0;
  font-size: 11px;
  color: var(--warning, #b45309);
}
</style>
