import { ref, type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import { normalizeQuickCommands, quickCommandText, type QuickCommand } from "../lib/quickCommands";

/** 快速命令数据面（M32-A3）：全局存储（sidecar 数据目录）CRUD + PTY 一键发送语义。
 * localStorage 旧键仅作为一次性迁移种子；编辑器/导入视图在 QuickCommandsSection
 * （设置·终端），经 SettingsDialog 上抛意图；工具栏下拉状态仍在 App.vue。 */
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
  const { t, showNotice, showError, session, commandRunning, terminalTransferBusy, terminal: terminalGet, trackPendingInput, sendTerminalBytes } = options;

// 快速命令旧键：迁移到 sidecar 全局存储后仅作一次性迁移种子。
const QUICK_COMMANDS_KEY = "ssh-quick-commands";


// 快速命令：用户自定义片段（≤20 条）。
const quickCommands = ref<QuickCommand[]>(loadQuickCommands());
// 管理视图在途态（saving/importing 作为在途态传给设置节）。
const quickSaving = ref(false);
const quickImportBusy = ref(false);

// localStorage 旧键仅作为一次性迁移种子：宿主 webview 存储按工作台分区，
// 旧数据表现为"和连接绑定"，迁移到 sidecar 后才真正全局共享。
function loadQuickCommands(): QuickCommand[] {
  try {
    return normalizeQuickCommands(JSON.parse(window.localStorage.getItem(QUICK_COMMANDS_KEY) || "null"));
  } catch {
    return [];
  }
}

// 挂载时从后端拉取全局清单；后端为空且本工作台有旧 localStorage 数据时一次性
// 迁移（逐条 save 后清除本地键）。后端不可用时保留本地/内存值兜底。
async function hydrateQuickCommands() {
  try {
    let response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/list");
    let commands = normalizeQuickCommands(response.commands);
    if (!commands.length) {
      const legacy = loadQuickCommands();
      for (const item of legacy) {
        await window.dbxPlugin.invoke("ssh/quickCommands/save", { id: "", name: item.name, command: item.command }).catch(() => undefined);
      }
      if (legacy.length) {
        response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/list");
        commands = normalizeQuickCommands(response.commands);
        try {
          window.localStorage.removeItem(QUICK_COMMANDS_KEY);
        } catch {
          // 清理失败只影响下次空跑迁移，不影响功能。
        }
      }
    }
    quickCommands.value = commands;
  } catch {
    // 后端不可用（如旧版 sidecar）：保留 localStorage/内存值，行为回到旧语义。
  }
}

async function deleteQuickCommand(id: string) {
  // 删除确认在 QuickCommandsSection 内完成（管理视图专属交互）。
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/delete", { id });
    quickCommands.value = normalizeQuickCommands(response.commands);
  } catch (cause) {
    showError(cause, "terminal");
  }
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

/** 单条保存（新建/编辑共用）：id 为空串表示新建（后端按此区分）。 */
async function saveQuickCommand(command: { id?: string; name: string; command: string }) {
  if (quickSaving.value) return;
  quickSaving.value = true;
  try {
    const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/save", {
      id: command.id ?? "",
      name: command.name,
      command: command.command,
    });
    quickCommands.value = normalizeQuickCommands(response.commands);
  } catch (cause) {
    showError(cause, "terminal");
  } finally {
    quickSaving.value = false;
  }
}

/** 批量导入：预览 accepted 条目逐条走既有 ssh/quickCommands/save
 *  （沿用后端 20 条上限校验），任一条失败即中止并提示已导入进度。 */
async function importQuickCommands(items: Array<{ name: string; command: string }>) {
  if (!items.length || quickImportBusy.value) return;
  quickImportBusy.value = true;
  try {
    for (const item of items) {
      const response = await window.dbxPlugin.invoke<{ commands: unknown }>("ssh/quickCommands/save", {
        id: "",
        name: item.name,
        command: item.command,
      });
      quickCommands.value = normalizeQuickCommands(response.commands);
    }
    showNotice(t("quickCommandsImportDone", { count: items.length }));
  } catch (cause) {
    showError(cause);
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
