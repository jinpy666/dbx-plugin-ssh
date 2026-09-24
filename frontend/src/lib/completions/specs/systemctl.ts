// systemctl 结构化补全数据（systemd 服务管理，运维高频）。
//
// 数据来源：man 1 systemctl 常用项，格式借鉴 fig 完成规范的
// command/option/args 三层思路。裁剪原则：动词作为子命令层；unit 名动态。
import type { SpecCommand } from "../spec";

export const systemctlSpec: SpecCommand = {
  name: "systemctl",
  description: "Control the systemd system and service manager",
  flags: [
    { name: "now", description: "Start/stop the unit in the same operation" },
    { name: "user", description: "Talk to the user service manager" },
    { name: "system", description: "Talk to the system service manager" },
    { name: "no-pager", description: "Do not pipe output into a pager" },
    { name: "full", short: "l", description: "Do not truncate output" },
    { name: "all", short: "a", description: "Show all loaded units" },
    { name: "failed", description: "Show only failed units" },
    { name: "quiet", short: "q", description: "Suppress output where possible" },
    { name: "type", short: "t", description: "Unit type filter", arg: "type", values: ["service", "socket", "timer", "mount", "target", "device", "automount", "path", "scope", "slice"] },
    { name: "state", description: "Unit load/state filter", arg: "state" },
    { name: "no-legend", description: "Do not print the legend" },
    { name: "root", description: "Operate on a filesystem root", arg: "path" },
  ],
  subcommands: [
    { name: "status", description: "Show runtime status of units", positional: { name: "unit", dynamic: true } },
    { name: "start", description: "Start units", positional: { name: "unit", dynamic: true } },
    { name: "stop", description: "Stop units", positional: { name: "unit", dynamic: true } },
    { name: "restart", description: "Restart units", positional: { name: "unit", dynamic: true } },
    { name: "reload", description: "Reload unit configs without restarting", positional: { name: "unit", dynamic: true } },
    { name: "reload-or-restart", description: "Reload or restart units", positional: { name: "unit", dynamic: true } },
    { name: "try-restart", description: "Restart only if running", positional: { name: "unit", dynamic: true } },
    { name: "enable", description: "Enable units at boot", positional: { name: "unit", dynamic: true } },
    { name: "disable", description: "Disable units at boot", positional: { name: "unit", dynamic: true } },
    { name: "mask", description: "Make units impossible to start", positional: { name: "unit", dynamic: true } },
    { name: "unmask", description: "Unmask units", positional: { name: "unit", dynamic: true } },
    { name: "is-active", description: "Check whether units are active", positional: { name: "unit", dynamic: true } },
    { name: "is-enabled", description: "Check whether units are enabled", positional: { name: "unit", dynamic: true } },
    { name: "is-failed", description: "Check whether units are failed", positional: { name: "unit", dynamic: true } },
    { name: "list-units", description: "List loaded units", flags: [{ name: "state", description: "State filter", arg: "state" }] },
    { name: "list-unit-files", description: "List installed unit files", flags: [{ name: "type", short: "t", description: "Unit type filter", arg: "type" }] },
    { name: "list-timers", description: "List timers", flags: [{ name: "all", short: "a", description: "Include inactive timers" }] },
    { name: "list-sockets", description: "List sockets" },
    { name: "daemon-reload", description: "Reload systemd manager configuration" },
    { name: "daemon-reexec", description: "Re-execute the systemd manager" },
    { name: "show", description: "Show unit/manager properties", flags: [{ name: "property", short: "p", description: "Property to show", arg: "name" }] },
    { name: "cat", description: "Show the unit file contents", positional: { name: "unit", dynamic: true } },
    { name: "edit", description: "Edit a unit file (drop-in)", positional: { name: "unit", dynamic: true } },
    { name: "kill", description: "Send a signal to unit processes", flags: [{ name: "signal", short: "s", description: "Signal to send", arg: "signal" }], positional: { name: "unit", dynamic: true } },
    { name: "reset-failed", description: "Reset failed unit state" },
    { name: "set-default", description: "Set the default target", positional: { name: "target", dynamic: true } },
    { name: "get-default", description: "Print the default target" },
  ],
};
