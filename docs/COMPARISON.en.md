# Feature and solution comparison

This is a product-positioning comparison, not a benchmark, price comparison, or security
audit. Third-party capabilities vary by version, platform, plugins, and commercial plan.
“—” means the capability is not a core built-in workflow; “external” means it normally
requires a CLI, plugin, or additional configuration. Third-party labels reflect public product
positioning and should be verified against the target platform and exact version before adoption.

## Capability matrix

| Capability | DBX SSH & SFTP | OpenSSH + sftp | Tabby | Termius | FinalShell | electerm | iSHell Pro |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Graphical connection management | Built in | — | Built in | Built in | Built in | Built in | Built in/mobile |
| Interactive PTY terminal | Built in | Built-in terminal | Built in | Built in | Built in | Built in | Built in |
| Split panes / multiple shells in one window | Via DBX host workbench | External tool (tmux etc.) | Built in | Version dependent | Version dependent | Built in/version dependent | Built in/version dependent |
| Custom themes / terminal appearance | Follows the DBX host theme | — | Built in (theme/plugin ecosystem) | Version dependent | Version dependent | Built in/version dependent | Version dependent |
| SFTP file workspace | Built in | External `sftp`/client | Built in/version dependent | Built in/plan dependent | Built in | Built in | Built in/version dependent |
| SSH Agent / key / password auth | Built in | Built in | Built in/config dependent | Built in/plan dependent | Built in | Built in | Built in |
| Jump hosts / ProxyJump | Up to three hops | Built in | Config/plugin dependent | Supported/plan dependent | Supported/version dependent | Supported/config dependent | Supported/version dependent |
| Known Hosts and changed-key rejection | Built in | Built in | Configuration dependent | Supported/config dependent | Supported/config dependent | Supported/config dependent | Supported/version dependent |
| Port forwarding / SOCKS | Built in -L/-R (dynamic tunnels via the DBX host) | Built in | Built in (-L/-R/-D/X11) | Supported/plan dependent | Supported/version dependent | Supported/config dependent | Supported/version dependent |
| Read-only and command safety gates | Built in | Shell/system policy | Plugin/manual policy | Configuration/plan dependent | Manual policy | Manual policy | Config/manual policy |
| Quick Sudo / TOTP interaction | Built in | External scripts/terminal flow | Plugin/script | Supported/plan dependent | Supported/version dependent | Terminal flow/version dependent | Terminal flow/version dependent |
| File preview, drag/drop, resumable transfer | Built in | External tool | Plugin/version dependent | Built in/plan dependent | Built in | Built in/version dependent | Built in/version dependent |
| Zmodem / Trzsz transfer | Built in | External tool | Built in | — | Version dependent | Built in | Version dependent |
| Session recording / replay / GIF export | Built in | External tool | Plugin/script dependent | — | Version dependent | Plugin/version dependent | Version dependent |
| Command efficiency (history / quick commands / keyword highlight) | Built in | — | Plugin/config dependent | Built in/version dependent | Version dependent | Version dependent | Version dependent |
| Batch commands across sessions | Built in | External tool | Plugin/config dependent | Version dependent | Version dependent | Built in/version dependent | Version dependent |
| Connection sync / multi-device workflow | DBX host workbench | — | Built in (account sync)/version dependent | Core selling point/plan dependent | Version dependent | Cross-platform desktop | Mobile-first |
| MCP automation tools | Built in | — | — | — | — | — | — |
| DBX host secret binding | Native | — | — | — | — | — | — |
| RDP | Improving | External tool | Plugin/version dependent | Supported/plan dependent | Supported/version dependent | Version dependent | Version dependent |
| Telnet | Improving | External `telnet` | Plugin/version dependent | Supported/version dependent | Supported/version dependent | Built in/version dependent | Version dependent |
| Serial | Planned or version dependent | External tool | Plugin/version dependent | Version dependent | Version dependent | Version dependent | Mobile/version dependent |
| Seven-language plugin UI | Built in | — | Partial/version dependent | Partial/plan dependent | Partial/version dependent | Version dependent | Version dependent |

> **Protocol roadmap**: DBX SSH & SFTP currently focuses on SSH, SFTP, ProxyJump, PTY, and
> governed server operations. RDP, Telnet, and additional remote protocols are still being
> strengthened. “Improving” does not mean a complete production-ready replacement is already
> guaranteed; verify the exact capability in the release notes for your target version.

## Positioning versus Tabby

Tabby is a general-purpose terminal: its strengths are terminal tabs and split panes,
theme/color customization with a plugin ecosystem, multi-protocol support (Telnet/serial),
and cross-device config sync. DBX SSH & SFTP differs on the server operations chain:

- Stronger authentication and privilege-escalation orchestration: global Quick Sudo
  profiles, TOTP/2FA auto-answer, sudo allowlists, read-only gates, and host secret
  binding are all built in; Tabby usually relies on plugins or scripts.
- 31 built-in MCP automation tools let AI clients operate servers inside the same
  connection and permission boundary.
- Session recording/replay with GIF export, batch commands across sessions, resumable
  transfers, and Zmodem/Trzsz are built in.
- Up to three-hop ProxyJump with per-hop authentication, 2FA, and host-key verification.
- Port mapping -L/-R is built in (0.6.0); dynamic SOCKS tunnels, agent forwarding, X11,
  GSSAPI, and ControlMaster are intentionally not built — covered by the DBX host
  transport layer or set aside by product decisions.
- Terminal split panes and custom themes currently follow the DBX host workbench;
  additional protocols (RDP/Telnet/serial) remain on the roadmap.

## Position in the DBX plugin family

| Plugin | Primary object | Best for |
| --- | --- | --- |
| Terminal | SSH hosts, terminals, SFTP, remote operations | Log in, run commands, browse and transfer files |
| DBX Files | File systems and object storage | Browse, upload/download, archive, and organize storage |
| DBX LDAP | LDAP directories | Search, aggregate, and edit directory entries |
| DBX Kafka | Kafka clusters | Topics, messages, consumer groups, and schemas |

Terminal does not duplicate the dedicated Files, LDAP, or Kafka protocols. It focuses on
terminal and SFTP operations after reaching a host over SSH, while reusing DBX connection,
secret, and workbench boundaries.

## Choosing a solution

- For script-only SSH, choose OpenSSH; it is lightweight and leaves automation boundaries to
  shell and system policy.
- For terminal tabs, split panes, and theme customization, Tabby is a general terminal
  option; its security controls depend on plugins and configuration.
- For cross-device connection synchronization, Termius is more cloud/commercial oriented;
  exact capabilities depend on its version and plan.
- For a desktop tool combining SSH, SFTP, and server status, FinalShell is one direct option.
- If you already use DBX host connections, MCP, and plugin workbenches, DBX SSH & SFTP keeps
  those workflows inside the same connection and permission boundary.
- If you need RDP, Telnet, or additional protocols, follow the DBX roadmap; those capabilities
  are actively being strengthened and should be checked against the release notes for the
  version you plan to deploy.
