import type { Terminal } from "@xterm/xterm";
import type { QuickCommand } from "../lib/quickCommands";
import type { CompletionEdit, CompletionItem, CompletionResponse } from "../lib/completion/core/types";
import type { SuggestionAnchor } from "../lib/overlayPlacement";
import { onBeforeUnmount, ref, type Ref } from "vue";
import { pushCommandHistory } from "../lib/commandHistory";
import { searchCommands, commandSuggestionQueryAcceptable, resolveSuggestionTabKey, type CommandSuggestion } from "../lib/commandSuggestions";
import { addToSuggestionBlocklist, loadSuggestionBlocklist } from "../lib/suggestionBlocklist";
import { pickGhostMatch } from "../lib/terminalGhostSuggest";
import { CompletionController, type CompletionGeneratorChannel } from "../lib/completion/CompletionController";
import { applyEditToText, longestCommonPrefixEdit } from "../lib/completion/core/edit";
import { rankItems } from "../lib/completion/core/ranking";
import { figCompletionSource } from "../lib/completion/fig/figCompletionSource";
import { GeneratorScheduler } from "../lib/completion/fig/generatorScheduler";
import { resolveCompletionKey, type CompletionKeyboardState } from "../lib/completion/keyboard";
import { withShellBuiltinsSource, detectShellKind } from "../lib/completion/shell/shellBuiltins";
import { createEngineRunner } from "../lib/completion/worker/engineRunner";
import { pluginStore, loadCompletionEngine } from "../lib/pluginStore";
import { canShowSuggestions, createSuggestionGuardState, type SuggestionGuardState } from "../lib/suggestionGuard";
import { cursorViewportRow, measureCellSizeFromDom } from "../lib/terminalAnchor";
import { ArrowDown, ArrowUp } from "@lucide/vue";

/** 命令输入建议浮层（P1-1）+ 结构化补全（FIG wave-1）：历史建议与 fig 引擎
 * 两层浮层的采集→抑制门→检索→定位→按键消费，CompletionController 调度
 * 中枢（engine runner + shell 内建兜底 + 声明式 generator 通道）。行缓冲
 * 读写、终端 host 量测与会话 id 解析经依赖注入（基础件仍在 App.vue）。 */
