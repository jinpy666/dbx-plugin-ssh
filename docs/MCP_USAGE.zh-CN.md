# SSH MCP 使用指南

本插件向 MCP 客户端（ZCode、Claude 等 AI 代理）暴露 31 个 SSH/SFTP 工具：
远程命令、sudo 提权、文件传输、服务器指标与告警分诊。有两种接入方式，
协议细节与完整安全设计见 [SSH MCP 参考](MCP.zh-CN.md)。

## 两种接入方式

| | 方式一：DBX MCP 桥 | 方式二：独立 stdio 模式 |
| --- | --- | --- |
| 前提 | 安装插件并启动 DBX | 仅插件二进制，无需 DBX |
| 凭据 | DBX 解析已保存连接，不经工具参数 | 随调用内联传入（带 `connectionId` 时自动经桥转发） |
| 安全策略 | 审批、sudo 白名单、只读模式全部复用 | 四层门禁 + 进程级开关 |
| 适用 | 日常使用（推荐） | 独立自动化、CI、无 DBX 环境 |

## 方式一：DBX MCP 桥（推荐）

DBX 的 MCP 服务器（`dbx mcp` 或桌面内置 MCP）把插件工具聚合为三个 meta 工具：

| 工具 | 说明 |
| --- | --- |
| `dbx_plugin_list` | 列出所有贡献 MCP 工具的已装插件（含本插件 io.dbx.ssh 的 SSH/SFTP 工具，外部精简面声明 12 个） |
| `dbx_plugin_tools` | 列出一个插件的工具清单（JSON Schema、access 等级、是否需选连接） |
| `dbx_plugin_call` | 调用插件工具；传 `connectionId` 即引用 DBX 已保存的 SSH 连接，凭据由 DBX 解析转发 |

> 需 DBX MCP 设置插件工具模式为 `lazy`/`both`，并在 MCP 设置里对 io.dbx.ssh 完成插件级授权（access ceiling ≥ 工具声明等级），否则插件不出现在 `dbx_plugin_list`。详见 docs/MCP.zh-CN.md「方式一」。

客户端配置示例：

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

典型调用流：

```
dbx_plugin_list                            → 找到插件 id
dbx_plugin_tools { pluginId: "io.dbx.ssh" } → 发现 io.dbx.ssh 的工具
dbx_plugin_call {
  pluginId: "io.dbx.ssh",
  tool: "ssh_exec_sudo",
  connectionId: "<DBX 连接 id>",
  arguments: { "command": "systemctl status nginx" }
}
```

## 方式二：独立 stdio 模式

启动命令：

```bash
dbx-plugin-ssh --mcp
```

以 ZCode 为例，注册到用户级 `~/.zcode/cli/config.json`（本机路径属机器相关配置，
不放工作区共享配置）：

```json
{
  "mcp": {
    "servers": {
      "dbx-ssh": {
        "type": "stdio",
        "command": "/绝对路径/backend/target/release/dbx-plugin-ssh",
        "args": ["--mcp"]
      }
    }
  }
}
```

说明：

- `tools/list` 即 31 个工具，无需 DBX 在场。
- 此模式没有 DBX 连接存储，凭据随调用内联传入（`host`/`username`/`password`
  或 `privateKeyPath`，及跳板链、Quick Sudo 编排字段）。
- 带 `connectionId` / `connectionName` 的调用会自动转发给运行中的 DBX 应用执行
  （应用未运行会尝试唤起），凭据由应用侧解析，不经工具参数。
- 未知主机密钥采用 TOFU 首次信任（记录后变化仍拒绝）；首次确认也可以先在
  工作台连接一次。
- 数据目录默认 `/tmp/dbx-plugin-data/io.dbx.ssh`，可用 `DBX_PLUGIN_DATA_DIR`
  重定向（known_hosts、`mcp-settings.json`、Quick Sudo 全局配置都在其中）。

生产环境可以开只读入口（整个进程强制走只读门，工具无法自行关闭）：

```bash
DBX_SSH_MCP_READ_ONLY=1 dbx-plugin-ssh --mcp
```

## 连接寻址（免内联凭据）

连接类工具按以下顺序定位目标，凭据暴露面逐级增大：

1. **`connectionId`**（首选）：用 `ssh_list_connections` 列出已保存连接
   （仅元数据，任何密钥只出布尔标志位，绝不出值）。
2. **`connectionName` 或唯一 endpoint**：连接名重复时补充 `host` / `port` /
   `username` 收窄到唯一连接；也可以只传完整 endpoint（`host` + `username`，
   `port` 默认 22）复用已注册连接。匹配到多个候选时拒绝执行并列出候选，
   绝不猜选。
3. **内联凭据**（最后兜底）：凭据会进工具参数与 LLM 上下文，仅限本机可信会话。

## 工具速览（31 个）

### 远程执行

