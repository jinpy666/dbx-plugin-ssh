<script setup lang="ts">
// OTP 侧栏面板（IMPL_PLAN P2-1）：条目列表（TOTP 验证码 + 周期倒计时进度条 /
// HOTP 手动生成）、新增与编辑对话框（密钥遮蔽可切换）、删除确认、扫码导入
// （File API 读图 → otp/import-qr → 预填编辑框）、连接绑定管理（host.listConnections
// 下拉，宿主不支持时回退手输 connectionId）、把当前验证码写入终端输入行
// （不经 App.vue：自带 sequenced-input 队列走 ssh/terminal/in/<sessionId>，不回车）。
// 纯逻辑（协议解析 / 倒计时 / 草稿映射）在 lib/otpPanel.ts。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Check, Copy, Link2, Loader2, Pencil, Plus, QrCode, RefreshCw, Send, Trash2, Unlink, X } from "@lucide/vue";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import OtpEditorDialog from "./OtpEditorDialog.vue";
import { useOtpCodes } from "../composables/useOtpCodes";
import { useOtpBindings } from "../composables/useOtpBindings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { writeClipboardText } from "../lib/clipboardBridge";
import { normalizeConnectionText } from "../lib/connectionInfo";
import { resolveWorkbenchId } from "../lib/pluginContext";
import { createTerminalInputQueue } from "../lib/terminalInputQueue";
import { normalizeTerminalInputBytes } from "../lib/terminalInput";
import {
  boundConnectionsOf,
  bytesToBase64,
  countdownPercent,
  emptyOtpDraft,
  entryLabel,
  entryToDraft,
  formatCountdown,
  otpDraftError,
  otpSaveParams,
  parseGenerateResponse,
  parseOtpBindings,
  parseOtpEntries,
  pickSendTargetSession,
  qrResponseToDraft,
  tickCountdown,
  type OtpCodeState,
  type OtpDraft,
  type OtpEntryView,
} from "../lib/otpPanel";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

interface HostConnection {
  id: string;
  name: string;
}

const loading = ref(true);
const entries = ref<OtpEntryView[]>([]);
const bindings = ref<Record<string, string>>({});
const connections = ref<HostConnection[]>([]);
const connectionsUnavailable = ref(false);
const connectionName = computed(() => {
  const names = new Map<string, string>();
  for (const connection of connections.value) names.set(connection.id, connection.name || connection.id);
  return (id: string) => names.get(id) ?? id;
});

function showActionError(cause: unknown) {
  actionError.value = cause instanceof Error ? cause.message : String(cause);
  window.setTimeout(() => {
    if (actionError.value === (cause instanceof Error ? cause.message : String(cause))) actionError.value = "";
  }, 6000);
}

/** 条目 id → 当前验证码状态（TOTP 倒计时 / HOTP 最近一次生成）。
 *  码引擎（取码/批量/倒计时/退避）下沉 useOtpCodes。 */
const { codes, generating, generateFor, generateAllTotp, tick, forget: forgetCode } = useOtpCodes({
  entries,
  showActionError: (cause) => showActionError(cause),
});

// 验证码遮蔽用的占位（无码时展示，避免布局抖动）。
const CODE_PLACEHOLDER = "······";