export function useCommandSuggestions(options: {
  terminal: () => Terminal | undefined;
  getTerminalHost: () => HTMLElement | null | undefined;
  sendTerminalBytes: (data: Uint8Array) => void;
  getPendingTerminalInput: () => string;
  setPendingTerminalInput: (value: string) => void;
  commandRunning: Ref<boolean>;
  isTerminalTransferBusy: () => boolean;
  commandHistory: Ref<string[]>;
  quickCommands: Ref<QuickCommand[]>;
  suggestionsEnabledState: Ref<boolean>;
  suggestionMinCharsState: Ref<number>;
  suggestionMaxCharsState: Ref<number>;
  terminalCwd: Ref<string>;
  session: Ref<{ sessionId?: string } | undefined>;
  getSessionId: () => string;
  getLocalSessionId: () => string | undefined;
  persistCommandHistory: () => void;
  /** Warp 式 history 面板开启时，锚点同步帧连带刷新面板锚点。 */
  isHistoryPanelOpen: () => boolean;
  syncHistoryPanelAnchor: () => void;
  /** 面板开启期间的键入分流：按最新行缓冲重算过滤结果（App.vue 状态接线）。 */
  updateHistoryPanelFilter: () => void;
  /** 统一采集口：命令环 + 执行时间映射一并推进（回填后回车执行路径）。 */
  pushTerminalCommandHistory: (command: string) => void;
  /** 行内 ghost 建议是否启用（数据分工：前缀延伸命中让位 ghost，#138 批 2）。
   *  惰性求值——useGhostSuggest 在本 composable 之后初始化，闭包在 onData
   *  期才调用，无 TDZ 风险。 */
  inlineGhostActive: () => boolean;
  /** 终端交互提示待答（issue #150 及其反馈扩展，MFA/验证码/密码待输入、
   *  选择菜单与 y/n 确认）：惰性求值，键入期采样——交互应答不是命令键入，
   *  不开建议/补全浮层。 */
  isInteractivePromptPending: () => boolean;
}) {
  const { terminal: terminalGet, terminalCwd, getTerminalHost, sendTerminalBytes, getPendingTerminalInput, setPendingTerminalInput, commandRunning, isTerminalTransferBusy, commandHistory, quickCommands, suggestionsEnabledState, suggestionMinCharsState, suggestionMaxCharsState, session, getSessionId, getLocalSessionId, persistCommandHistory, isHistoryPanelOpen, syncHistoryPanelAnchor, updateHistoryPanelFilter, pushTerminalCommandHistory, inlineGhostActive, isInteractivePromptPending } = options;

// 命令输入建议浮层（P1-1）运行时状态：条目/选中项/光标锚点与抑制门锁存。
// 开关与长度上下限的权威值在上方 suggestions*State（sidecar 偏好）。
const suggestionOpen = ref(false);
const suggestionItems = ref<CommandSuggestion[]>([]);
const suggestionActiveIndex = ref(0);
// Tab 接受的显式选中锁（issue #138）：↑↓ 导航置位，候选随键入重算时复位。
// 仅锁存态允许 Tab 回填与当前行无关的模糊命中项；非响应式，不进渲染。
let suggestionTabArmed = false;
const suggestionAnchor = ref<SuggestionAnchor | null>(null);
const suggestionQuery = ref("");
// 抑制门锁存（跟随型程序命中后保持抑制，Ctrl+C/q 解除）：非响应式即可，
// 只有 canShowSuggestions 的返回值会进渲染。
let suggestionGuardState: SuggestionGuardState = createSuggestionGuardState();
// 最近一次执行的命令行（onData 回车行 + OSC 633 E 帧），抑制门据此判定。
const lastTerminalCommand = ref<string | null>(null);

// 结构化补全浮层（FIG wave-1 最终架构）：唯一来源 = fig 引擎，经冻结接缝
// FigCompletionSource 注入 CompletionController（解析→防抖→guard→菜单）。
// 行缓冲/锚点语义与 suggestion* 一致（pendingTerminalInput +
// readTerminalSuggestionAnchor）。引擎三态存 pluginStore
// （ssh-completion-engine：fig-safe 默认 / fig / off），SettingsDialog 下拉
// 自治写入，本处每次调度前直读（无缓存即时生效）。
// 批次 2-1 接线：真实 figCompletionSource（vendored amazon-q parser + 全量
// 语料）DEV/生产同源；声明式 generator 位经 GeneratorScheduler → hostClient
// （completion/execute，目标机执行）异步补齐，静态候选先行（两段渲染）。
// fig-safe 与 fig 本批次 generator 行为相同；off 时 controller 不调度。
// 类型不标注冻结接口：collectGenerators 是 impl 上的批次 2-1 第二通道。
// 批次 2-2 接线：engine runner 包裹同一 source——支持 data-URL worker 的环境
// 走 worker 线程（resolve 返回 Promise，controller 三重 guard 异步交付），
// 否则/崩溃两次后永久主线程直跑（§44），调用方无感。
// Windows shell 兜底（用户反馈：cmd/PowerShell 无提示）：runner 外侧再包一层
// 内建命令 source——fig 语料 pass-through 且提示符判出 PowerShell/cmd 时，
// 命令名位补 cmdlet/内建命令候选；detect 读 xterm buffer，只能在主线程，
// 故必须在 runner（worker）外侧包装，worker 内不感知。
const completionEngineSource = createEngineRunner({ createSource: () => figCompletionSource });
// inline worker 无 GC 兜底：工作台重挂载（webview 重建/HMR）时旧 runner 的
// 常驻线程必须显式回收，否则每次挂载泄漏一个 worker。
onBeforeUnmount(() => completionEngineSource.dispose());
const completionSource = withShellBuiltinsSource(completionEngineSource, sniffTerminalShell);

// 声明式 generator 调度：目标取当前会话（ssh 优先，其次本地；串口无可执行
// 目标 → null 即不执行），cwd 用 OSC 7/633 跟踪值（terminalCwd）。
const completionScheduler = new GeneratorScheduler({
  // E lane 裁决：runner 只代理冻结接口的 resolve；槽位提取轻量且 generator
  // 执行面在目标机（completion/execute），collect 维持主线程直引单例。
  collect: (request) => figCompletionSource.collectGenerators(request),
  target: () => {
    const sshSessionId = session.value?.sessionId;
    if (sshSessionId) return { kind: "ssh", sessionId: sshSessionId };
    const localSessionId = getLocalSessionId();
    if (localSessionId) return { kind: "local", sessionId: localSessionId };
    return null;
  },
  cwd: () => (terminalCwd.value ? terminalCwd.value : null),
});
const completionGeneratorChannel: CompletionGeneratorChannel = {
  slots: (request) => completionScheduler.slots(request),
  run: (slot) => completionScheduler.run(slot),
};
const completionOpen = ref(false);
const completionItems = ref<CompletionItem[]>([]);
const completionActiveIndex = ref(0);
const completionAnchor = ref<SuggestionAnchor | null>(null);
// generator 在途占位态（§31）：true 仅表示「无静态候选、动态候选在途」的
// loading 浮层（零条目占位行，Tab/Enter 放行 shell）；静态候选照常先行。
const completionLoading = ref(false);
// 结构化补全输入门：仅 onData 常规键入路径（refreshSuggestionsAfterInput 的
// guard.show 分支）放行调度。粘贴/快速命令/本地重跑等旁路写入不开浮层
// （与基线一致）；guard 抑制（alternate screen/跟随程序锁存/历史建议总开关
// 关）同样关门。controller 在 lineChanged 调度时与 dispatch 前各查一次。
let completionInputAllowed = false;

function closeCompletionMenu() {
  completionOpen.value = false;
  completionItems.value = [];
  completionActiveIndex.value = 0;
  completionLoading.value = false;
}

/** 响应落地：ready（rankItems 排序截断后非空）开浮层；loading（generator
 *  在途且无静态候选）仅当浮层已开时切占位行——不主动开菜单（用户反馈：
 *  generator 位逐键闪出"加载中"悬浮层，属未请求的自动弹出）；pass-through
 *  关。首帧 ready 到达才开浮层，与 Warp/VS Code 的"无候选不弹"一致。 */
function handleCompletionResponse(response: CompletionResponse) {
  if (response.state === "ready" && response.items.length) {
    completionLoading.value = false;
    openCompletionMenu(response);
  } else if (response.state === "loading" && completionOpen.value) {
    completionLoading.value = true;
    completionItems.value = [];
    completionActiveIndex.value = 0;
    completionAnchor.value = readTerminalSuggestionAnchor();
  } else if (response.state !== "loading") {
    closeCompletionMenu();
  }
}

function openCompletionMenu(response: CompletionResponse) {
  const items = rankItems(response.items);
  if (!items.length) {
    closeCompletionMenu();
    return;
  }
  completionItems.value = items;
  completionActiveIndex.value = 0;
  completionAnchor.value = readTerminalSuggestionAnchor();
  completionOpen.value = true;
  // 双浮层仲裁（#138 丝滑度 review P0-A）：worker 模式下补全响应异步到达，
  // 键入时刻的互斥检查（refreshSuggestionsAfterInput 里 completionOpen 为
  // false）已放行历史建议浮层；此处不收会出现两个同锚点浮层叠加到下一次
  // 击键。补全菜单优先（结构化候选信息量更高），同步关掉建议浮层。
  closeSuggestionsOnly();
}

/**
 * 结构化补全浮层的按键消费（方案 §21，规则表固化在 keyboard.ts）：
 * ↑↓ 选择、Tab 填充静态候选、Esc 关闭；**Enter 恒定放行 shell 执行当前行**
 * （return false 不消费，回车字节照发 PTY）；generator 动态位置（hint 行）
 * 与 loading 态的 Tab 同样放行——远程 shell 是最后一级 completion provider。
 */
function handleCompletionKey(event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || !completionOpen.value) return false;
  const items = completionItems.value;
  // loading（generator 在途且无静态候选）时 Tab/Enter 放行 shell
  // （keyboard.ts 规则表 §21：动态/generator 位置或 loading 一律透传）；
  // 静态候选已就位则保持静态键盘模式（active 项可 Tab 接受）。
  const state: CompletionKeyboardState = {
    menuOpen: completionOpen.value,
    hasItems: items.length > 0,
    activeItemKind: items[completionActiveIndex.value]?.kind ?? null,
    loading: completionLoading.value && items.length === 0,
  };
  switch (resolveCompletionKey(state, event.key)) {
    case "accept": {
      const item = items[completionActiveIndex.value];
      if (!item) return true;
      // 批 4b（Warp prefix.rs / shell 语义）：多候选共享同一替换区间时，Tab
      // 先补最长公共前缀并保持菜单打开（refreshCompletionMenu 按新行重算）；
      // 无推进（已到公共边界）或区间不一致才接受高亮项。
      const prefixEdit = longestCommonPrefixEdit(items, getPendingTerminalInput());
      if (prefixEdit) {
        completionController.accept({ ...item, edit: prefixEdit });
        refreshCompletionMenu();
        return true;
      }
      acceptCompletionRow(item);
      return true;
    }
    case "close":
      closeCompletionMenu();
      return true;
    case "next":
      completionActiveIndex.value = (completionActiveIndex.value + 1) % items.length;
      return true;
    case "prev":
      completionActiveIndex.value = (completionActiveIndex.value - 1 + items.length) % items.length;
      return true;
    case "passthrough":
      // Enter 恒执行当前行、Tab 交还 shell（静态候选外的透传面）：同基线，
      // 放行前关闭浮层，避免 shell 自己的补全/执行与浮层叠加。
      closeCompletionMenu();
      return false;
    default:
      return false;
  }
}

