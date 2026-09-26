# 终端

[![CI](https://github.com/jinpy666/dbx-plugin-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/jinpy666/dbx-plugin-ssh/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jinpy666/dbx-plugin-ssh?display_name=tag)](https://github.com/jinpy666/dbx-plugin-ssh/releases)

[English](README.en.md) · [产品宣传页](docs/MEDIA.zh-CN.md) · [特性与竞品对比](docs/COMPARISON.zh-CN.md) · [独立仓库迁移说明](docs/REPOSITORY_SPLIT.zh-CN.md)

终端（Terminal）是面向现代运维团队的服务器终端：打开一个连接，就能完成终端操作、
文件传输、跳板访问、受控提权和 MCP 自动化。它把“登录服务器之后的下一小时”压缩成
一个连贯、可审计、可复用的工作流。

> Terminal · SFTP · Remote Operations：终端、文件、自动化和受控运维操作集中在一个 DBX 终端面板中。

## 先看效果

[观看 87 秒真实操作演示（点击在线播放）](docs/media/dbx-ssh-live-demo.mp4) ·
[观看 15 秒功能预览](docs/media/dbx-ssh-demo.mp4)

![DBX SSH & SFTP 产品总览](docs/media/dbx-ssh-overview.png)

如果你正在工具之间来回切换：终端一个窗口、SFTP 一个窗口、跳板机靠配置文件、
自动化又要另写脚本，那么 DBX SSH & SFTP 的价值很直接——连接、终端、文件和自动化
都围绕同一个 DBX 连接上下文工作。

## 为什么值得用

| 你要完成的事 | DBX SSH & SFTP 给你的体验 |
| --- | --- |
| 快速处理线上问题 | PTY 终端、命令历史、快速命令、可取消命令和目录跟随 |
| 安全地传文件 | SFTP 预览、拖放、断点确认、进度、取消和原子替换 |
| 进入私网服务器 | 最多三跳 ProxyJump、连接保活和 Known Hosts 校验 |
| 限制高风险操作 | 只读模式、sudo 来源选择、命令白名单和宿主 secret binding |
| 把重复工作自动化 | MCP 工具复用连接、审批和权限边界 |

## 适合场景

- 日常 Linux/Unix 服务器巡检、日志查看和远程命令执行。
- 通过跳板机访问内网环境，并在终端与 SFTP 之间快速切换。
- 在受控权限下完成配置文件、脚本和构建产物的上传下载。

## 核心能力

- 支持密码、私钥、SSH Agent、键盘交互和无密码认证。
- 交互式终端支持 PTY、窗口调整、会话恢复、剪贴板、远程目录跟随和批量输入。
- 工具栏“复制会话”可在当前已认证 SSH 连接上打开独立终端，无需再次输入堡垒机动态令牌；“新建会话”仍会建立全新连接并重新认证。
- SFTP 支持浏览、排序、预览、上传、下载、重命名、新建、拖放和递归删除；聚焦 SFTP 面板后按 Ctrl/Cmd+V，可把系统剪贴板中的本地文件直接上传到当前目录。
- 大文件传输支持进度、取消、断点确认和原子替换，降低中断造成的半成品风险。
- 支持 Known Hosts 校验、变更主机密钥拒绝、只读模式和远程目录磁盘用量查看。
- 支持最多三跳 ProxyJump、连接保活、可取消远程命令、chmod 和 Quick Sudo。
- 支持 TOTP/键盘交互式双因素认证；手机、硬件令牌或短信动态码可在连接时通过密文弹窗输入，无需保存当前六位码。另提供面向自动化客户端的 MCP 工具接口。
- 界面支持简体中文、繁体中文、英语、西班牙语、意大利语、日语和葡萄牙语。

系统剪贴板文件粘贴使用宿主/浏览器提供的原生 `paste` 文件事件；若当前宿主不暴露该事件，仍可使用 Upload 按钮或拖放上传。

完整的能力矩阵和与 OpenSSH、Tabby、Termius、FinalShell 等方案的定位对比见
[特性与竞品对比](docs/COMPARISON.zh-CN.md)。

> **协议路线**：当前版本聚焦 SSH/SFTP 运维；RDP、Telnet 等协议支持仍在持续加强，
> 后续会逐步补齐更多远程访问场景，请以对应版本发布说明为准。

更多截图见[产品宣传页](docs/MEDIA.zh-CN.md)。

## MCP 自动化

插件内置 31 个 MCP 工具——远程命令、sudo 提权、SFTP 文件、服务器指标、告警分诊——
让 AI 编码代理（ZCode、Claude 等任何 MCP 客户端）在你的权限边界内操作服务器。
支持两种接入方式：

**方式一：DBX MCP 桥（推荐）**。DBX 的 MCP 服务器内置 `dbx_list_plugin_tools` /
`dbx_call_plugin_tool` 两个通用桥工具，可发现并调用已装插件的全部 MCP 工具。
传 `connectionId` 即引用 DBX 已保存的 SSH 连接，凭据由 DBX 解析转发，
工具参数中不出现任何密码，审批、sudo 白名单与只读模式照常生效。

**方式二：独立 stdio 模式**。无需 DBX 在场，把插件二进制直接注册为 MCP 服务器：

```json
{
  "mcp": {
    "servers": {
      "dbx-ssh": {
        "type": "stdio",
        "command": "/绝对路径/dbx-plugin-ssh",
        "args": ["--mcp"]
      }
    }
  }
}
```

生产环境可以开一个只读 MCP 入口（整个进程强制走只读门，工具无法自行关闭）：

```bash
DBX_SSH_MCP_READ_ONLY=1 dbx-plugin-ssh --mcp
```

| 任务 | 工具 |
| --- | --- |
| 远程巡检 | `ssh_exec`、`ssh_metrics`、`sftp_list_dir`、`ssh_test_connection` |
| 特权操作 | `ssh_exec_sudo`（自动应答 TOTP）、Quick Sudo 档案 |
| 长任务 | `ssh_run_bg` + `ssh_task_status`（断线、换会话不丢） |
| 文件传输 | `sftp_upload` / `sftp_download` / `sftp_read_file` / `sftp_write_file` |
| 告警排查 | `ssh_alert_triage` → 只读诊断命令清单 → `ssh_exec` 执行 |

完整配置、连接寻址（免内联凭据）、工具清单与安全边界见
[MCP 使用指南](docs/MCP_USAGE.zh-CN.md)与[SSH MCP 参考](docs/MCP.zh-CN.md)。

## 安全设计

密码、私钥口令、TOTP 和 sudo 凭据由 DBX 宿主 secret binding 管理。连接期人工输入的动态令牌只用于当次认证，不会持久化或写入日志。插件不会把
凭据写入配置文件、日志或导出内容。建议生产连接启用 Known Hosts 严格校验，
并按需启用只读模式和 sudo 命令白名单。

## 安装

从 [GitHub Releases](https://github.com/jinpy666/dbx-plugin-ssh/releases) 下载匹配平台的
`.dbxp` 包，在 DBX 插件中心选择本地安装。开发者也可以按照
[迁移与发布说明](docs/REPOSITORY_SPLIT.zh-CN.md) 构建候选包。

## 开发与验证

```bash
pnpm --dir frontend install
pnpm --dir frontend typecheck && pnpm --dir frontend test && pnpm --dir frontend build
cargo test --manifest-path backend/Cargo.toml
python3 scripts/validate_repo.py && node scripts/connection-forms/verify.mjs
scripts/test.sh --skip-host
```

协议、构建和完整集成验证说明位于 `docs/`。公开贡献前请先阅读
[迁移说明](docs/REPOSITORY_SPLIT.zh-CN.md)，了解独立仓库的迁移边界、公共依赖和发布前置条件。
