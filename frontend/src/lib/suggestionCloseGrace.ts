// 空结果宽限（批 3b 防闪烁，自 useCommandSuggestions 纯搬移）：快速打词的
// 中间态常瞬时无匹配（"doc"→"dock"→"docker"），逐键即关即开会把浮层闪成
// 频闪灯。空结果先挂 150ms 宽限：窗口内下一次键入若重新命中则照常刷新
// （取消挂起关闭），真正无匹配才收起（VS Code 补全同款迟滞）。注意所有
// 「立即关」路径都应先走本机制的 cancel（调用方的 closeSuggestionsOnly
// 内统一取消），宽限只兜「打字中瞬时空洞」。

const SUGGESTION_CLOSE_GRACE_MS = 150;

export interface SuggestionCloseGrace {
  cancel: () => void;
  /** open=false 直接不挂起（宽限只对已打开的浮层兜底）。 */
  schedule: (open: boolean) => void;
}

export function createSuggestionCloseGrace(close: () => void): SuggestionCloseGrace {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(open: boolean) {
    cancel();
    if (!open) return;
    timer = setTimeout(() => {
      timer = undefined;
      close();
    }, SUGGESTION_CLOSE_GRACE_MS);
  }

  return { cancel, schedule };
}