/** 接受候选项（§24 映射）：item.edit 经 applyEditToText 应用后仍走
 *  replaceTerminalLineWith（整行擦重打机制不变），随后同步刷新候选
 *  （request 即时冲掉挂起的防抖，保持基线的无闪断刷新时序）。 */
function acceptCompletionRow(item: CompletionItem) {
  if (item.kind === "hint") {
    closeCompletionMenu();
    terminalGet()?.focus();
    return;
  }
  completionController.accept(item);
  refreshCompletionMenu();
  if (!completionOpen.value) terminalGet()?.focus();
}

/** 按当前行缓冲重算结构化补全候选：ready 开/刷新浮层，pass-through 关闭
 *  （回落历史建议，由调用方处理）。 */
function refreshCompletionMenu() {
  completionController.request("typing");
}

/** 手动唤起结构化补全菜单（Warp completions 手动键 Ctrl+Space 同位）：显式
 *  请求放行输入门（completionInputAllowed 只在常规键入路径放行，热键路径
 *  必须自开门，否则 request 会被 enabled() 拦下）；抑制门锁存（跟随程序/
 *  历史面板期间）不拦显式动作——用户点名要菜单就给菜单。候选空/引擎 off
 *  由 controller 原样关闭，无副作用。 */
function openCompletionsManually() {
  completionInputAllowed = true;
  refreshCompletionMenu();
}

