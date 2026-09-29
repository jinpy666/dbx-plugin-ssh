import { computed, ref, watch, type Ref } from "vue";
import {
  AGENT_MODES,
  agentPromptCommandReadOnly,
  approvalRemainingSecs,
  buildAgentResolveBody,
  clearSessionBoundAgentPrompts,
  dropAgentPrompt,
  type AgentNoticePayload,
  type AgentPromptPayload,
  type AgentTerminalMode,
} from "../lib/agentTerminal";

/** AI 终端同步执行（agent terminal mode）：审批挑战队列 + 执行横幅 + 连接级模式切换。
 * 审批语义对齐 host-key 挑战；ssh/agent/* 事件仅当前会话生效（事件接线仍在 App.vue）。 */
export function useAgentTerminalMode(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  sendTerminalBytes: (data: Uint8Array) => void;
  closeToolbarPopovers: () => void;
}) {
  const { t, showError, session, sendTerminalBytes, closeToolbarPopovers } = options;

// AI 终端同步执行：审批挑战队列 / 执行横幅状态（ssh/agent/* 事件仅当前会话生效）。
// 跨会话并发审批按 challengeId 排队，弹窗一次只渲染队首（后端同会话已串行化）。
const agentPromptQueue = ref<AgentPromptPayload[]>([]);
const agentPromptCommand = ref("");
const agentPromptRemaining = ref(0);
const agentPromptExpired = ref(false);
// 「记住此命令」勾选态：批准时随 resolve 提交，把命令写入连接级免审批清单
// （后端 D2 兜底：破坏性命令自动忽略记住标记）。
const agentPromptRemember = ref(false);
const agentRunning = ref<AgentNoticePayload>();
// 终端 MCP 模式快速开关（工具栏弹出层）：连接级 agentTerminalMode 的就地入口，
// 与设置弹窗共用 ssh/settings/set，值语义见 lib/agentTerminal.ts。
const agentModeOpen = ref(false);
const agentMode = ref<AgentTerminalMode>("off");
const agentModeBusy = ref(false);
let agentPromptTimer = 0;
const agentModeHint = computed(() => t(
  agentMode.value === "auto" ? "agentTerminalAutoHint"
  : agentMode.value === "strict" ? "agentTerminalStrictHint"
  : "agentTerminalOffHint",
));
// 审批队列：弹窗只渲染队首；队首变化（入队到空队列、出队露出下一个）时经 watch
// 重置可编辑命令与 250ms tick 倒计时。倒计时基于队首 requestedAt + timeoutSecs
// 绝对期限，到 0 仅出队队首并标记 expired（后端超时同样拒绝）；排队中已到期的
// 挑战会在露出为队首的首次 tick 即被跳过出队。
const agentPromptHead = computed(() => agentPromptQueue.value[0]);
const agentPromptCommandIsReadOnly = computed(() => agentPromptHead.value ? agentPromptCommandReadOnly(agentPromptHead.value) : false);

watch(agentPromptHead, (head) => {
  stopAgentPromptTimer();
  if (!head) {
    agentPromptCommand.value = "";
    agentPromptRemaining.value = 0;
    return;
  }
  agentPromptCommand.value = head.command;
  agentPromptExpired.value = false;
  agentPromptRemember.value = false;
  const tick = () => {
    const current = agentPromptHead.value;
    if (!current) return;
    agentPromptRemaining.value = approvalRemainingSecs(current, Date.now());
    if (agentPromptRemaining.value <= 0) {
      agentPromptExpired.value = true;
      dismissAgentPrompt();
    }
  };
  tick();
  agentPromptTimer = window.setInterval(tick, 250);
});

function stopAgentPromptTimer() {
  if (agentPromptTimer) {
    window.clearInterval(agentPromptTimer);
    agentPromptTimer = 0;
  }
}

// 出队队首（超时 / 审批后调用）：队列自动露出下一个，watch 重启其倒计时。
function dismissAgentPrompt() {
  const head = agentPromptHead.value;
  if (!head) return;
  agentPromptQueue.value = dropAgentPrompt(agentPromptQueue.value, head.challengeId);
}

// 会话切换 / 关闭只清理 SSH 会话绑定挑战；无 sessionId 的 MCP 审批是进程级
// 交互，必须继续显示，才能被显式允许或拒绝。
function clearAgentPrompts() {
  agentPromptQueue.value = clearSessionBoundAgentPrompts(agentPromptQueue.value);
  if (agentPromptQueue.value.length === 0) {
    stopAgentPromptTimer();
    agentPromptCommand.value = "";
    agentPromptRemaining.value = 0;
  }
}

// 审批语义对齐 host-key 挑战：先出队再 resolve（挑战一次性，重复 resolve 报错）；
// 普通 SSH 命令仍可编辑（所见即所执行），但 MCP Docker 动作保留结构化参数，
// 确认 UI 仅展示、不可改写其规范命令。勾选「记住」时携带 remember 标记。
async function resolveAgentPrompt(decision: "approve" | "deny") {
  const prompt = agentPromptHead.value;
  if (!prompt) return;
  const command = agentPromptCommand.value;
  const remember = agentPromptRemember.value;
  dismissAgentPrompt();
  try {
    const payload = buildAgentResolveBody({ challengeId: prompt.challengeId, decision, command, remember });
    await window.dbxPlugin.invoke("ssh/agent/resolve", payload);
  } catch (cause) {
    showError(cause, "terminal");
  }
}

// 中断 AI 正在终端执行的命令：复用 PTY 输入通道发送 Ctrl+C（0x03，对齐快速命令写入语义）。
function interruptAgentRun() {
  sendTerminalBytes(new Uint8Array([3]));
}
function toggleAgentModeMenu() {
  const next = !agentModeOpen.value;
  closeToolbarPopovers();
  agentModeOpen.value = next;
  if (next) void refreshAgentMode();
}
/// 读取当前连接的 agentTerminalMode（与设置弹窗同一 ssh/settings/get 视图）；
/// 失败保留上次已知值，仅影响按钮态不影响终端。
async function refreshAgentMode() {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return;
  try {
    const meta = await window.dbxPlugin.invoke<{ agentTerminalMode?: string }>("ssh/settings/get", { sessionId });
    const mode = meta.agentTerminalMode;
    agentMode.value = mode && (AGENT_MODES as readonly string[]).includes(mode) ? (mode as AgentTerminalMode) : "off";
  } catch {
    // 静默降级：读不到就保持现状（默认 off），不打断终端使用。
  }
}

/// 切换即生效（ssh/settings/set），成功后本地同步并收起弹出层。
async function applyAgentMode(mode: AgentTerminalMode) {
  const sessionId = session.value?.sessionId;
  if (!sessionId || agentModeBusy.value) return;
  agentModeBusy.value = true;
  try {
    await window.dbxPlugin.invoke("ssh/settings/set", { sessionId, agentTerminalMode: mode });
    agentMode.value = mode;
    agentModeOpen.value = false;
  } catch (cause) {
    showError(cause, "terminal");
  } finally {
    agentModeBusy.value = false;
  }
}

  return {
    agentPromptQueue,
    agentPromptCommand,
    agentPromptRemaining,
    agentPromptExpired,
    agentPromptRemember,
    agentRunning,
    agentModeOpen,
    agentMode,
    agentModeBusy,
    agentModeHint,
    agentPromptHead,
    agentPromptCommandIsReadOnly,
    clearAgentPrompts,
    stopAgentPromptTimer,
    dismissAgentPrompt,
    resolveAgentPrompt,
    interruptAgentRun,
    toggleAgentModeMenu,
    refreshAgentMode,
    applyAgentMode,
  };
}
