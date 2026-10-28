# SSH MCP Guide

The plugin exposes 31 SSH/SFTP MCP tools to MCP clients (ZCode, Claude, or any
AI agent): remote commands, sudo elevation, file transfer, server metrics, and
alert triage. Two ways to connect. Protocol details and the full safety model
live in the [SSH MCP reference](MCP.zh-CN.md).

## Two ways to connect

| | Option 1: DBX MCP bridge | Option 2: standalone stdio |
| --- | --- | --- |
| Prerequisites | Plugin installed, DBX running | Plugin binary only, no DBX |
| Credentials | Resolved host-side from saved connections; never in tool arguments | Passed inline per call (auto-forwarded through the bridge when a `connectionId` is given) |
| Safety policies | Approvals, sudo allowlists, and read-only mode are all reused | Four gate layers + process-level switches |
| Best for | Everyday use (recommended) | Standalone automation, CI, DBX-free environments |

## Option 1: DBX MCP bridge (recommended)

DBX's MCP server (`dbx mcp` or the desktop built-in MCP) aggregates plugin
tools behind three meta tools:

| Tool | Purpose |
| --- | --- |
| `dbx_plugin_list` | List every installed plugin that contributes MCP tools (including this plugin's SSH/SFTP tools — 12 declared on the trimmed external surface) |
| `dbx_plugin_tools` | List one plugin's tools (JSON Schema, access level, connection requirement) |
| `dbx_plugin_call` | Call a plugin tool; pass a `connectionId` to reference a saved SSH connection — credentials are resolved host-side |

> Requires the MCP plugin-tools mode set to `lazy`/`both` in DBX settings, plus a
> per-plugin grant for io.dbx.ssh (access ceiling ≥ the tool's declared level);
> otherwise the plugin stays hidden from `dbx_plugin_list`. See
> docs/MCP.zh-CN.md ("方式一") for details.

Client configuration example:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "/path/to/dbx",
      "args": ["mcp"]
    }
  }
}
```

Typical call flow:

```
dbx_plugin_list                            → find the plugin id
dbx_plugin_tools { pluginId: "io.dbx.ssh" } → discover io.dbx.ssh tools
dbx_plugin_call {
  pluginId: "io.dbx.ssh",
  tool: "ssh_exec_sudo",
  connectionId: "<DBX connection id>",
  arguments: { "command": "systemctl status nginx" }
}
```

## Option 2: standalone stdio mode

Launch command:

```bash
dbx-plugin-ssh --mcp
```

ZCode example — register in the user-level `~/.zcode/cli/config.json`
(machine-specific paths belong in user config, not shared workspace config):

```json
{
  "mcp": {
    "servers": {
      "dbx-ssh": {
        "type": "stdio",
        "command": "/absolute/path/backend/target/release/dbx-plugin-ssh",
        "args": ["--mcp"]
      }
    }
  }
}
```

Notes:

- `tools/list` returns all 31 tools; no DBX required.
- This mode has no DBX connection store, so credentials travel inline per call
  (`host`/`username`/`password` or `privateKeyPath`, plus jump-chain and
  Quick Sudo orchestration fields).
- Calls carrying a `connectionId` / `connectionName` are automatically
  forwarded to the running DBX app (which is launched on demand); credentials
  are resolved app-side and never appear in tool arguments.
- Unknown host keys use TOFU trust-on-first-use (a later change is still
  rejected); you can also confirm the key once from the workbench.
- The data directory defaults to `/tmp/dbx-plugin-data/io.dbx.ssh` and can be
  redirected with `DBX_PLUGIN_DATA_DIR` (known_hosts, `mcp-settings.json`,
  and global Quick Sudo profiles live there).

For production hosts, expose a read-only entry point (the whole process is
forced through the read-only gate; tools cannot turn it off):

```bash
DBX_SSH_MCP_READ_ONLY=1 dbx-plugin-ssh --mcp
```

## Connection addressing (no inline credentials)

Connection-bound tools resolve their target in this order, with a growing
credential exposure footprint:

1. **`connectionId`** (preferred): list saved connections with
   `ssh_list_connections` (metadata only; secrets appear solely as boolean flags).
2. **`connectionName` or a unique endpoint**: disambiguate duplicate names with
   `host` / `port` / `username`; a complete endpoint (`host` + `username`,
   `port` defaults to 22) also reuses a registered connection. Multiple
   candidates are refused with the candidate list — never guessed.
3. **Inline credentials** (last resort): credentials enter tool arguments and
   the LLM context; use only in trusted local sessions.

## Tool catalog (31 tools)

### Remote execution

| Tool | Purpose |
| --- | --- |
| `ssh_exec` | Non-interactive remote command; read-only connections allow whitelisted inspection commands; use `ssh_run_bg` for anything longer than ~10s |
| `ssh_exec_sudo` | Privileged execution with automatic password injection and TOTP/2FA answering |
| `ssh_multi_exec` | Run one command on up to 10 saved connections (parallel or sequential) |
| `ssh_run_bg` | Start a long command detached (nohup); returns `taskId`/`logPath` immediately |
| `ssh_task_status` | Poll a background task: state, exit code, output tail |
| `ssh_terminal_input` | Inject interactive input (prompt answers, Ctrl+C) into the open DBX terminal; output is not collected |

### Observation and diagnostics

| Tool | Purpose |
| --- | --- |
| `ssh_metrics` | CPU/memory/disk/network/process metrics; use the `sections` parameter to fetch only the slices you need |
| `ssh_test_connection` | Verify connectivity and authentication (including jump chains), returns latency |
| `ssh_alert_triage` | Alert triage (offline, never executes): any-schema alert → classification + read-only diagnostic playbook |

### File transfer (SFTP)

| Tool | Purpose |
| --- | --- |
| `sftp_list_dir` / `sftp_stat` / `sftp_exists` / `sftp_pwd` | Browse and inspect remote paths |
| `sftp_read_file` / `sftp_write_file` | Read/write remote files (text or base64, offset paging) |
| `sftp_upload` / `sftp_download` | Single-file local ↔ remote transfer (size caps and local-path constraints apply) |
| `sftp_mkdir` / `sftp_remove` / `sftp_rename` / `sftp_chmod` | Directory and file management |
| `sftp_copy` / `sftp_move` | Server-side copy/move (`from` accepts one path or an array) |
| `sftp_disk_usage` | Filesystem usage for the mount holding a path |

### Connection and host management

| Tool | Purpose |
| --- | --- |
| `ssh_list_connections` | List saved connections (id / name / host / port / username / authentication / readOnly) |
| `ssh_list_known_hosts` / `ssh_remove_known_host` | Plugin known_hosts management (system files are never touched) |
| `ssh_quick_sudo_profiles_list` / `_save` / `_delete` | Global Quick Sudo profiles (sudo password/TOTP presets) |
| `ssh_close` | Close a cached connection |

## Typical workflows

**Server inspection**:

```
ssh_list_connections → ssh_metrics {connectionId, sections: ["cpu","memory","disks"]}
→ ssh_exec {connectionId, command: "df -h /data"}
```

**Long-running jobs** (package managers, builds, backups):

```
ssh_run_bg {connectionId, command: "apt upgrade -y"} → taskId/logPath
→ ssh_task_status {connectionId, logPath}   # survives disconnects and new sessions
```

**Alert → triage**:

```
ssh_alert_triage {payload: "<raw alert>"}     # → classification + read-only playbook
→ ssh_exec {connectionId, command: "<playbook command>"}  # run step by step
```

**File distribution**:

```
sftp_upload {connectionId, localPath, remotePath} → sftp_copy {connectionId, from, toDir}
```

## Safety model

Every tool call passes four gate layers before execution (all before any
network I/O):

1. **Read-only connection write gate**: write tools are refused outright on
   connections flagged read-only.
2. **Read-only command allowlist**: on read-only connections `ssh_exec` only
   allows provably read-only inspection commands (allowlist, not blocklist:
   unrecognized means refused).
3. **Sensitive-path denial list**: on read-only connections, paths hitting
   credential/private-key locations are refused.
4. **Destructive-command confirmation**: commands matching catastrophic
   patterns (`rm -rf /`, `mkfs`, `shutdown`, …) require an explicit
   `confirmDestructive: true`; read-only connections refuse them outright.

Operator-level switches on top: process-wide read-only
(`DBX_SSH_MCP_READ_ONLY=1`), per-connection sudo command allowlists, permission
modes (`execPermissionMode`: human approval for writes; `connectionScope`:
connection allowlist), and local-path constraints on transfer tools. Every tool
carries MCP annotations (`readOnlyHint` / `destructiveHint`, …) so clients can
pre-approve read-only tools and gate destructive ones. See the
[SSH MCP reference](MCP.zh-CN.md) for the full model.

## Verification

Offline smoke (no real SSH server needed):

```bash
cargo build --release --manifest-path backend/Cargo.toml
python3 scripts/smoke_mcp.py --binary backend/target/release/dbx-plugin-ssh
```

Live loopback (credentials travel via environment variables, never on disk):

```bash
DBX_SSH_SMOKE_PASSWORD=… python3 scripts/smoke_mcp.py \
  --host <host> --port <port> --username <user>
```

Parameters for live sections must be provided explicitly; the script prints
`SKIP` per section when the environment is unavailable — offline success does
not imply live success.