// CompletionController（lib/completion）：调度中枢。enabled = 引擎三态
// （off 即关）+ 输入门；session id 取当前会话（无会话空串，guard 兜底）；
// generators 通道接声明式 generator 调度（两段渲染 + 三重 guard 在 controller）。
const completionController = new CompletionController({
  source: completionSource,
  sessionId: getSessionId,
  readLine: getPendingTerminalInput,
  // 传输占用（zmodem/trzsz）与命令弹窗执行期间不开浮层（与 ghost 同门）：
  // 输出流里的键入回显不该触发候选请求，更不该把悬浮层盖在输出上。
  enabled: () =>
    loadCompletionEngine() !== "off" &&
    completionInputAllowed &&
    !isTerminalTransferBusy() &&
    !commandRunning.value,
  generators: completionGeneratorChannel,
  onResponse: handleCompletionResponse,
  onAcceptEdit: (edit: CompletionEdit) => {
    // 替换范围由 source 的 CompletionEdit 给出（含引号/转义表面）；越界时
    // applyEditToText 向行界收敛（行漂移防御），整行擦重打机制不变。
    const applied = applyEditToText(getPendingTerminalInput(), edit);
    replaceTerminalLineWith(applied.text, false);
  },
});

// 建议浮层锚点的回显同步（issue #120「浮层离焦点太远」）：onData 时刻回显
// 往往还在路上（SSH RTT），buffer 光标停在旧位置，浮层锚点持续滞后于输入；
// 每批输出解析完成（settleOutputChunk）后重读锚点，浮层吸附到真实光标位。
// rAF 合帧：大量输出（tail -f）时每帧至多测一次 rect。
let suggestionAnchorSyncScheduled = false;
function syncSuggestionAnchorsOnSettle() {
  if (suggestionAnchorSyncScheduled) return;
  suggestionAnchorSyncScheduled = true;
  requestAnimationFrame(() => {
    suggestionAnchorSyncScheduled = false;
    if (suggestionOpen.value) suggestionAnchor.value = readTerminalSuggestionAnchor();
    if (completionOpen.value) completionAnchor.value = readTerminalSuggestionAnchor();
    if (isHistoryPanelOpen()) syncHistoryPanelAnchor();
  });
}

function closeSuggestionsOnly() {
  cancelSuggestionCloseGrace();
  suggestionOpen.value = false;
  suggestionItems.value = [];
  suggestionActiveIndex.value = 0;
}

// —— 空结果宽限（批 3b 防闪烁）：快速打词的中间态常瞬时无匹配（"doc"→
// "dock"→"docker"），逐键即关即开会把浮层闪成频闪灯。空结果先挂 150ms
// 宽限：窗口内下一次键入若重新命中则照常刷新（取消挂起关闭），真正无匹配
// 才收起（VS Code 补全同款迟滞）。注意所有「立即关」路径都走
// closeSuggestionsOnly（其内取消宽限），宽限只兜「打字中瞬时空洞」。 ——
let suggestionCloseTimer: ReturnType<typeof setTimeout> | undefined;
const SUGGESTION_CLOSE_GRACE_MS = 150;

