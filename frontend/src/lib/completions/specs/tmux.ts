// tmux 结构化补全数据（远程会话保持，SSH 运维高频）。
//
// 数据来源：man 1 tmux 常用项，格式借鉴 fig 完成规范的 command/option/args
// 三层思路。裁剪原则：会话/窗口/面板管理高频命令；session/window 目标动态。
import type { SpecCommand } from "../spec";

export const tmuxSpec: SpecCommand = {
  name: "tmux",
  description: "Terminal multiplexer",
  flags: [{ name: "color", description: "Colour mode", arg: "mode", values: ["on", "off", "auto"] }, { name: "socket", short: "S", description: "Alternative server socket", arg: "path" }],
  subcommands: [
    {
      name: "new-session",
      description: "Create a new session (alias: new)",
      flags: [
        { name: "session-name", short: "s", description: "Session name", arg: "name" },
        { name: "detached", short: "d", description: "Do not attach to the session" },
        { name: "window-name", short: "n", description: "Initial window name", arg: "name" },
        { name: "target", short: "t", description: "Target session/window", arg: "target" },
        { name: "width", short: "x", description: "Width when detached", arg: "columns" },
        { name: "height", short: "y", description: "Height when detached", arg: "lines" },
        { name: "attach", short: "A", description: "Attach if the session exists" },
      ],
    },
    {
      name: "attach-session",
      description: "Attach to an existing session (alias: attach)",
      flags: [
        { name: "target", short: "t", description: "Target session", arg: "session" },
        { name: "detach-other", short: "d", description: "Detach other clients" },
        { name: "read-only", short: "r", description: "Attach read-only" },
        { name: "working-directory", short: "c", description: "Start directory", arg: "path" },
      ],
      positional: { name: "session", dynamic: true },
    },
    { name: "list-sessions", description: "List sessions (alias: ls)", flags: [{ name: "format", description: "Output format", arg: "format" }] },
    { name: "kill-session", description: "Destroy a session", flags: [{ name: "target", short: "t", description: "Target session", arg: "session" }, { name: "all", short: "a", description: "Kill all but the given session" }] },
    { name: "kill-server", description: "Kill the tmux server and all sessions" },
    { name: "kill-window", description: "Destroy a window", flags: [{ name: "target", short: "t", description: "Target window", arg: "window" }] },
    { name: "detach-client", description: "Detach the current or named client (alias: detach)", flags: [{ name: "target", short: "t", description: "Target client", arg: "client" }, { name: "all", short: "a", description: "Detach all clients" }] },
    { name: "list-windows", description: "List windows (alias: lsw)", flags: [{ name: "target", short: "t", description: "Target session", arg: "session" }, { name: "format", description: "Output format", arg: "format" }] },
    { name: "list-panes", description: "List panes (alias: lsp)", flags: [{ name: "target", short: "t", description: "Target window", arg: "window" }, { name: "all", short: "a", description: "All panes in the session" }] },
    { name: "new-window", description: "Create a new window", flags: [{ name: "window-name", short: "n", description: "Window name", arg: "name" }, { name: "target", short: "t", description: "Target window index", arg: "target" }, { name: "detached", short: "d", description: "Do not select the window" }, { name: "working-directory", short: "c", description: "Start directory", arg: "path" }] },
    { name: "select-window", description: "Select a window", flags: [{ name: "target", short: "t", description: "Target window", arg: "window" }, { name: "next", short: "n", description: "Next window" }, { name: "previous", short: "p", description: "Previous window" }, { name: "last", short: "l", description: "Last selected window" }] },
    { name: "select-pane", description: "Select a pane", flags: [{ name: "target", short: "t", description: "Target pane", arg: "pane" }, { name: "up", short: "U", description: "Pane above" }, { name: "down", short: "D", description: "Pane below" }, { name: "left", short: "L", description: "Pane to the left" }, { name: "right", short: "R", description: "Pane to the right" }, { name: "last", short: "l", description: "Last selected pane" }] },
    {
      name: "split-window",
      description: "Split a pane in two (alias: split)",
      flags: [
        { name: "horizontal", short: "h", description: "Split left/right (full height)" },
        { name: "vertical", short: "v", description: "Split top/bottom (default)" },
        { name: "target", short: "t", description: "Target pane", arg: "pane" },
        { name: "percentage", short: "p", description: "Size as a percentage", arg: "percent" },
        { name: "working-directory", short: "c", description: "Start directory", arg: "path" },
        { name: "detached", short: "d", description: "Do not focus the new pane" },
      ],
    },
    { name: "resize-pane", description: "Resize a pane", flags: [{ name: "up", short: "U", description: "Resize upward", arg: "lines" }, { name: "down", short: "D", description: "Resize downward", arg: "lines" }, { name: "left", short: "L", description: "Resize leftwards", arg: "cells" }, { name: "right", short: "R", description: "Resize rightwards", arg: "cells" }, { name: "zoom", short: "Z", description: "Toggle pane zoom" }] },
    { name: "send-keys", description: "Send keystrokes to a pane", flags: [{ name: "target", short: "t", description: "Target pane", arg: "pane" }, { name: "literal", short: "l", description: "Keys are literal characters" }, { name: "hex", short: "H", description: "Keys are hexadecimal" }, { name: "enter", description: "Press Enter after the keys" }], positional: { name: "keys", dynamic: true } },
    { name: "capture-pane", description: "Capture pane contents", flags: [{ name: "target", short: "t", description: "Target pane", arg: "pane" }, { name: "print", short: "p", description: "Print to stdout" }, { name: "history", short: "S", description: "Start line (- = start of history)", arg: "line" }, { name: "end", short: "E", description: "End line", arg: "line" }] },
    { name: "display-message", description: "Display a message in the status line (alias: display)", flags: [{ name: "target", short: "t", description: "Target client", arg: "client" }, { name: "print", short: "p", description: "Print to stdout" }], positional: { name: "message", dynamic: true } },
    { name: "set-option", description: "Set a session option (alias: set)", flags: [{ name: "global", short: "g", description: "Set the global option" }, { name: "unset", short: "u", description: "Unset the option" }, { name: "target", short: "t", description: "Target session", arg: "session" }], positional: { name: "option", dynamic: true } },
    { name: "show-options", description: "Show session options (alias: show)", flags: [{ name: "global", short: "g", description: "Show global options" }, { name: "value", short: "v", description: "Print only the value" }, { name: "target", short: "t", description: "Target session", arg: "session" }], positional: { name: "option", dynamic: true } },
    { name: "source-file", description: "Execute commands from a file", positional: { name: "path", dynamic: true } },
    { name: "has-session", description: "Check a session exists", flags: [{ name: "target", short: "t", description: "Target session", arg: "session" }] },
    { name: "rename-session", description: "Rename a session", flags: [{ name: "target", short: "t", description: "Target session", arg: "session" }], positional: { name: "new-name", dynamic: true } },
    { name: "rename-window", description: "Rename a window", flags: [{ name: "target", short: "t", description: "Target window", arg: "window" }], positional: { name: "new-name", dynamic: true } },
    { name: "copy-mode", description: "Enter copy mode", flags: [{ name: "target", short: "t", description: "Target pane", arg: "pane" }, { name: "begin-selection", description: "Start a selection" }, { name: "cancel", description: "Leave copy mode" }] },
    { name: "respawn-pane", description: "Restart a pane's command", flags: [{ name: "kill", short: "k", description: "Kill existing command" }, { name: "target", short: "t", description: "Target pane", arg: "pane" }] },
    { name: "run-shell", description: "Run a shell command (alias: run)", flags: [{ name: "target", short: "t", description: "Target pane for output", arg: "pane" }, { name: "delay", short: "d", description: "Delay between outputs", arg: "ms" }], positional: { name: "command", dynamic: true } },
  ],
};