| 工具 | 用途 |
| --- | --- |
| `ssh_exec` | 非交互远程命令；只读连接仅放行白名单巡检命令；超过 ~10 秒的命令改用 `ssh_run_bg` |
| `ssh_exec_sudo` | sudo 提权执行，自动注入密码并应答 TOTP/2FA |
| `ssh_multi_exec` | 一条命令在最多 10 个已保存连接上聚合执行（并行/顺序） |
| `ssh_run_bg` | 长命令以 nohup 方式脱离会话启动，立即返回 `taskId`/`logPath` |
| `ssh_task_status` | 轮询后台任务：状态、退出码、输出尾部 |
| `ssh_terminal_input` | 向已打开的 DBX 终端注入交互输入（应答提示、Ctrl+C）；输出不收集 |

### 观测与诊断

| 工具 | 用途 |
| --- | --- |
| `ssh_metrics` | CPU/内存/磁盘/网络/进程指标；可用 `sections` 参数只取所需分片 |
| `ssh_test_connection` | 验证连通性与认证（含跳板链），返回延迟 |
| `ssh_alert_triage` | 告警分诊（离线，从不执行）：任意 schema 告警 → 分类 + 只读诊断命令清单 |

### 文件传输（SFTP）

| 工具 | 用途 |
| --- | --- |
| `sftp_list_dir` / `sftp_stat` / `sftp_exists` / `sftp_pwd` | 浏览与检查远端路径 |
| `sftp_read_file` / `sftp_write_file` | 读写远端文件（文本或 base64，支持 offset 分页） |
| `sftp_upload` / `sftp_download` | 本地 ↔ 远端单文件传输（受尺寸上限与本地路径约束） |
| `sftp_mkdir` / `sftp_remove` / `sftp_rename` / `sftp_chmod` | 目录与文件管理 |
| `sftp_copy` / `sftp_move` | 服务器内复制/移动（`from` 单值或数组） |
| `sftp_disk_usage` | 路径所在挂载的磁盘用量 |

### 连接与主机管理

| 工具 | 用途 |
| --- | --- |
| `ssh_list_connections` | 列出已保存连接元数据（id / name / host / port / username / authentication / readOnly） |
| `ssh_list_known_hosts` / `ssh_remove_known_host` | 插件 known_hosts 管理（不改系统文件） |
| `ssh_quick_sudo_profiles_list` / `_save` / `_delete` | Quick Sudo 全局档案（sudo 密码/TOTP 预设） |
| `ssh_close` | 关闭缓存的连接 |

## 典型用法

**服务器巡检**：

```
ssh_list_connections → ssh_metrics {connectionId, sections: ["cpu","memory","disks"]}
→ ssh_exec {connectionId, command: "df -h /data"}
```

**长任务**（包管理器、构建、备份）：

```
ssh_run_bg {connectionId, command: "apt upgrade -y"} → 得到 taskId/logPath
→ ssh_task_status {connectionId, logPath}   # 断线、换会话后仍可轮询
```

**告警 → 排查**：

```
ssh_alert_triage {payload: "<告警原文>"}     # → 分类 + 只读诊断命令清单
→ ssh_exec {connectionId, command: "<清单命令>"}  # 逐条执行
```

**文件分发**：

```
sftp_upload {connectionId, localPath, remotePath} → sftp_copy {connectionId, from, toDir}
```

## 安全边界

工具调用在执行前过四层门禁（全部在任何网络 I/O 之前）：

1. **只读连接写门**：连接勾选「只读」后，写类工具直接拒绝。
2. **只读命令白名单**：只读连接上的 `ssh_exec` 只放行可证明只读的巡检命令
   （白名单而非黑名单：识别不了 = 不放行）。
3. **敏感路径拒绝清单**：只读连接上命中凭据/私钥位置的路径即拒绝。
4. **危险命令确认**：命中灾难模式（`rm -rf /`、`mkfs`、`shutdown` 等）的命令
   要求显式 `confirmDestructive: true`；只读连接上直接拒绝。

另有操作者级开关：进程级只读（`DBX_SSH_MCP_READ_ONLY=1`）、每连接 sudo
命令白名单、权限档（`execPermissionMode`：写操作人工确认；`connectionScope`：
连接允许清单）、传输工具的本地路径约束。全部工具附带 MCP annotations
（`readOnlyHint` / `destructiveHint` 等），供客户端做只读预放行与确认分级。
细节见 [SSH MCP 参考](MCP.zh-CN.md)的「生产环境误操作防范」与「权限档」章节。

## 验证

离线冒烟（无需真实 SSH 服务）：

```bash
cargo build --release --manifest-path backend/Cargo.toml
python3 scripts/smoke_mcp.py --binary backend/target/release/dbx-plugin-ssh
```

真机回环（凭据走环境变量，不落盘）：

```bash
DBX_SSH_SMOKE_PASSWORD=… python3 scripts/smoke_mcp.py \
  --host <host> --port <port> --username <user>
```

涉及真实连接的参数必须显式提供；环境不可用时脚本按用例输出 `SKIP`，
离线通过不代表 live 连接通过。