function cancelSuggestionCloseGrace() {
  if (suggestionCloseTimer === undefined) return;
  clearTimeout(suggestionCloseTimer);
  suggestionCloseTimer = undefined;
}

function scheduleSuggestionCloseGrace() {
  cancelSuggestionCloseGrace();
  if (!suggestionOpen.value) return;
  suggestionCloseTimer = setTimeout(() => {
    suggestionCloseTimer = undefined;
    closeSuggestionsOnly();
  }, SUGGESTION_CLOSE_GRACE_MS);
}

function closeSuggestions() {
  closeSuggestionsOnly();
  // 结构化补全浮层与历史建议浮层同一生命周期（Ctrl+C/回车/Esc 同步关闭）；
  // dismiss 同步作废挂起调度与在途结果（revision 前进）。
  completionController.dismiss();
  // 同步落输入门：关闭后 lineChanged/settle 触发的重调度（如 history 面板
  // 开启期间选中回填触发 lineChanged）不再把补全菜单重新拉起——面板与建议/
  // 补全互斥；常规键入路径（refreshSuggestionsAfterInput）会重新放行。
  completionInputAllowed = false;
  closeCompletionMenu();
}

function suggestionSearchBounds() {
  return {
    minLength: Math.max(1, suggestionMinCharsState.value),
    maxLength: Math.max(suggestionMinCharsState.value, suggestionMaxCharsState.value),
  };
}

// 建议黑名单（批 4c，Warp IgnoredSuggestions 语义）：行内 ✗ 永久排除单条
// 建议，pluginStore 持久化；运行时 ref 供设置页计数与清空联动。
const suggestionBlocklist = ref(loadSuggestionBlocklist());

function runSuggestionSearch(query: string): CommandSuggestion[] {
  const bounds = suggestionSearchBounds();
  const blocklisted = new Set(suggestionBlocklist.value);
  return searchCommands(query, { history: commandHistory.value, quickCommands: quickCommands.value }, { ...bounds, limit: 12 })
    .filter((item) => !blocklisted.has(item.command));
}

/** 行内 ✗：永久排除该建议并即时收起浮层（下次检索不再出现）。 */
function ignoreSuggestion(command: string) {
  suggestionBlocklist.value = addToSuggestionBlocklist(command, suggestionBlocklist.value);
  closeSuggestionsOnly();
}

/** 单字符输入事件抽取：多字符粘贴 / 控制序列 / 回车返回 null。 */
function suggestionTypingChar(data: string): string | null {
  if (data.length !== 1) return null;
  const char = data.charAt(0);
  if (char < " " || char === "\u007f") return null;
  return char;
}

/**
 * onData 每次输入后调用：推进抑制门状态并按需刷新浮层。
 * lineBefore 是本次输入前的行缓冲快照（\r 清空后仍能取到被执行的命令行）。
 * 结构化补全（fig 引擎）经 CompletionController 调度：本函数是唯一放行
 * completionInputAllowed 的地方（常规键入路径），旁路写入（粘贴/快速命令）
 * 与 guard 抑制面一律关门。
 */
