// Windows shell 内建命令候选（用户反馈：SSH/本地连 Windows 时 cmd/PowerShell
// 无提示）。fig 全量语料不含 PowerShell cmdlet 与 cmd 内建命令——解析层
// pass-through 后由此兜底：提示符采样（`PS C:\…>` / `C:\…>`）判定 shell 种类，
// 命令名位（行首单 token）按前缀给内建候选。
//
// 接缝纪律：以 FigCompletionSource 包装器形态叠在引擎 runner 外侧（worker
// 在内、检测回调在 App 主线程），CompletionController 无感；detect 不可用时
// 行为与直连引擎完全一致。任何异常吞掉，绝不影响 PTY 输入链路。

import { splitCommandLine } from "../core/tokenize";
import type { CompletionContext, CompletionItem, CompletionResponse } from "../core/types";
import type { ShellKind } from "../core/types";
import type { FigCompletionSource, FigSourceRequest } from "../fig/source";

export type WindowsShellKind = Extract<ShellKind, "powershell" | "cmd">;

/**
 * 提示符行 → shell 种类。只认带盘符路径的提示符形态，`>` 之后可跟已键入
 * 文本（采样行可能是光标行）：
 * - `PS C:\Users\x>` / `PS C:\>dir ` → powershell（先判，避免被 cmd 规则吃掉）
 * - `C:\Users\x>` / `D:\>cd ` → cmd
 *
 * cmd 规则要求 `>` 紧贴路径文本（真实提示符 `…x>`/`…\>` 均无空格），避免把
 * 「路径开头 + 重定向」的输出行（`C:\tools\run.exe > out.txt`）误判为提示符。
 */
export function detectShellKind(promptLine: string): WindowsShellKind | null {
  const line = String(promptLine ?? "");
  if (/^\s*PS\s+[A-Za-z]:\\/.test(line)) return "powershell";
  if (/^\s*[A-Za-z]:\\(?:[^\r\n>]*[^\s>])?>/.test(line)) return "cmd";
  return null;
}

/** PowerShell 高频 cmdlet 与别名（label → 简述）。 */
const POWERSHELL_BUILTINS: ReadonlyArray<readonly [string, string]> = [
  ["Get-ChildItem", "List directory contents (dir, gci)"],
  ["Get-Content", "Read file contents (cat, gc, type)"],
  ["Set-Content", "Write file contents (sc)"],
  ["Add-Content", "Append to a file (ac)"],
  ["Copy-Item", "Copy files and directories (cp, copy)"],
  ["Move-Item", "Move files and directories (mv, move)"],
  ["Remove-Item", "Delete files or directories (rm, del)"],
  ["New-Item", "Create a file or directory (ni, mkdir)"],
  ["Rename-Item", "Rename an item (ren)"],
  ["Set-Location", "Change the current directory (cd, sl)"],
  ["Push-Location", "Push the current location (pushd)"],
  ["Pop-Location", "Pop the location stack (popd)"],
  ["Get-Location", "Show the current directory (pwd)"],
  ["Get-Item", "Retrieve an item at a path (gi)"],
  ["Test-Path", "Check whether a path exists"],
  ["Get-Process", "List running processes (ps, gps)"],
  ["Stop-Process", "Terminate a process (kill)"],
  ["Start-Process", "Start a program (saps, start)"],
  ["Get-Service", "List system services (gsv)"],
  ["Start-Service", "Start a service"],
  ["Stop-Service", "Stop a service"],
  ["Restart-Service", "Restart a service"],
  ["Get-Command", "Discover commands (gcm)"],
  ["Get-Help", "Show help for a command"],
  ["Get-Member", "Inspect object members (gm)"],
  ["Select-Object", "Select object properties (select)"],
  ["Where-Object", "Filter objects by condition (where, ?)"],
  ["ForEach-Object", "Run a block per object (foreach, %)"],
  ["Sort-Object", "Sort objects (sort)"],
  ["Measure-Object", "Measure object counts/sums (measure)"],
  ["Out-File", "Write output to a file"],
  ["Write-Output", "Print output (echo, write)"],
  ["Write-Host", "Print to the host console"],
  ["Invoke-WebRequest", "HTTP request (iwr, curl, wget)"],
  ["Invoke-RestMethod", "REST request (irm)"],
  ["Invoke-Command", "Run commands remotely (icm)"],
  ["Test-Connection", "Ping a host (ping)"],
  ["Get-NetIPAddress", "Show IP addresses"],
  ["Get-Date", "Show the current date/time"],
  ["Clear-Host", "Clear the screen (cls, clear)"],
];

