<script setup lang="ts">
import { Check, ChevronDown, ChevronUp, Server, SquareTerminal } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import type { ConnectLogEntry } from "../lib/connectLog";

export type ConnectCardState = "connecting" | "error" | "cancelled" | "success";

interface Props {
  locale: string;
  /** Connection display name (falls back to the identity when unnamed). */
  name: string;
  /** `user@host:port` identity line. */
  identity: string;
  state: ConnectCardState;
  /** Friendly error line for the error state (raw detail stays on `errorDetail`). */
  errorText?: string;
  /** Raw error text, surfaced as the tooltip of the friendly line. */
  errorDetail?: string;
  logsOpen: boolean;
  /** Newest-first connect-attempt log entries. */
  logs: ConnectLogEntry[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  cancel: [];
  reconnect: [];
  connect: [];
  toggleLogs: [];
}>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

function formatLogTime(ts: number) {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
</script>

<template>
  <div class="connect-card" :data-state="state" role="status">
    <header class="connect-card-header">
      <span class="connect-card-badge" aria-hidden="true"><Server /></span>
      <div class="connect-card-heading">
        <strong class="connect-card-name" :title="name">{{ name }}</strong>
        <span class="connect-card-identity" :title="identity">SSH {{ identity }}</span>
      </div>
      <button type="button" class="connect-card-logs-toggle" :aria-expanded="logsOpen" @click="emit('toggleLogs')">
        {{ logsOpen ? t("connectCard.hideLogs") : t("connectCard.showLogs") }}
        <ChevronUp v-if="logsOpen" />
        <ChevronDown v-else />
      </button>
    </header>
    <div class="connect-card-track" aria-hidden="true">
      <span class="connect-card-endpoint connect-card-endpoint-server">
        <svg class="connect-card-arc" viewBox="0 0 36 36"><circle class="connect-card-arc-track" cx="18" cy="18" r="16" /><circle class="connect-card-arc-spin" cx="18" cy="18" r="16" /></svg>
        <Server />
      </span>
      <span class="connect-card-line"><span class="connect-card-flow" /><span class="connect-card-fill" /></span>
      <span class="connect-card-endpoint connect-card-endpoint-target"><Check v-if="state === 'success'" /><SquareTerminal v-else /></span>
    </div>
    <footer class="connect-card-footer">
      <template v-if="state === 'connecting'">
        <span class="connect-card-status">{{ t("connecting") }}</span>
        <button type="button" class="connect-card-ghost-button" @click="emit('cancel')">{{ t("connectCard.cancel") }}</button>
      </template>
      <template v-else-if="state === 'cancelled'">
        <span class="connect-card-status">{{ t("connectCard.cancelled") }}</span>
        <button type="button" class="primary-button" @click="emit('connect')">{{ t("connectCard.connect") }}</button>
      </template>
      <template v-else-if="state === 'success'">
        <span class="connect-card-status connect-card-success-status">{{ t("connectCard.success") }}</span>
      </template>
      <template v-else>
        <span class="connect-card-error" :title="errorDetail || undefined">{{ errorText }}</span>
        <button type="button" class="primary-button" @click="emit('reconnect')">{{ t("reconnect") }}</button>
      </template>
    </footer>
    <div v-if="logsOpen" class="connect-card-logs">
      <p v-if="!logs.length" class="connect-card-logs-empty">{{ t("connectCard.logsEmpty") }}</p>
      <div v-for="(entry, index) in logs" :key="`${entry.ts}-${index}`" class="connect-card-log-row" :data-level="entry.level">
        <span class="connect-card-log-ts">{{ formatLogTime(entry.ts) }}</span>
        <span class="connect-card-log-message">{{ entry.message }}</span>
      </div>
    </div>
  </div>
</template>
