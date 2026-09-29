import { ref, type Ref } from "vue";
import { browseCommandHistory, commandInputAction, pushCommandHistory } from "../lib/commandHistory";
import { randomUUID } from "../lib/uuid";

/** 远端命令执行弹窗（ssh/exec，非交互通道）：草稿/ sudo 开关/执行与取消、
 * ↑↓ 历史浏览、一键重发与历史清空。命令历史存储为命令弹窗与批量发送条
 * 共用，仍由 App.vue 持有（含持久化与敏感命令过滤）。 */
export function useCommandDialog(options: {
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  commandRunning: Ref<boolean>;
  commandHistory: Ref<string[]>;
  commandHistoryIndex: Ref<number>;
  commandHistoryBackup: Ref<string>;
  persistCommandHistory: () => void;
}) {
  const { showError, session, commandRunning, commandHistory, commandHistoryIndex, commandHistoryBackup, persistCommandHistory } = options;

// 执行结果的最小结构（App.vue 的 ExecResult 为局部接口）。
type CommandExecResult = { output: string; exitCode: number };

const commandOpen = ref(false);
const commandDraft = ref("");
const commandUseSudo = ref(true);

const commandExecId = ref("");
const commandResult = ref<CommandExecResult>();
const commandError = ref("");

function openCommandDialog() {
  commandOpen.value = true;
  commandError.value = "";
  commandHistoryIndex.value = -1;
  commandHistoryBackup.value = "";
}

// ↑↓ 在命令输入框中浏览历史；进入浏览态前备份当前草稿，回到最新一条之下时恢复。
function browseCommandHistoryUp() {
  commandHistoryBackup.value = commandHistoryIndex.value === -1 ? commandDraft.value : commandHistoryBackup.value;
  const step = browseCommandHistory(commandHistory.value, commandHistoryIndex.value, "up", commandHistoryBackup.value);
  commandHistoryIndex.value = step.index;
  commandDraft.value = step.draft;
}

function browseCommandHistoryDown() {
  const step = browseCommandHistory(commandHistory.value, commandHistoryIndex.value, "down", commandHistoryBackup.value);
  commandHistoryIndex.value = step.index;
  commandDraft.value = step.draft;
}

function handleCommandInputKeydown(event: KeyboardEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLTextAreaElement)) return;
  const action = commandInputAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    selectionStart: target.selectionStart,
    selectionEnd: target.selectionEnd,
    valueLength: target.value.length,
  });
  if (action === "run") {
    event.preventDefault();
    void runCommand();
  } else if (action === "history-up") {
    event.preventDefault();
    browseCommandHistoryUp();
  } else if (action === "history-down") {
    event.preventDefault();
    browseCommandHistoryDown();
  }
}

// 一键重发：把历史条目回填输入框并立即执行。
function rerunHistoryCommand(command: string) {
  if (commandRunning.value) return;
  commandDraft.value = command;
  commandHistoryIndex.value = -1;
  void runCommand();
}

function clearCommandHistory() {
  commandHistory.value = [];
  commandHistoryIndex.value = -1;
  persistCommandHistory();
}

async function runCommand() {
  const sessionId = session.value?.sessionId;
  const command = commandDraft.value.trim();
  if (!sessionId || !command || commandRunning.value) return;
  commandRunning.value = true;
  commandError.value = "";
  commandResult.value = undefined;
  const execId = randomUUID();
  commandExecId.value = execId;
  try {
    commandResult.value = await window.dbxPlugin.invoke<CommandExecResult>("ssh/exec", {
      sessionId,
      execId,
      command,
      sudo: commandUseSudo.value,
    }, { timeoutMs: 120_000 });
    // 执行成功提交即入历史（不论退出码），与输入框 ↑↓、一键重发共用同一份。
    commandHistory.value = pushCommandHistory(commandHistory.value, command);
    persistCommandHistory();
    commandHistoryIndex.value = -1;
    commandHistoryBackup.value = "";
  } catch (cause) {
    commandError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    commandRunning.value = false;
    commandExecId.value = "";
  }
}

async function cancelCommand() {
  const execId = commandExecId.value;
  if (!execId || !commandRunning.value) return;
  await window.dbxPlugin.invoke("ssh/exec/cancel", { execId }).catch((cause) => showError(cause));
}


  return {
    commandOpen,
    commandDraft,
    commandUseSudo,
    commandExecId,
    commandResult,
    commandError,
    openCommandDialog,
    handleCommandInputKeydown,
    browseCommandHistoryUp,
    browseCommandHistoryDown,
    rerunHistoryCommand,
    clearCommandHistory,
    runCommand,
    cancelCommand,
  };
}
