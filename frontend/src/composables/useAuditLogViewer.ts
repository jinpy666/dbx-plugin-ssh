import { computed, ref, type Ref } from "vue";
import { sanitizeAuditEntries, type AuditEntry } from "../lib/auditLog";

/** 审计日志查看（IMPL_PLAN_NETCATTY_PARITY §3-B4）：独立工具栏入口，
 * 只读最近 200 条；打开/过滤变化/刷新时拉取，失败静默空态。 */
export function useAuditLogViewer(options: { locale: Ref<string>; auditOpen: Ref<boolean> }) {
  const { locale, auditOpen } = options;
  const auditEntries = ref<AuditEntry[]>([]);
  const auditLoading = ref(false);
  const auditLoadFailed = ref(false);
  const auditTruncated = ref(false);
  const auditKindFilter = ref("");

  async function loadAuditEntries() {
    auditLoading.value = true;
    try {
      // kind 过滤在客户端做（sanitizeAuditEntries 统一 newest-first；后端可能
      // 不认 `kind` 参数，见 lib/auditLog.ts 双形状容忍说明）。
      const result = await window.dbxPlugin.invoke<{ entries: unknown; truncated?: boolean }>("ssh/audit/list", { limit: 200 });
      auditEntries.value = sanitizeAuditEntries(result.entries, 200);
      auditTruncated.value = result.truncated === true;
      auditLoadFailed.value = false;
    } catch {
      // 失败不打断设置弹窗（§3-B4-T1），但与"确无记录"区分开：显示加载失败
      // 提示 + 重试入口（与其他设置 section 的 error+refresh 一致）。
      auditEntries.value = [];
      auditTruncated.value = false;
      auditLoadFailed.value = true;
    } finally {
      auditLoading.value = false;
    }
  }

  function openAuditLog() {
    auditOpen.value = true;
    auditKindFilter.value = "";
    void loadAuditEntries();
  }

  const visibleAuditEntries = computed(() => {
    if (!auditKindFilter.value) return auditEntries.value;
    return auditEntries.value.filter((entry) => entry.kind === auditKindFilter.value);
  });

  // 应用内弹窗确认：宿主沙箱 iframe 无 allow-modals，window.confirm 恒 false
  const auditClearOpen = ref(false);
  const auditClearSubmitting = ref(false);
  async function confirmAuditClear() {
    auditClearSubmitting.value = true;
    try {
      await window.dbxPlugin.invoke("ssh/audit/clear", {});
      auditClearOpen.value = false;
    } catch {
      // 清空失败静默：保留现列表，用户可再次尝试或刷新。
    } finally {
      auditClearSubmitting.value = false;
    }
    await loadAuditEntries();
  }

  function auditTime(ts: number) {
    if (!ts) return "";
    return new Intl.DateTimeFormat(locale.value, { dateStyle: "short", timeStyle: "medium" }).format(new Date(ts * 1000));
  }

  function auditRowKindClass(kind: string) {
    return `k-${kind.replace(/\./g, "-")}`;
  }

  return {
    auditEntries,
    auditLoading,
    auditLoadFailed,
    auditTruncated,
    auditKindFilter,
    loadAuditEntries,
    openAuditLog,
    visibleAuditEntries,
    auditClearOpen,
    auditClearSubmitting,
    confirmAuditClear,
    auditTime,
    auditRowKindClass,
  };
}