function refreshSuggestionsAfterInput(data: string, lineBefore: string) {
  // Warp 式 history 面板开启期间：建议/补全/ghost 浮层全部让位（同屏不叠
  // 两层浮层），面板按最新行缓冲实时过滤；面板关闭后的下一次键入恢复常规
  // 调度（guard 锁存暂停推进——面板期间 ↑↓/Enter 均被吞键，不会产生命令）。
  if (isHistoryPanelOpen()) {
    updateHistoryPanelFilter();
    return;
  }
  const alternateActive = terminalGet()?.buffer.active.type === "alternate";
  const typingChar = suggestionTypingChar(data);

  if (data.includes("\u0003")) {
    // Ctrl+C：打断当前行与跟随程序，锁存解除，浮层关闭。
    completionInputAllowed = false;
    suggestionGuardState = canShowSuggestions({ alternateActive, lastCommand: null, typingChar: "\u0003" }, suggestionGuardState).state;
    lastTerminalCommand.value = null;
    closeSuggestions();
    return;
  }
  if (data.includes("\r") || data.includes("\n")) {
    const executed = lineBefore.trim();
    if (executed) lastTerminalCommand.value = executed;
    completionInputAllowed = false;
    suggestionGuardState = canShowSuggestions({ alternateActive, lastCommand: lastTerminalCommand.value, typingChar: null }, suggestionGuardState).state;
    closeSuggestions();
    return;
  }
  if (data.includes("\u001b")) {
    // 方向键/控制序列：不当作输入，浮层保持原状之外直接隐藏（无法追踪行内容）。
    completionInputAllowed = false;
    closeSuggestions();
    return;
  }
  if (data === "\t") {
    // 裸 Tab 已按 #138 语义放行 shell 做路径补全：本次键入不开浮层——guard 对
    // 控制键返回 show，不拦会把刚关闭的浮层在同一按键的 onData 里重开。
    // shell 补全回显后的下一次常规键入照常重新调度。
    completionInputAllowed = false;
    closeSuggestions();
    return;
  }

  const guard = canShowSuggestions(
    { alternateActive, lastCommand: lastTerminalCommand.value, typingChar, lineEmpty: lineBefore.length === 0, interactivePromptPending: isInteractivePromptPending() },
    suggestionGuardState,
  );
  suggestionGuardState = guard.state;
  if (!guard.show || !suggestionsEnabledState.value) {
    completionInputAllowed = false;
    closeSuggestions();
    return;
  }
  // 结构化补全（fig 引擎）优先：request 发起解析——worker 模式下响应异步
  // 回来（三重 guard 保证过期结果不进 UI）；pass-through 关浮层并回落下方
  // 历史建议浮层（两者并存、不替换，历史建议分支一行未动）。
  completionInputAllowed = true;
  completionController.request("typing");
  if (completionOpen.value) {
    suggestionOpen.value = false;
    suggestionItems.value = [];
    return;
  }
  closeCompletionMenu();
  const query = getPendingTerminalInput();
  const bounds = suggestionSearchBounds();
  if (!commandSuggestionQueryAcceptable(query, bounds.minLength, bounds.maxLength)) {
    // 历史回落分支只收历史浮层：此处 dismiss 会顶掉本次键入在途的补全响应
    // （见 closeSuggestionsOnly 注释），worker 模式下表现为补全永久失效。
    closeSuggestionsOnly();
    return;
  }
  const items = runSuggestionSearch(query);
  if (!items.length) {
    // 空结果走宽限（批 3b 防闪烁）：瞬时空洞（打词中间态）不立即收浮层，
    // 150ms 内下一次键入重新命中则无感刷新；真正无匹配才关。
    scheduleSuggestionCloseGrace();
    return;
  }
  // 数据分工（#138 丝滑度批 2，P0-C——ghost 默认不可见的根因修复）：候选里
  // 存在前缀延伸命中时让位给行内 ghost（Warp/fish 口径——ghost 是光标后的
  // 灰字不遮输出，→/Ctrl+→ 接受；模糊浮层弹出会把它互斥掉）。同一份
  // searchCommands 结果复用判定，零额外检索；ghost 开关关闭时分工不生效，
  // 浮层照旧。结构化补全不受影响（上方 request 照发，与 ghost 同屏共存）。
  if (inlineGhostActive() && pickGhostMatch(query, items)) {
    closeSuggestionsOnly();
    return;
  }
  suggestionQuery.value = query;
  suggestionItems.value = items;
  suggestionActiveIndex.value = 0;
  // 候选随键入重算即回到「自动高亮」态：Tab 显式选中锁复位（issue #138）；
  // 空结果宽限一并取消（本键已重新命中，不得再被挂起的关闭收走）。
  suggestionTabArmed = false;
  cancelSuggestionCloseGrace();
  suggestionAnchor.value = readTerminalSuggestionAnchor();
  suggestionOpen.value = true;
}

/**
 * 光标像素锚点：xterm 私有渲染尺寸（css.cell 宽高）× 光标缓冲坐标。
 * 读不到（渲染器未就绪/内部结构变化）返回 null，浮层降级贴终端底部。
 */
// 翻转定位用的可视底界（terminal-host 实际高度，含让位后的净高）：
// anchor 计算时顺带刷新，两个建议浮层据此决定下方/上方放置。
const suggestionViewport = ref({ height: 0 });

/** 光标格换算的共享参数：.xterm-screen 原点 + 单元格尺寸 + buffer 坐标。 */
interface TerminalCellFrame {
  originLeft: number;
  originTop: number;
  cellWidth: number;
  cellHeight: number;
  cursorX: number;
  visibleRow: number;
}

