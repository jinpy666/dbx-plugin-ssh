import { ref, watch, type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import { sanitizeTriagePayload, type TriageResult } from "../lib/alertTriage";
import { settingsErrorOf } from "../lib/settingsModel";
import { writeClipboardText, type ClipboardDeps } from "../lib/clipboardBridge";

/** 告警排查（IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT §2.4）：粘贴异构告警 → 后端
 * ssh/alert/triage 分诊（结构化 + 分类 + 只读命令清单）；建议命令一键发送到
 * 当前终端（复用 PTY 键盘写入链路），分诊本身不需要活动连接。 */
export function useAlertTriage(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  showNotice: (message: string) => void;
  session: Ref<{ sessionId?: string } | undefined>;
  terminal: () => Terminal | undefined;
  trackPendingInput: (data: string) => void;
  sendTerminalBytes: (data: Uint8Array) => void;
  clipboardDeps: () => ClipboardDeps;
}) {
  const { t, showError, showNotice, session, terminal: terminalGet, trackPendingInput, sendTerminalBytes, clipboardDeps } = options;

const alertTriageOpen = ref(false);
const alertTriageBusy = ref(false);
const alertTriageError = ref("");
const alertTriagePayload = ref("");
const alertTriageResult = ref<TriageResult>();

watch(alertTriagePayload, () => {
  alertTriageResult.value = undefined;
  alertTriageError.value = "";
});

function openAlertTriage() {
  alertTriageOpen.value = true;
  alertTriageError.value = "";
}
async function runAlertTriage() {
  if (alertTriageBusy.value) return;
  const payload = sanitizeTriagePayload(alertTriagePayload.value);
  if (!payload) {
    alertTriageError.value = t("alertTriage.invalidPayload");
    return;
  }
  alertTriageBusy.value = true;
  alertTriageError.value = "";
  alertTriageResult.value = undefined;
  try {
    alertTriageResult.value = await window.dbxPlugin.invoke<TriageResult>("ssh/alert/triage", { payload });
  } catch (cause) {
    alertTriageError.value = t("alertTriageLoadFailed", { error: settingsErrorOf(cause) });
  } finally {
    alertTriageBusy.value = false;
  }
}

function sendSuggestionToTerminal(command: string) {
  if (!session.value) return;
  trackPendingInput(`${command}\r`);
  sendTerminalBytes(new TextEncoder().encode(`${command}\r`));
  terminalGet()?.focus();
}

async function copySuggestions() {
  const result = alertTriageResult.value;
  if (!result?.suggestions?.length) return;
  try {
    await writeClipboardText(result.suggestions.map((item) => item.command).join("\n"), clipboardDeps());
    showNotice(t("terminalCopied"));
  } catch (cause) {
    showError(cause);
  }
}

  return {
    alertTriageOpen,
    alertTriageBusy,
    alertTriageError,
    alertTriagePayload,
    alertTriageResult,
    openAlertTriage,
    runAlertTriage,
    sendSuggestionToTerminal,
    copySuggestions,
  };
}
