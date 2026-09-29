import { ref, type Ref } from "vue";

/** 连接信息面板数据源（只读）：echo 往返延迟探测（复用 ssh/exec，无需新增
 * 后端方法）与认证方式只读名称（ssh/sessions/list，顺带同步生效只读门禁）。
 * 面板开关（toggleConnectionInfo）与 metrics 补拉编排仍在 App.vue。 */
export function useConnectionInfo(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  session: Ref<{ sessionId?: string } | undefined>;
  connectionReadOnly: Ref<boolean>;
}) {
  const { t, session, connectionReadOnly } = options;

// 探测结果的最小结构（App.vue 的 ExecResult 为局部接口）。
type ConnectionProbeResult = { output: string; exitCode: number };

// 连接信息面板（只读摘要 + echo 往返延迟）。
const connectionInfoOpen = ref(false);
const connectionLatency = ref<number | null>(null);
const connectionLatencyBusy = ref(false);
const connectionLatencyFailed = ref(false);
// 认证方式只读名称（来自 ssh/sessions/list 的 authMethod；仅方法名，无凭据）。
const connectionAuthMethod = ref("");

async function refreshConnectionAuthMethod() {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  try {
    const result = await window.dbxPlugin.invoke<{ sessions: Array<{ sessionId?: string; authMethod?: string; readOnly?: boolean }> }>(
      "ssh/sessions/list",
      {},
      { timeoutMs: 15_000 },
    );
    const mine = result.sessions?.find((row) => row.sessionId === sessionId);
    connectionAuthMethod.value = typeof mine?.authMethod === "string" && mine.authMethod ? mine.authMethod : "";
    connectionReadOnly.value = mine?.readOnly === true;
  } catch {
    connectionAuthMethod.value = "";
  }
}

// 延迟测量：复用既有 ssh/exec 跑一条 echo 只读命令，计时整个 RPC 往返
// （含通道建立），无需新增后端方法。测量值仅用于展示，不参与任何逻辑。
async function measureLatency() {
  const sessionId = session.value?.sessionId;
  if (!sessionId || connectionLatencyBusy.value) return;
  connectionLatencyBusy.value = true;
  connectionLatencyFailed.value = false;
  const startedAt = performance.now();
  try {
    const result = await window.dbxPlugin.invoke<ConnectionProbeResult>("ssh/exec", {
      sessionId,
      command: "echo dbx-rtt-probe",
      timeoutSecs: 8,
    }, { timeoutMs: 15_000 });
    if (!result.output.includes("dbx-rtt-probe")) throw new Error(t("errors.probeOutput"));
    connectionLatency.value = performance.now() - startedAt;
  } catch {
    connectionLatency.value = null;
    connectionLatencyFailed.value = true;
  } finally {
    connectionLatencyBusy.value = false;
  }
}


  return {
    connectionInfoOpen,
    connectionLatency,
    connectionLatencyBusy,
    connectionLatencyFailed,
    connectionAuthMethod,
    refreshConnectionAuthMethod,
    measureLatency,
  };
}
