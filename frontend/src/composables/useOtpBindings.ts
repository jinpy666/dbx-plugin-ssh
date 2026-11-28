import { reactive, type Ref } from "vue";
import type { OtpEntryView } from "../lib/otpPanel";

/** OTP 连接绑定管理（自 OtpPanel 纯搬移）：每条目的内联绑定向导状态
 * （下拉选已有连接 / 手填连接 id）与 bind/unbind RPC。绑定表由调用方持有
 * （列表刷新与删除条目都要动它）。 */
export function useOtpBindings(options: {
  bindings: Ref<Record<string, string>>;
  showActionError: (cause: unknown) => void;
}) {
  const { bindings, showActionError } = options;

  const bindOpen = reactive<Record<string, boolean>>({});
  const bindPick = reactive<Record<string, string>>({});
  const bindManual = reactive<Record<string, string>>({});

  async function bindEntry(entry: OtpEntryView) {
    const connectionId = (bindPick[entry.id] || bindManual[entry.id] || "").trim();
    if (!connectionId) return;
    try {
      await window.dbxPlugin.invoke("otp/bind", { connectionId, entryId: entry.id });
      bindings.value = { ...bindings.value, [connectionId]: entry.id };
      bindPick[entry.id] = "";
      bindManual[entry.id] = "";
    } catch (cause) {
      showActionError(cause);
    }
  }

  async function unbindConnection(connectionId: string) {
    try {
      const payload = await window.dbxPlugin.invoke<{ removed: boolean }>("otp/unbind", { connectionId });
      if (payload?.removed) {
        const nextBindings = { ...bindings.value };
        delete nextBindings[connectionId];
        bindings.value = nextBindings;
      }
    } catch (cause) {
      showActionError(cause);
    }
  }

  /** 删除条目时清理该条目的绑定（遍历全表，会被多条连接指向）。 */
  function dropBindingsFor(entryId: string) {
    const next = { ...bindings.value };
    let changed = false;
    for (const [connectionId, boundId] of Object.entries(next)) {
      if (boundId === entryId) {
        delete next[connectionId];
        changed = true;
      }
    }
    if (changed) bindings.value = next;
  }

  return { bindOpen, bindPick, bindManual, bindEntry, unbindConnection, dropBindingsFor };
}