/**
 * 浮层与 ghost 共用的光标格锚点源（issue #120）：以 .xterm-screen（渲染
 * 内容区，位于 .xterm 内边距内侧）为原点，加光标网格坐标——可配置的终端
 * 内边距由 screen rect 自动计入，ghost 与两个建议浮层不再各自为政。
 * textarea 平时被 xterm 移出屏幕（CSS left:-9999em，仅 IME 时定位），
 * 不可用作锚点。
 */
function readTerminalCellFrame(): TerminalCellFrame | null {
  const term = terminalGet();
  const host = getTerminalHost();
  if (!term || !host) return null;
  try {
    const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    let cellWidth = cell?.width ?? 0;
    let cellHeight = cell?.height ?? 0;
    const screen = term.element?.querySelector(".xterm-screen");
    // 渲染器尺寸读不到（未就绪/WebGL 恢复切换窗口期，Windows 上更常见）时用
    // 渲染 DOM 实测兜底：此前直接 null → 浮层永久降级贴底、不跟随不翻转。
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
      const fromDom = measureCellSizeFromDom(
        screen ?? null,
        term.element?.querySelector(".xterm-rows") ?? null,
        term.cols,
      );
      if (!fromDom) return null;
      cellWidth = fromDom.width;
      cellHeight = fromDom.height;
    }
    const buffer = term.buffer.active;
    // cursorY 已是视口内相对行；旧式 `cursorY - viewportY` 在回滚区出现后为负，浮层画出画布。
    const visibleRow = cursorViewportRow(buffer);
    const hostRect = host.getBoundingClientRect();
    const origin = (screen ?? term.element)?.getBoundingClientRect();
    if (!origin) return null;
    return {
      originLeft: origin.left - hostRect.left,
      originTop: origin.top - hostRect.top,
      cellWidth,
      cellHeight,
      cursorX: buffer.cursorX,
      visibleRow,
    };
  } catch {
    return null;
  }
}

function readTerminalSuggestionAnchor(): SuggestionAnchor | null {
  const frame = readTerminalCellFrame();
  if (!frame || !getTerminalHost()) return null;
  // 翻转定位的可视底界 = terminal-host 实际高度：batch-bar/标记条让位
  // （inset-bottom）后它比包含块 pane 矮，必须用 host 高度，否则浮层会
  // 越过终端文字区盖住 footer/批量条（issue #120 实机反馈）。
  suggestionViewport.value = { height: getTerminalHost()?.clientHeight ?? 0 };
  return {
    x: Math.round(frame.originLeft + frame.cursorX * frame.cellWidth),
    y: Math.round(frame.originTop + frame.visibleRow * frame.cellHeight),
    cellHeight: frame.cellHeight,
    cellWidth: frame.cellWidth,
  };
}

// Windows shell 提示符采样（shellBuiltins 兜底源的 detect 回调）：光标行起
// 向上至多 3 行里找 `PS C:\…>` / `C:\…>` 形态提示符。POSIX 提示符不命中，
// 行为与直连 fig 引擎一致。TTL 1s：键入路径每次调度都会问一次，miss 也廉价
// （3 行 buffer 扫描）；短 TTL 保证会话早期（提示符刚到达）尽快收敛。
const terminalShellSniff = { kind: null as "powershell" | "cmd" | null, at: 0 };
function sniffTerminalShell(): "powershell" | "cmd" | null {
  const now = Date.now();
  if (now - terminalShellSniff.at < 1000) return terminalShellSniff.kind;
  terminalShellSniff.at = now;
  terminalShellSniff.kind = null;
  try {
    const term = terminalGet();
    if (!term) return null;
    const buffer = term.buffer.active;
    if (buffer.type !== "normal") return null;
    const cursorRow = buffer.baseY + Math.min(buffer.cursorY, buffer.length - 1);
    for (let rowY = cursorRow; rowY >= Math.max(0, cursorRow - 2); rowY -= 1) {
      const text = buffer.getLine(rowY)?.translateToString(true) ?? "";
      const kind = detectShellKind(text);
      if (kind) {
        terminalShellSniff.kind = kind;
        break;
      }
    }
  } catch {
    return null;
  }
  return terminalShellSniff.kind;
}

/** 浮层开启时的按键消费：↑↓ 选择（置 Tab 显式选中锁）、Tab 按 #138 语义
 *  裁决（延伸/显式选中回填，其余放行 shell 补全）、Enter 执行当前行、Esc 关闭。 */
