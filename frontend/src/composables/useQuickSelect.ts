import type { Terminal } from "@xterm/xterm";
import type { ClipboardDeps } from "../lib/clipboardBridge";
import { ref, type Ref } from "vue";
import { Select } from "../components/ui/select";
import { writeClipboardText } from "../lib/clipboardBridge";
import { collectQuickSelectHits, type QuickSelectHit } from "../lib/quickSelect";
import { ArrowDown, ArrowUp } from "@lucide/vue";

/** Quick Select Mode（WT-1，对标 WezTerm）：抽取可视区 URL/路径/IPv4/hash，
 * 浮层逐项复制；焦点不离开终端，Esc/↑↓/Enter 由 handleTerminalKey 的浮层
 * 分支统一消费。 */
export function useQuickSelect(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  terminal: () => Terminal | undefined;
  terminalMenuOpen: Ref<boolean>;
  terminalCopyCache: { set(text: string): void };
  clipboardDeps: () => ClipboardDeps;
}) {
  const { t, showNotice, showError, terminal: terminalGet, terminalMenuOpen, terminalCopyCache, clipboardDeps } = options;

// collectQuickSelectHits 抽取可视区 URL/路径/IPv4/hash，浮层逐项复制。
// 焦点不离开终端：Esc/↑↓/Enter 由 handleTerminalKey 的浮层分支统一消费。
const quickSelectOpen = ref(false);
const quickSelectHits = ref<QuickSelectHit[]>([]);
const quickSelectActive = ref(0);

function openQuickSelect() {
  const term = terminalGet();
  if (!term) return;
  terminalMenuOpen.value = false;
  quickSelectHits.value = collectQuickSelectHits(term.buffer.active, term.rows);
  quickSelectActive.value = 0;
  quickSelectOpen.value = true;
}

function closeQuickSelect() {
  if (!quickSelectOpen.value) return;
  quickSelectOpen.value = false;
  quickSelectHits.value = [];
  quickSelectActive.value = 0;
  terminalGet()?.focus();
}

function moveQuickSelectActive(delta: number) {
  const count = quickSelectHits.value.length;
  if (!count) return;
  quickSelectActive.value = (quickSelectActive.value + delta + count) % count;
}

async function copyQuickSelectHit(hit: QuickSelectHit) {
  terminalCopyCache.set(hit.text);
  try {
    await writeClipboardText(hit.text, clipboardDeps());
    showNotice(t("quickSelect.copied"));
    // 与 WezTerm 同语义：选取完成即收浮层、焦点交还终端。
    closeQuickSelect();
  } catch {
    showError(new Error(t("terminalCopyUnavailable")), "terminal");
  }
}

/** Quick Select 浮层的按键消费：命中返回 true（由调用方吞键），未命中放行。 */
function handleQuickSelectKey(event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    closeQuickSelect();
    return true;
  }
  if (event.key === "ArrowDown") {
    moveQuickSelectActive(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    moveQuickSelectActive(-1);
    return true;
  }
  if (event.key === "Enter") {
    const hit = quickSelectHits.value[quickSelectActive.value];
    if (hit) void copyQuickSelectHit(hit);
    return true;
  }
  return false;
}


  return {
    quickSelectOpen,
    quickSelectHits,
    quickSelectActive,
    openQuickSelect,
    closeQuickSelect,
    moveQuickSelectActive,
    copyQuickSelectHit,
    handleQuickSelectKey,
  };
}