// ---------------------------------------------------------------------------
// 数据加载（码生成/倒计时/退避在 useOtpCodes）
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    const payload = await window.dbxPlugin.invoke("otp/list");
    entries.value = parseOtpEntries(payload);
    bindings.value = parseOtpBindings(payload);
  } catch (cause) {
    showActionError(cause);
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------------------
// 复制 / 发送到终端
// ---------------------------------------------------------------------------

async function copyCode(entry: OtpEntryView) {
  const state = codes[entry.id];
  if (!state?.code) return;
  try {
    await writeClipboardText(state.code);
    copiedId.value = entry.id;
    window.setTimeout(() => {
      if (copiedId.value === entry.id) copiedId.value = "";
    }, 1500);
  } catch (cause) {
    showActionError(cause);
  }
}

// 与 App.vue 的键盘通路同协议：8 字节 BE 序号 + 输入字节，经 sendBinary 写入
// ssh/terminal/in/<sessionId>。面板自持队列实例（后端只用序号回 ack，不做
// 顺序裁决），写入不带换行，shell 输入行停在原地。
const inputQueue = createTerminalInputQueue({
  send: (sessionId, payload) => window.dbxPlugin.sendBinary(`ssh/terminal/in/${sessionId}`, payload),
});

async function resolveSendTargetSessionId(): Promise<string> {
  const api = window.dbxPlugin;
  const context = api.context ?? (await api.request<Record<string, unknown>>("host.getContext").catch(() => undefined));
  const connectionId = normalizeConnectionText(context?.connectionId);
  const workbenchId = resolveWorkbenchId(context, "");
  const result = await api.invoke<{ sessions?: unknown }>("ssh/sessions/list", {}, { timeoutMs: 10_000 });
  return pickSendTargetSession(result?.sessions, connectionId, workbenchId);
}

async function sendCode(entry: OtpEntryView) {
  const state = codes[entry.id];
  if (!state?.code) return;
  try {
    const sessionId = await resolveSendTargetSessionId();
    if (!sessionId) {
      actionError.value = props.t("otpPanel.send.noSession");
      return;
    }
    inputQueue.enqueue(sessionId, normalizeTerminalInputBytes(new TextEncoder().encode(state.code)));
    sentId.value = entry.id;
    window.setTimeout(() => {
      if (sentId.value === entry.id) sentId.value = "";
    }, 1500);
  } catch (cause) {
    showActionError(cause);
  }
}
const copiedId = ref("");
const sentId = ref("");
const actionError = ref("");
const saving = ref(false);
const deleteTarget = ref<OtpEntryView | null>(null);
// 绑定向导状态与 bind/unbind 下沉 useOtpBindings。
const { bindOpen, bindPick, bindManual, bindEntry, unbindConnection, dropBindingsFor } = useOtpBindings({
  bindings,
  showActionError: (cause) => showActionError(cause),
});

const qrInput = ref<HTMLInputElement | null>(null);
const qrBusy = ref(false);

let tickTimer = 0;

// 条目编辑弹窗（草稿/校验/保存）下沉 OtpEditorDialog：父层经 ref 打开，
// 保存成功后落位 entries 并按类型取码。
const editorDialog = ref<InstanceType<typeof OtpEditorDialog>>();

function onOtpSaved(saved: OtpEntryView) {
  const existing = entries.value.findIndex((entry) => entry.id === saved.id);
  if (existing >= 0) entries.value.splice(existing, 1, saved);
  else entries.value.push(saved);
  if (saved.otpType === "totp") void generateFor(saved);
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  try {
    const payload = await window.dbxPlugin.invoke<{ deleted: boolean }>("otp/delete", { id: target.id });
    if (payload?.deleted) {
      entries.value = entries.value.filter((entry) => entry.id !== target.id);
      forgetCode(target.id);
      dropBindingsFor(target.id);
    }
    deleteTarget.value = null;
  } catch (cause) {
    deleteTarget.value = null;
    showActionError(cause);
  }
}

async function importQrImage(file: File) {
  qrBusy.value = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const payload = await window.dbxPlugin.invoke("otp/import-qr", { imageBase64: bytesToBase64(bytes) });
    const draft = qrResponseToDraft(payload);
    if (!draft) {
      showActionError(new Error("otp/import-qr returned no secret"));
      return;
    }
    editorDialog.value?.openWithDraft(draft);
  } catch (cause) {
    showActionError(cause);
  } finally {
    qrBusy.value = false;
    if (qrInput.value) qrInput.value.value = "";
  }
}

function onQrFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void importQrImage(file);
}

// ---------------------------------------------------------------------------
// 连接绑定
// ---------------------------------------------------------------------------

async function loadConnections() {
  try {
    const payload = await window.dbxPlugin.request<{ connections?: Array<{ id?: unknown; name?: unknown }> }>("host.listConnections");
    connections.value = (payload?.connections ?? [])
      .map((connection) => ({ id: typeof connection.id === "string" ? connection.id : "", name: typeof connection.name === "string" ? connection.name : "" }))
      .filter((connection) => connection.id);
  } catch {
    // 老宿主没有 listConnections 扩展点：绑定降级为手输 connectionId。
    connectionsUnavailable.value = true;
  }
}


// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(() => {
  void refresh().then(() => generateAllTotp());
  void loadConnections();
  tickTimer = window.setInterval(tick, 1000);
});

onBeforeUnmount(() => {
  if (tickTimer) window.clearInterval(tickTimer);
  tickTimer = 0;
});
</script>

