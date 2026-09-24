// ssh 结构化补全数据（OpenSSH 客户端；运维用户在本插件里最常敲的命令）。
//
// 数据来源：man 1 ssh 常用项，格式借鉴 fig 完成规范的 command/option/args
// 三层思路。裁剪原则：无子命令（ssh 本身无子命令树），只保留高频 flag；
// 目标 user@host 与端口等动态值一律 dynamic 提示。
import type { SpecCommand } from "../spec";

export const sshSpec: SpecCommand = {
  name: "ssh",
  description: "OpenSSH remote login client",
  flags: [
    { name: "port", short: "p", description: "Remote port", arg: "port" },
    { name: "identity", short: "i", description: "Private key file", arg: "path" },
    { name: "login", short: "l", description: "Login user", arg: "user" },
    { name: "local-forward", short: "L", description: "Local port forward", arg: "[bind:]port:host:hostport" },
    { name: "remote-forward", short: "R", description: "Remote port forward", arg: "[bind:]port:host:hostport" },
    { name: "dynamic-forward", short: "D", description: "SOCKS proxy on a local port", arg: "[bind:]port" },
    { name: "jump", short: "J", description: "Jump host chain", arg: "user@host[:port]" },
    { name: "option", short: "o", description: "Config option in ssh_config syntax", arg: "option" },
    { name: "no-exec", short: "N", description: "Do not run a remote command (forwarding only)" },
    { name: "background", short: "f", description: "Go to background after authentication" },
    { name: "force-pty", short: "t", description: "Force pseudo-terminal allocation" },
    { name: "no-pty", short: "T", description: "Disable pseudo-terminal allocation" },
    { name: "compress", short: "C", description: "Request compression" },
    { name: "agent-forwarding", short: "A", description: "Enable agent forwarding" },
    { name: "no-agent-forwarding", short: "a", description: "Disable agent forwarding" },
    { name: "x11-forwarding", short: "X", description: "Enable X11 forwarding" },
    { name: "no-x11-forwarding", short: "x", description: "Disable X11 forwarding" },
    { name: "config", short: "F", description: "Alternative config file", arg: "path" },
    { name: "ipv4", short: "4", description: "Use IPv4 addresses only" },
    { name: "ipv6", short: "6", description: "Use IPv6 addresses only" },
    { name: "verbose", short: "v", description: "Verbose mode (repeat for more)" },
    { name: "quiet", short: "q", description: "Quiet mode" },
  ],
  positional: { name: "user@host", dynamic: true },
};
