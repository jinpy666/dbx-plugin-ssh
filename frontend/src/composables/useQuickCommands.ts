import { ref, type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import {
  loadQuickCommandsFromStore,
  normalizeQuickCommands,
  persistQuickCommands,
  quickCommandText,
  upsertQuickCommand,
  type QuickCommand,
} from "../lib/quickCommands";
import { randomUUID } from "../lib/uuid";

/** 快速命令数据面（M32-A3 → 存储迁移批 1）：权威在 pluginStore（宿主
 * ui-storage.json，随 DBX secrets 同步加密上云）；sidecar
 * ssh/quickCommands/* 仅作首次运行的一次性搬迁种子（键缺失才搬，避免复活
 * 已清空清单）。编辑器/导入视图在 QuickCommandsSection（设置·终端），经
 * SettingsDialog 上抛意图；工具栏下拉状态仍在 App.vue。 */
export function useQuickCommands(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  commandRunning: Ref<boolean>;
  terminalTransferBusy: () => boolean;
  terminal: () => Terminal | undefined;
  trackPendingInput: (data: string) => void;
  sendTerminalBytes: (data: Uint8Array) => void;
}) {
  const { t, showNotice, session, commandRunning, terminalTransferBusy, terminal: terminalGet, trackPendingInput, sendTerminalBytes } = options;

// 快速命令：用户自定义片段（≤20 条）。
const quickCommands = ref<QuickCommand[]>([]);
// 管理视图在途态（saving/importing 作为在途态传给设置节）。
const quickSaving = ref(false);
const quickImportBusy = ref(false);

// 水合顺序：pluginStore 权威值（host 档存量，含适配器从同名 localStorage 旧键
// 惰性搬家的值）→ 键缺失时从 sidecar 一次性搬迁（含空清单也要落键，标记
// "已迁移"）→ sidecar 不可用（旧版/降级）保留内存态兜底。
async function hydrateQuickCommands() {
  const stored = loadQuickCommandsFromStore();
  if (stored !== null) {
    quickCommands.value = stored;
    return;
  }
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/list");
    quickCommands.value = persistQuickCommands(normalizeQuickCommands(response.commands));
  } catch {
    // 后端不可用（如旧版 sidecar）：键未落，下次启动重试搬迁；内存态兜底。
  }
}

async function deleteQuickCommand(id: string) {
  quickCommands.value = persistQuickCommands(quickCommands.value.filter((item) => item.id !== id));
}

// 发送语义：快速命令是"在当前交互 shell 中执行"的片段（对齐 tiny-rdm），
// 必须走 PTY 写入——输出直接回显在终端里、cd/env 等状态留在当前 shell；
// ssh/exec 是独立非交互通道，不回显也不共享 shell 状态，不符合语义。
// 命令原文按键盘输入写入（用户可见可中断），不经过任何 shell 拼接转义。
// Run = 写入并回车执行；Paste = 只粘贴到命令行（不执行，可继续编辑）。
// 两种模式都不关弹窗（对齐 Termius：连续挑多条命令是高频操作，关窗会
// 打断流程）；手动 Esc/外点/再点工具栏按钮关闭。
function writeQuickCommand(item: QuickCommand, execute: boolean) {
  if (!session.value || terminalTransferBusy() || commandRunning.value) return;
  const text = quickCommandText(item.command);
  if (!text) return;
  const payload = execute ? `${text}\r` : text;
  if (execute) trackPendingInput(payload);
  sendTerminalBytes(new TextEncoder().encode(payload));
  terminalGet()?.focus();
}
function sendQuickCommand(item: QuickCommand) {
  writeQuickCommand(item, true);
}
function pasteQuickCommand(item: QuickCommand) {
  writeQuickCommand(item, false);
}

// 一键 sudo -v：向当前交互终端按键盘语义写入 `sudo -v` + 回车（等价手敲执行），
// 立即刷新远端 sudo 凭据缓存；输出回显在终端，密码提示由用户/Quick Sudo 应答。
function sendSudoRefresh() {
  if (!session.value || terminalTransferBusy()) return;
  trackPendingInput("sudo -v\r");
  sendTerminalBytes(new TextEncoder().encode("sudo -v\r"));
  terminalGet()?.focus();
}

/** 单条保存（新建/编辑共用）：id 缺省表示新建（前端生成 id）；名称兜底、
 * 截断与 20 条超限丢弃最旧由 upsertQuickCommand 维持（与原后端语义一致）。 */
async function saveQuickCommand(command: { id?: string; name: string; command: string }) {
  if (quickSaving.value) return;
  quickSaving.value = true;
  try {
    const entry: QuickCommand = {
      id: command.id ?? randomUUID(),
      name: command.name,
      command: command.command,
    };
    quickCommands.value = persistQuickCommands(upsertQuickCommand(quickCommands.value, entry));
  } finally {
    quickSaving.value = false;
  }
}

/** 批量导入：本地逐条 upsert（超限丢最旧，与单条保存同语义）后一次性落盘。 */
async function importQuickCommands(items: Array<{ name: string; command: string }>) {
  if (!items.length || quickImportBusy.value) return;
  quickImportBusy.value = true;
  try {
    let next = [...quickCommands.value];
    for (const item of items) {
      next = upsertQuickCommand(next, { id: randomUUID(), name: item.name, command: item.command });
    }
    quickCommands.value = persistQuickCommands(next);
    showNotice(t("quickCommandsImportDone", { count: items.length }));
  } finally {
    quickImportBusy.value = false;
  }
}


  return {
    quickCommands,
    quickSaving,
    quickImportBusy,
    hydrateQuickCommands,
    deleteQuickCommand,
    sendQuickCommand,
    pasteQuickCommand,
    sendSudoRefresh,
    saveQuickCommand,
    importQuickCommands,
  };
}