/** cmd 内建命令与常用外部工具（label → 简述）。 */
const CMD_BUILTINS: ReadonlyArray<readonly [string, string]> = [
  ["dir", "List directory contents"],
  ["cd", "Change the current directory (chdir)"],
  ["md", "Create a directory (mkdir)"],
  ["rd", "Remove a directory (rmdir)"],
  ["del", "Delete files (erase)"],
  ["copy", "Copy files"],
  ["xcopy", "Copy files and directory trees"],
  ["robocopy", "Robust file copy"],
  ["move", "Move files"],
  ["ren", "Rename files (rename)"],
  ["type", "Print file contents"],
  ["echo", "Print a message"],
  ["set", "Show or set environment variables"],
  ["setx", "Persist an environment variable"],
  ["cls", "Clear the screen"],
  ["attrib", "Show or change file attributes"],
  ["find", "Search for text in files"],
  ["findstr", "Search files with patterns"],
  ["more", "Paginate a file"],
  ["sort", "Sort input lines"],
  ["tree", "Show a directory tree"],
  ["fc", "Compare two files"],
  ["title", "Set the console title"],
  ["path", "Show or set the PATH"],
  ["pushd", "Push a directory onto the stack"],
  ["popd", "Pop the directory stack"],
  ["start", "Start a program in a new window"],
  ["call", "Call a batch script and return"],
  ["tasklist", "List running processes"],
  ["taskkill", "Terminate a process"],
  ["sc", "Manage Windows services"],
  ["net", "Network/service administration"],
  ["netstat", "Show network connections"],
  ["ipconfig", "Show IP configuration"],
  ["ping", "Test network reachability"],
  ["tracert", "Trace the route to a host"],
  ["nslookup", "DNS lookup"],
  ["arp", "Show the ARP table"],
  ["route", "Show or modify the routing table"],
  ["systeminfo", "Show system information"],
  ["sfc", "System file checker"],
  ["chkdsk", "Check a disk for errors"],
  ["shutdown", "Shut down or restart the machine"],
  ["runas", "Run a program as another user"],
  ["where", "Locate a program on PATH"],
  ["mklink", "Create a symbolic link"],
  ["timeout", "Pause for a number of seconds"],
  ["exit", "Exit the cmd session"],
];

/** 候选上限：与 fig 命令名补全同一量级（MAX_COMMAND_ITEMS=32）。 */
const MAX_BUILTIN_ITEMS = 32;
const ITEM_SCORE = 300;

/**
 * 内建命令候选：按前缀过滤 + 排序 + 截断。编辑范围由调用方给定
 * （命令名位的 [start, end)）；editText 统一补尾随空格。
 */
export function shellBuiltinItems(
  shell: WindowsShellKind,
  searchTerm: string,
  tokenStart: number,
  tokenEnd: number,
): CompletionItem[] {
  const table = shell === "powershell" ? POWERSHELL_BUILTINS : CMD_BUILTINS;
  return table
    .filter(([label]) => label.toLowerCase().startsWith(searchTerm.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_BUILTIN_ITEMS)
    .map(([label, description]) => {
      const editText = `${label} `;
      const edit = {
        text: editText,
        replaceStart: tokenStart,
        replaceEnd: tokenEnd,
        cursorOffset: tokenStart + editText.length,
      };
      return {
        id: `shell-builtin:${label}`,
        label,
        description,
        kind: "command" as const,
        score: ITEM_SCORE + (label.toLowerCase() === searchTerm.toLowerCase() ? 200 : 0),
        source: "shell-builtin",
        edit,
      };
    });
}

const isThenable = (value: unknown): value is Promise<CompletionResponse | null> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

/**
 * 命令名位判定 + 内建候选响应。仅行首单 token 且未敲尾随空白时兜底
 * （多 token 行交给 fig 语料；空行不弹）。返回 null = 维持内层结果。
 */
function builtinResponseFor(
  request: FigSourceRequest,
  shell: WindowsShellKind,
): CompletionResponse | null {
  try {
    const line = request.line;
    if (typeof line !== "string" || line.length === 0) return null;
    const split = splitCommandLine(line);
    if (split.tokens.length !== 1 || split.trailingSpace) return null;
    const rawToken = /\S+$/.exec(line)?.[0] ?? split.tokens[0].text;
    const tokenEnd = line.length;
    const tokenStart = Math.max(0, tokenEnd - rawToken.length);
    const items = shellBuiltinItems(shell, split.tokens[0].text, tokenStart, tokenEnd);
    if (items.length === 0) return null;
    const context: CompletionContext = {
      command: split.tokens[0].text,
      commandPath: [],
      tokenStart,
      tokenEnd,
    };
    return {
      requestId: request.requestId,
      revision: request.revision,
      state: "ready",
      context,
      items,
    };
  } catch {
    return null;
  }
}

/**
 * 把引擎 source 包一层 Windows shell 内建兜底：内层 ready 非空结果原样透传
 * （fig 语料优先）；null/pass-through/空候选且 detect 判出 PowerShell/cmd 时
 * 在命令名位补内建命令。inner 可以是同步 source 或 worker runner（thenable
 * resolve）——包装器透传其时序形态。
 */
export function withShellBuiltinsSource(
  inner: FigCompletionSource,
  detect: () => WindowsShellKind | null,
): FigCompletionSource {
  const deliver = (request: FigSourceRequest, response: CompletionResponse | null): CompletionResponse | null => {
    if (response && response.state === "ready" && response.items.length > 0) return response;
    let shell: WindowsShellKind | null = null;
    try {
      shell = detect();
    } catch {
      shell = null;
    }
    if (!shell) return response;
    return builtinResponseFor(request, shell) ?? response;
  };
  const wrapped = {
    id: inner.id,
    resolve(request: FigSourceRequest): CompletionResponse | null | Promise<CompletionResponse | null> {
      try {
        const innerResult = inner.resolve(request);
        if (isThenable(innerResult)) {
          return innerResult.then(
            (response) => deliver(request, response),
            () => deliver(request, null),
          );
        }
        return deliver(request, innerResult);
      } catch {
        // 内层抛错（接口约定不该发生）：仍尝试内建兜底。
        let shell: WindowsShellKind | null = null;
        try {
          shell = detect();
        } catch {
          shell = null;
        }
        return shell ? builtinResponseFor(request, shell) : null;
      }
    },
  };
  // 冻结接口声明为同步签名；worker runner 形态 resolve 运行时返回 thenable
  // ——与 engineRunner.ts 同款类型桥接（CompletionController 的 thenable
  // 防御分支消费），本仓类型桥接点仅此两处。
  return wrapped as unknown as FigCompletionSource;
}
