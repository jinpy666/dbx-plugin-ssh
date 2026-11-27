// Docker 面板「在终端打开」（M3 遗留 6）的 window 事件处理器。
//
// DockerPanel 挂在 SideNavPanel 内（后者不透传事件且不在本次改动范围），
// 面板经 window 自定义事件把命令字符串直达 App；走与建议浮层同款的
// 「填入输入行不回车」通道（replaceTerminalLineWith）：命令落在 shell 输入
// 行原地，用户确认后自行回车。无终端会话时 toast 提示先连接，不静默丢弃。
// B1 从 App.vue 原样外抽：只有接线搬了家，判断与写入顺序不变。

export interface DockerOpenInTerminalContext {
  /** 当前是否存在任一可写入的终端会话（ssh / local / serial / telnet）。 */
  hasTerminalSession: () => boolean;
  /** 当前 xterm 实例；尚未创建时为 undefined/null。 */
  terminal: () => { focus: () => void } | null | undefined;
  /** 把命令填进 shell 输入行（不回车）。 */
  replaceLine: (command: string) => void;
  /** 无终端会话时的提示（由 App 侧 toast 呈现）。 */
  notifyNoSession: () => void;
}

export function useDockerOpenInTerminal(context: DockerOpenInTerminalContext) {
  return function handleDockerOpenInTerminal(event: Event): void {
    const command = (event as CustomEvent<{ command?: string }>).detail?.command ?? "";
    if (!command) return;
    const terminal = context.terminal();
    if (!terminal || !context.hasTerminalSession()) {
      context.notifyNoSession();
      return;
    }
    context.replaceLine(command);
    terminal.focus();
  };
}