<template>
  <div class="otp-panel">
    <div class="otp-toolbar">
      <button type="button" class="otp-add" @click="editorDialog?.openCreate()"><Plus />{{ t("otpPanel.add") }}</button>
      <button type="button" class="icon-button" :title="t('otpPanel.scanQr')" :aria-label="t('otpPanel.scanQr')" :disabled="qrBusy" @click="qrInput?.click()">
        <Loader2 v-if="qrBusy" class="spinning" /><QrCode v-else />
      </button>
      <button type="button" class="icon-button" :title="t('otpPanel.refresh')" :aria-label="t('otpPanel.refresh')" :disabled="loading" @click="() => { void refresh().then(() => generateAllTotp()); }">
        <RefreshCw />
      </button>
      <input ref="qrInput" type="file" accept="image/*" class="otp-file-input" @change="onQrFileChange" />
    </div>

    <p v-if="loading" class="otp-empty"><Loader2 class="spinning" />{{ t("otpPanel.loading") }}</p>
    <p v-else-if="!entries.length" class="otp-empty">{{ t("otpPanel.empty") }}</p>
    <ul v-else class="otp-list">
      <li v-for="entry in entries" :key="entry.id" class="otp-entry">
        <div class="otp-entry-head">
          <span class="otp-issuer" :title="entry.issuer">{{ entryLabel(entry) }}</span>
          <span class="otp-badge" :class="`otp-badge--${entry.otpType}`">{{ entry.otpType === "hotp" ? t("otpPanel.hotp") : t("otpPanel.totp") }}</span>
        </div>
        <div v-if="entry.username" class="otp-username">{{ entry.username }}</div>

        <template v-if="entry.otpType === 'totp'">
          <div class="otp-code-row">
            <span class="otp-code" :class="{ 'is-used': codes[entry.id]?.reused }">{{ codes[entry.id]?.code || CODE_PLACEHOLDER }}</span>
            <span class="otp-count" :title="t('otpPanel.countdown')">{{ formatCountdown(codes[entry.id]?.remaining ?? 0) }}</span>
          </div>
          <div class="otp-progress" role="presentation">
            <span class="otp-progress-fill" :style="{ width: `${countdownPercent(codes[entry.id]?.remaining ?? 0, entry.period)}%` }" />
          </div>
          <p v-if="codes[entry.id]?.reused" class="otp-reused">{{ t("otpPanel.reused", { seconds: codes[entry.id]?.remaining ?? 0 }) }}</p>
        </template>
        <template v-else>
          <div class="otp-code-row">
            <span class="otp-code">{{ codes[entry.id]?.code || CODE_PLACEHOLDER }}</span>
            <button type="button" class="otp-generate" :disabled="generating.has(entry.id)" @click="() => void generateFor(entry)">
              <Loader2 v-if="generating.has(entry.id)" class="spinning" />{{ t("otpPanel.generate") }}
            </button>
          </div>
        </template>

        <div class="otp-actions">
          <button type="button" class="icon-button" :title="copiedId === entry.id ? t('otpPanel.copied') : t('otpPanel.copy')" :aria-label="copiedId === entry.id ? t('otpPanel.copied') : t('otpPanel.copy')" :disabled="!codes[entry.id]?.code" @click="() => void copyCode(entry)">
            <Check v-if="copiedId === entry.id" /><Copy v-else />
          </button>
          <button type="button" class="icon-button" :title="sentId === entry.id ? t('otpPanel.sent') : t('otpPanel.send')" :aria-label="sentId === entry.id ? t('otpPanel.sent') : t('otpPanel.send')" :disabled="!codes[entry.id]?.code" @click="() => void sendCode(entry)">
            <Send />
          </button>
          <button type="button" class="icon-button" :title="t('otpPanel.bind')" :aria-label="t('otpPanel.bind')" @click="bindOpen[entry.id] = !bindOpen[entry.id]">
            <Link2 />
          </button>
          <span class="otp-actions-spacer" />
          <button type="button" class="icon-button" :title="t('otpPanel.edit')" :aria-label="t('otpPanel.edit')" @click="editorDialog?.openEdit(entry)"><Pencil /></button>
          <button type="button" class="icon-button" :title="t('otpPanel.delete')" :aria-label="t('otpPanel.delete')" @click="deleteTarget = entry"><Trash2 /></button>
        </div>

        <div v-if="bindOpen[entry.id]" class="otp-bind">
          <p v-if="!boundConnectionsOf(bindings, entry.id).length" class="otp-bind-none">{{ t("otpPanel.bindNone") }}</p>
          <div v-for="connectionId in boundConnectionsOf(bindings, entry.id)" :key="connectionId" class="otp-bind-row">
            <span class="otp-bind-target" :title="connectionId">{{ connectionName(connectionId) }}</span>
            <button type="button" class="icon-button" :title="t('otpPanel.unbind')" :aria-label="t('otpPanel.unbind')" @click="() => void unbindConnection(connectionId)"><Unlink /></button>
          </div>
          <div v-if="connections.length" class="otp-bind-pick">
            <Select :model-value="bindPick[entry.id] || undefined" @update:model-value="(value) => { bindPick[entry.id] = typeof value === 'string' ? value : ''; }">
              <SelectTrigger size="xs" class="otp-bind-select"><SelectValue :placeholder="t('otpPanel.bindPick')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.name || connection.id }}</SelectItem>
              </SelectContent>
            </Select>
            <button type="button" class="otp-bind-apply" :disabled="!bindPick[entry.id]" @click="() => void bindEntry(entry)">{{ t("otpPanel.bindApply") }}</button>
          </div>
          <p v-else class="otp-bind-hint">{{ t("otpPanel.bindManualHint") }}</p>
          <input
            v-if="!connections.length"
            v-model="bindManual[entry.id]"
            class="otp-bind-manual"
            :placeholder="t('otpPanel.bindManual')"
            spellcheck="false"
            @keydown.enter="() => void bindEntry(entry)"
          />
        </div>
      </li>
    </ul>

    <p v-if="actionError" class="otp-error">{{ actionError }}</p>

    <OtpEditorDialog ref="editorDialog" :t="t" @saved="onOtpSaved" />

    <Dialog :open="deleteTarget !== null" @update:open="(open) => { if (!open) deleteTarget = null; }">
      <DialogContent class="modal otp-delete-modal" @escape-key-down.prevent>
        <header><DialogTitle>{{ t("otpPanel.deleteConfirm.title") }}</DialogTitle></header>
        <p class="otp-delete-message">{{ t("otpPanel.deleteConfirm.message", { label: deleteTarget ? entryLabel(deleteTarget) : "" }) }}</p>
        <footer>
          <button type="button" class="otp-cancel" @click="deleteTarget = null">{{ t("otpPanel.deleteConfirm.cancel") }}</button>
          <button type="button" class="danger-button" @click="() => void confirmDelete()"><Trash2 />{{ t("otpPanel.deleteConfirm.confirm") }}</button>
        </footer>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.otp-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
}
.otp-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.otp-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 3px 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.otp-add:hover { background: var(--accent); }
.otp-add svg, .icon-button svg { width: 14px; height: 14px; }
.otp-file-input { display: none; }
.otp-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 4px;
  color: var(--muted-foreground);
  font-size: 12px;
}
.otp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.otp-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px;
}
.otp-entry-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.otp-issuer {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}
.otp-badge {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10px;
  background: var(--accent);
  color: var(--muted-foreground);
}
.otp-badge--hotp { color: var(--primary); }
.otp-username {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-foreground);
  font-size: 11px;
}
.otp-code-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.otp-code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 18px;
  letter-spacing: 2px;
  color: var(--foreground);
}
.otp-code.is-used { color: var(--muted-foreground); }
.otp-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.otp-progress {
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
  overflow: hidden;
}
.otp-progress-fill {
  display: block;
  height: 100%;
  background: var(--primary);
  transition: width 1s linear;
}
.otp-reused {
  margin: 0;
  font-size: 11px;
  color: var(--muted-foreground);
}
.otp-generate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2px 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 11px;
  cursor: pointer;
}
.otp-generate:hover:not(:disabled) { background: var(--accent); }
.otp-generate svg { width: 12px; height: 12px; }
.otp-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.otp-actions-spacer { flex: 1 1 auto; }
.otp-actions .icon-button {
  width: 24px;
  height: 24px;
}
.otp-bind {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px dashed var(--border);
  padding-top: 6px;
}
.otp-bind-none, .otp-bind-hint {
  margin: 0;
  font-size: 11px;
  color: var(--muted-foreground);
}
.otp-bind-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.otp-bind-target {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.otp-bind-pick {
  display: flex;
  align-items: center;
  gap: 6px;
}
.otp-bind-select { flex: 1 1 auto; min-width: 0; }
.otp-bind-apply {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2px 8px;
  background: transparent;
  color: var(--primary);
  font-size: 11px;
  cursor: pointer;
}
.otp-bind-apply:hover:not(:disabled) { background: var(--accent); }
.otp-bind-apply:disabled { opacity: 0.5; cursor: default; }
.otp-bind-manual {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 3px 6px;
  background: transparent;
  color: var(--foreground);
  font-size: 11px;
}
.otp-error {
  margin: 0;
  border: 1px solid color-mix(in srgb, var(--destructive) 60%, var(--border));
  border-radius: var(--radius);
  padding: 4px 8px;
  background: color-mix(in srgb, var(--destructive) 16%, var(--popover));
  color: color-mix(in srgb, var(--destructive) 45%, var(--foreground));
  font-size: 11px;
  word-break: break-word;
}
.otp-delete-modal footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.otp-cancel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 10px;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.otp-cancel:hover { background: var(--accent); }
.otp-delete-message {
  margin: 0;
  font-size: 12px;
  color: var(--muted-foreground);
}
.danger-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--destructive) 60%, var(--border));
  border-radius: var(--radius);
  padding: 4px 10px;
  background: color-mix(in srgb, var(--destructive) 16%, var(--popover));
  color: color-mix(in srgb, var(--destructive) 55%, var(--foreground));
  font-size: 12px;
  cursor: pointer;
}
.danger-button svg { width: 13px; height: 13px; }
</style>