function handleSuggestionKey(event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || !suggestionOpen.value || !suggestionItems.value.length) return false;
  const items = suggestionItems.value;
  if (event.key === "ArrowDown") {
    suggestionActiveIndex.value = (suggestionActiveIndex.value + 1) % items.length;
    suggestionTabArmed = true;
    return true;
  }
  if (event.key === "ArrowUp") {
    suggestionActiveIndex.value = (suggestionActiveIndex.value - 1 + items.length) % items.length;
    suggestionTabArmed = true;
    return true;
  }
  if (event.key === "Tab") {
    // issue #138：Tab 默认归远端 shell（路径补全是 Tab 的本职）——仅当高亮
    // 建议是当前行的严格延伸、或用户已 ↑↓ 显式选中（tabArmed）时才回填；
    // 自动高亮的模糊命中不再被 Tab 默认选上。放行路径关闭浮层后 return
    // false 不消费，Tab 字节照发 PTY；onData 的 "\t" 短路分支保证浮层不会
    // 被同一按键立即重开。
    const item = items[suggestionActiveIndex.value];
    if (item && resolveSuggestionTabKey(item.command, getPendingTerminalInput(), suggestionTabArmed) === "fill") {
      fillSuggestion(item);
      return true;
    }
    closeSuggestions();
    return false;
  }
  if (event.key === "Enter") {
    // 执行当前输入行（review #120：浮层自动出现 ≠ 接管 Enter）——关闭浮层
    // 后不消费，回车字节原样进 PTY；要执行建议先 Tab 填充再回车。
    closeSuggestions();
    return false;
  }
  if (event.key === "Escape") {
    closeSuggestions();
    return true;
  }
  return false;
}

/** 把当前输入行替换为建议命令（退格抹掉已敲字符后按键盘语义重新写入）。 */
function replaceTerminalLineWith(nextLine: string, pressEnter: boolean) {
  if (!terminalGet()) return;
  const erase = "\u007f".repeat(getPendingTerminalInput().length);
  const payload = erase + nextLine + (pressEnter ? "\r" : "");
  setPendingTerminalInput(pressEnter ? "" : nextLine);
  if (pressEnter) {
    lastTerminalCommand.value = nextLine;
    pushTerminalCommandHistory(nextLine);
  }
  sendTerminalBytes(new TextEncoder().encode(payload));
  // 整行替换也是行缓冲变更点（FIG wave-1 锚点）：作废在途结果并防抖刷新；
  // 显式刷新面（acceptCompletionRow）会紧跟 request 即时冲掉本次防抖。
  completionController.lineChanged();
}

function fillSuggestion(item: CommandSuggestion) {
  replaceTerminalLineWith(item.command, false);
  // 填充后按新行内容刷新候选（可能只剩自身），保持浮层继续可微调。
  const items = runSuggestionSearch(item.command);
  if (items.length) {
    suggestionItems.value = items;
    suggestionActiveIndex.value = Math.max(0, items.findIndex((entry) => entry.command === item.command));
    suggestionQuery.value = item.command;
    suggestionAnchor.value = readTerminalSuggestionAnchor();
  } else {
    closeSuggestions();
  }
  // 本次回填即接受动作：显式选中锁复位，下一次 Tab 回到延伸/重新选择裁决。
  suggestionTabArmed = false;
  terminalGet()?.focus();
}

/** 会话切换/断开：建议浮层与抑制门锁存一并复位（P1-1）；结构化补全在途
 * 结果经 resetSession 作废（sessionId guard 另有兜底）。由命令标记复位点调用。 */
function resetSuggestionsForSession() {
  closeSuggestions();
  suggestionGuardState = createSuggestionGuardState();
  completionInputAllowed = false;
  completionController.resetSession();
  lastTerminalCommand.value = null;
}


  return {
    suggestionOpen,
    suggestionItems,
    suggestionActiveIndex,
    suggestionAnchor,
    suggestionQuery,
    suggestionViewport,
    completionOpen,
    completionItems,
    completionActiveIndex,
    completionAnchor,
    completionLoading,
    closeSuggestions,
    closeSuggestionsOnly,
    handleSuggestionKey,
    handleCompletionKey,
    refreshSuggestionsAfterInput,
    refreshCompletionMenu,
    openCompletionsManually,
    replaceTerminalLineWith,
    fillSuggestion,
    acceptCompletionRow,
    syncSuggestionAnchorsOnSettle,
    readTerminalCellFrame,
    readTerminalSuggestionAnchor,
    completionController,
    /** 提示符采样判远端 shell（powershell/cmd/null）：AI 上下文的 shell 语义
     *  来源（Warp AI 对齐批）——复用既有采样，不为 AI 另写探测。 */
    sniffTerminalShell,
    lastTerminalCommand,
    resetSuggestionsForSession,
    ignoreSuggestion,
  };
}
