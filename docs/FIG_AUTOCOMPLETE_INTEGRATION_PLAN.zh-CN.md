# dbx-plugin-ssh：Fig / Amazon Q Completion Spec 集成实施文档

> 基线：`codex/ssh/fix-120-suggestion-overlay` 当前分支，HEAD `3064b8372915876d8f91e806f65ee7f4ad8e0fe6`。
>
> 目标：在现有 Rust sidecar + Vue/Vite + xterm.js 架构上，引入 Fig / Amazon Q 生态的 Completion Spec，并实现本地、SSH、Windows、Linux、macOS、WSL 等多平台目标环境的统一补全运行时。

---

## 1. 实施结论

本项目**不要集成 Fig Desktop / figterm / Fig React UI**，而应该集成下面三个能力：

1. `withfig/autocomplete` 的 Spec 数据格式与 spec corpus；
2. Amazon Q autocomplete 项目中的 parser / resolver / generator 运行时设计；
3. 由 dbx-plugin-ssh 自己提供的 `CompletionHost`，把“动态生成候选”执行到正确的本地或远端 target 上。

最终结构：

```text
                         ┌──────────────────────────┐
                         │ withfig/autocomplete     │
                         │ Fig.Spec / Fig.Generator │
                         └────────────┬─────────────┘
                                      │ build-time
                                      ▼
                         ┌──────────────────────────┐
                         │ Fig Spec Bundle          │
                         │ command -> spec module   │
                         └────────────┬─────────────┘
                                      │
                                      ▼
┌───────────────┐       ┌──────────────────────────┐
│ xterm.js      │──────▶│ CompletionController      │
│ onData/key    │       │ edit-buffer + revision    │
└──────┬────────┘       └────────────┬─────────────┘
       │                              │ Worker RPC
       │                              ▼
       │                   ┌────────────────────────┐
       │                   │ Completion Worker      │
       │                   │ parser / resolver      │
       │                   │ generator scheduler    │
       │                   │ ranking / replacement  │
       │                   └───────────┬────────────┘
       │                               │ CompletionHost RPC
       │                               ▼
       │                   ┌────────────────────────┐
       │                   │ Rust sidecar           │
       │                   │ target dispatch        │
       │                   └───────┬───────┬────────┘
       │                           │       │
       ▼                           ▼       ▼
   Completion UI             Local      SSH / WSL / future
   Vue overlay               executor   remote executor
```

核心原则只有一条：

> **Desktop OS 与 Completion Target OS 完全解耦。**
>
> macOS 上的 SSH Linux 会话，补全 generator 必须在 Linux 远端执行；Windows 上的 SSH Linux 会话也必须同样执行在 Linux 远端。不能因为前端运行在 Windows 就让 generator 在 Windows 本机执行。

---

## 2. 当前代码基线

当前分支已经具备完整的终端基础设施，集成点非常明确。

### 2.1 已有完成项

当前 `frontend/src/lib/completions/spec.ts` 已有：

- `CompletionSpecs`
- `CompletionFlagSpec`
- `CompletionPositionalSpec`
- `SpecCommand`
- `CompletionRow`
- `SpecMatch`
- `splitCommandLine()`
- `matchSpecLine()`
- `replaceStart / replaceEnd`
- `--flag=value` 解析
- 引号 / 转义 / `--` terminator 处理

当前 `frontend/src/lib/completions/provider.ts` 已经提供动态候选 provider 注册接口。

当前 `frontend/src/components/CompletionMenu.vue` 已经处理：

- `--popover / --border / --accent / --foreground` theme token；
- above / below 翻转；
- 两侧都不够时 `max-height + overflow-y`；
- 光标字符右边缘 + 6px 水平间隙；
- terminal host 净高度；
- `scrollHeight` 测量自然高度。

当前 `App.vue` 已经做到：

- `pendingTerminalInput`；
- `matchSpecLine()` 优先、历史建议 fallback；
- completion 与 ghost 互斥；
- Enter 默认不被结构化补全吞掉；
- 动态 hint 无候选时 Tab 透传 shell；
- replacement 使用 parser 的 `replaceStart / replaceEnd`；
- 输出 settle 后通过 rAF 重新测量 anchor，解决 SSH RTT 导致的定位滞后。

当前 sidecar 已经有：

- SSH PTY；
- local PTY；
- `ssh/exec`；
- local shell discovery；
- local filesystem browse；
- SSH SFTP；
- Windows ConPTY；
- shell integration / OSC 7 / OSC 633；
- binary terminal input/output channel。

这意味着**无需引入 figterm 的 PTY 拦截层**。现有 PTY 和 xterm.js 已经承担了 figterm 的宿主职责。

---

## 3. 与 Fig / Amazon Q 的正确关系

### 3.1 Spec 来源

`withfig/autocomplete` 中的核心资产是 Completion Spec：命令、subcommands、options、args、description 以及 generator。这个格式仍然是后续兼容性的主要来源。

官方仓库中的 spec 仍采用 `Fig.Spec` / `Fig.Option` / `Fig.Generator` 形态，例如 git、cf、helm 等 spec，generator 可以通过脚本执行目标 CLI 并对输出做 `postProcess`。这说明这里不是一个“JSON 字典格式”，而是一个包含运行时代码语义的 TypeScript spec 系统。

### 3.2 Parser 来源

Amazon Q Developer CLI autocomplete 项目继续提供 TypeScript parser / autocomplete runtime，并以 Rust + TypeScript workspace 组织。该项目的 root `package.json` 当前使用 Node 22 + pnpm，许可证为 MIT OR Apache-2.0。

**实施要求：**

- 以当前 Amazon Q autocomplete parser 源码作为兼容参考；
- 不依赖旧版本 npm parser 包作为最终方案；
- parser 最终运行在 Web Worker；
- Rust 只提供 host capabilities，不复制 Fig parser 的语义。

### 3.3 为什么不能直接把 Fig Spec 映射成当前的 `SpecCommand`

当前模型只覆盖：

```text
command
  ├── subcommands
  ├── flags
  └── positional
```

而 Fig Spec 实际还涉及：

- 多别名 `name: ["checkout", "co"]`；
- persistent options；
- repeatable options；
- variadic args；
- exclusive / depends-on；
- `isDangerous` / `priority`；
- `insertValue`；
- option separator `--`；
- nested `args` / `options`；
- generator；
- `loadSpec`；
- `generateSpec`；
- parser directives；
- 自定义 completion generator；
- 动态脚本输出后处理。

因此当前 `spec.ts` 应当变成**兼容层 / UI adapter**，而不再是未来的权威 parser。

---

# 4. 目标架构

## 4.1 分层

```text
frontend/src/lib/completion/
├── core/
│   ├── types.ts
│   ├── engine.ts
│   ├── parser.ts
│   ├── resolver.ts
│   ├── ranking.ts
│   ├── edit.ts
│   └── scheduler.ts
│
├── fig/
│   ├── types.ts
│   ├── adapter.ts
│   ├── specLoader.ts
│   ├── generatorRunner.ts
│   ├── compatibility.ts
│   └── manifest.ts
│
├── host/
│   ├── protocol.ts
│   ├── hostClient.ts
│   └── providers.ts
│
├── targets/
│   ├── local.ts
│   ├── ssh.ts
│   ├── wsl.ts
│   └── target.ts
│
├── worker/
│   └── completion.worker.ts
│
└── legacy/
    └── legacySpecAdapter.ts
```

Rust：

```text
backend/src/completion/
├── mod.rs
├── protocol.rs
├── target.rs
├── executor.rs
├── local.rs
├── ssh.rs
├── wsl.rs
├── filesystem.rs
├── security.rs
└── tests.rs
```

App.vue 不再直接理解 Fig parser。

最终只保留：

```text
App.vue
  -> CompletionController
      -> Worker
          -> CompletionEngine
```

---

# 5. 核心类型设计

## 5.1 Edit Buffer

现有：

```ts
let pendingTerminalInput = "";
```

迁移为：

```ts
export interface EditBufferState {
  sessionId: string;
  revision: number;

  text: string;
  cursor: number;          // UTF-16 index into text

  cwd: string | null;
  shell: ShellKind;
  target: CompletionTarget;

  prompt?: {
    text: string;
    startColumn?: number;
  };
}

type ShellKind =
  | "bash"
  | "zsh"
  | "fish"
  | "pwsh"
  | "powershell"
  | "cmd"
  | "unknown";
```

### 关键点

`revision` 是必须字段。

任何 async generator 回来时，都必须检查：

```ts
response.revision === current.revision
```

否则直接丢弃。

这可以一次性解决：

- SSH RTT 导致的 stale completion；
- generator 慢响应覆盖新输入；
- 快速连续 Tab；
- session 切换后旧结果串入新 terminal。

---

## 5.2 CompletionItem

不要再让候选只保存 `token`。

最终统一为：

```ts
export interface CompletionItem {
  id: string;

  label: string;
  description?: string;
  icon?: string;
  kind:
    | "command"
    | "subcommand"
    | "option"
    | "argument"
    | "file"
    | "directory"
    | "history"
    | "snippet";

  score: number;
  source: string;

  edit: CompletionEdit;
}

export interface CompletionEdit {
  text: string;
  replaceStart: number;
  replaceEnd: number;
  cursorOffset?: number;
}
```

这样可以彻底避免：

```text
--output=json
```

被错误替换成：

```text
--output=--output=json
```

也避免后续 generator 返回：

```text
/path/file.txt
```

时再靠 `/\S+$/` 猜范围。

**编辑操作必须由 parser / resolver 产生，UI 只能执行。**

---

# 6. Fig Spec 适配策略

## 6.1 不修改 upstream spec

不要把 Fig spec 转换成人工维护的：

```ts
CompletionFlagSpec
CompletionPositionalSpec
```

不要再手工维护 12 个命令的裁剪版本作为长期主源。

正确方式是：

```text
upstream Fig Spec
       ↓
Fig Runtime Types
       ↓
CompletionEngine
       ↓
CompletionItem
```

只有 UI adapter 才把它转成 `CompletionRow`。

---

## 6.2 Spec Snapshot

新增：

```text
frontend/vendor/fig-specs/
```

不要把整个 git 仓库当作项目运行时依赖。

保存：

```json
{
  "source": "withfig/autocomplete",
  "commit": "<pinned sha>",
  "generatedAt": "<build time>",
  "formatVersion": 1
}
```

实际文件：

```text
frontend/vendor/fig-specs/build/
├── git.js
├── docker.js
├── kubectl.js
├── helm.js
├── aws.js
├── npm.js
├── pnpm.js
└── ...
```

并生成：

```ts
export interface FigSpecManifestEntry {
  name: string;
  module: () => Promise<Fig.Spec>;
}

export const FIG_SPEC_MANIFEST: Record<string, FigSpecManifestEntry> = ...;
```

### 为什么要按 command 拆 chunk

如果一次把全部 spec 打进主 bundle，会直接增加 WebView 首屏 JS 负担。

目标是：

```text
输入 git
  -> 只动态加载 git spec

输入 kubectl
  -> 只动态加载 kubectl spec
```

推荐 Vite：

```ts
const loaders = import.meta.glob(
  "/src/vendor/fig-specs/build/*.js",
  { eager: false }
);
```

---

# 7. Spec 同步脚本

新增：

```text
scripts/sync_fig_specs.mjs
scripts/verify_fig_specs.mjs
frontend/src/lib/completion/fig/spec-manifest.generated.ts
```

`package.json`：

```json
{
  "scripts": {
    "fig:sync": "node scripts/sync_fig_specs.mjs",
    "fig:verify": "node scripts/verify_fig_specs.mjs",
    "fig:test": "vitest run src/lib/completion"
  }
}
```

同步流程：

```text
1. checkout pinned withfig/autocomplete commit
2. 安装 build-time Node dependencies
3. 编译 spec TS
4. 构建 spec manifest
5. 写入 snapshot metadata
6. 运行 compatibility scan
7. 运行 parser fixture tests
```

**运行时不需要 Node。**

Node 只存在于 build / CI 环节。

---

# 8. Parser 集成方式

## 8.1 推荐方案

直接 vendor / fork 当前 Amazon Q autocomplete parser 的 TypeScript 实现，并删除不需要的 AWS 服务依赖。

不要在 Rust 中重新写 Fig parser。

目录：

```text
frontend/src/lib/completion/fig/parser/
```

或：

```text
frontend/vendor/amazon-q-autocomplete-parser/
```

最终由：

```ts
CompletionEngine.resolve(buffer, spec)
```

统一调用。

---

## 8.2 保留 upstream parser 的语义边界

必须优先覆盖：

```text
aliases
persistent options
repeatable options
variadic args
-- terminator
nested subcommands
option value parsing
exclusive / dependsOn
generator
loadSpec
generateSpec
```

不能把 Fig parser 再简化成：

```text
command -> flag -> values
```

否则迁移到大量 upstream spec 后，问题会从“候选少”变成“命令行语义错误”。

---

# 9. Completion Worker

新建：

```text
frontend/src/lib/completion/worker/completion.worker.ts
```

消息：

```ts
export interface CompletionRequest {
  requestId: number;
  revision: number;
  trigger: "typing" | "tab" | "manual";
  buffer: EditBufferState;
}

export interface CompletionResponse {
  requestId: number;
  revision: number;
  state:
    | "idle"
    | "loading"
    | "ready"
    | "pass-through"
    | "error";

  context?: CompletionContext;
  items: CompletionItem[];
}

export interface CompletionContext {
  command: string | null;
  commandPath: string[];
  tokenStart: number;
  tokenEnd: number;
}
```

### Worker 的职责

Worker 负责：

1. 读取 spec；
2. parser；
3. resolver；
4. static candidates；
5. generator schedule；
6. provider merge；
7. ranking；
8. edit range；
9. 最终 `CompletionItem[]`。

Worker **不直接碰 DOM**。

---

# 10. CompletionHost：Rust 与 TypeScript 的唯一边界

定义：

```ts
export interface CompletionHost {
  execute(request: ExecuteCommandRequest): Promise<ExecuteCommandResult>;
  listDirectory(request: ListDirectoryRequest): Promise<ListDirectoryResult>;
  getEnvironment(target: CompletionTarget): Promise<CompletionEnvironment>;
}
```

目标类型：

```ts
export type CompletionTarget =
  | {
      kind: "local";
      sessionId: string;
    }
  | {
      kind: "ssh";
      sessionId: string;
    }
  | {
      kind: "wsl";
      sessionId: string;
      distro?: string;
    };
```

执行请求：

```ts
export interface ExecuteCommandRequest {
  target: CompletionTarget;
  command: string;
  args: string[];
  cwd?: string | null;

  timeoutMs: number;
  maxOutputBytes: number;

  mode: "completion-generator";
}
```

结果：

```ts
export interface ExecuteCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
```

---

# 11. Rust RPC 设计

建议增加一个专门的 completion RPC，不直接复用 UI 现有 generic `ssh/exec`。

新增：

```text
completion/execute
completion/listDirectory
completion/environment
```

原因：

1. 可以对 completion generator 单独限时；
2. 可以限制最大输出；
3. 可以单独做安全策略；
4. 不让普通用户 RPC 与 generator RPC 耦合；
5. 本地和 SSH 可以共用同一协议。

### `backend/src/completion/protocol.rs`

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionExecuteRequest {
    pub target: CompletionTarget,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompletionTarget {
    Local { session_id: String },
    Ssh { session_id: String },
    Wsl { session_id: String, distro: Option<String> },
}
```

### `backend/src/completion/executor.rs`

```rust
#[async_trait::async_trait]
pub trait CompletionExecutor: Send + Sync {
    async fn execute(
        &self,
        request: CompletionExecuteRequest,
    ) -> Result<CompletionExecuteResult, CompletionError>;

    async fn list_directory(
        &self,
        request: ListDirectoryRequest,
    ) -> Result<ListDirectoryResult, CompletionError>;
}
```

---

# 12. SSH executor

已有：

```text
ssh/exec
```

已有 `SshRuntime::exec` 能力。

completion SSH executor 不要复制 SSH 连接池，而是：

```text
CompletionExecuteRequest
       ↓
CompletionSshExecutor
       ↓
existing SshRuntime::exec
       ↓
existing sessionId
```

但是必须加：

```text
max timeout
max output
read-only completion marker
```

建议内部调用统一走：

```text
ssh.exec(session_id, exec_id, command, sudo=false, timeout)
```

并让 completion executor 自己裁切 stdout / stderr。

**generator 禁止走 sudo。**

---

# 13. Local executor

已有：

```text
backend/src/local_terminal.rs
```

本地终端已经由 portable-pty 管理。

但 generator 不应该往现有交互 PTY 里注入命令。

必须独立创建短生命周期 command process：

```text
local completion generator
  -> CommandBuilder
  -> stdout pipe
  -> stderr pipe
  -> timeout
  -> kill on timeout
```

原因：

如果直接把：

```text
printf ...
```

注入用户正在使用的 shell，generator 输出会污染终端状态。

---

# 14. WSL executor

Windows 本机 target：

```text
local
```

Windows 上的 Linux WSL target：

```text
wsl
```

第一版直接：

```text
wsl.exe -d <distro> -- <command> <args...>
```

但注意：

- `cwd` 要转成 WSL 路径；
- Windows 路径不能直接送给 Linux command；
- `/mnt/c/...` 与 `C:\...` 要做显式映射；
- WSL 不应该通过用户默认交互 shell 执行 generator。

---

# 15. Generator 分三级实现

这是整个项目最关键的分阶段点。

## Level 1：静态 Spec

支持：

- command；
- subcommand；
- option；
- args；
- aliases；
- static suggestions；
- description；
- priority。

这是第一批必须完成的兼容层。

---

## Level 2：Declarative Generator

支持：

```ts
generators: {
  script: ["git", "branch", "--format=%(refname:short)"],
  postProcess: ...
}
```

Fig spec 已大量使用这种形式，例如 CF、Watson 等 spec 会运行目标 CLI，再对 stdout 做解析。

这里最重要的是：

```text
script 定义
   ↓
CompletionHost.execute()
   ↓
target machine
```

而不是：

```text
browser
   ↓
local desktop shell
```

---

## Level 3：Custom JS Generator

最后再支持：

```ts
generators: async (context) => { ... }
```

以及：

```text
generateSpec
loadSpec
custom generator
```

### 推荐运行位置

第一版放在 Worker，但必须提供 compatibility shim。

不能假设浏览器环境拥有：

```text
process
fs
child_process
path
os
fetch
```

因此要给 generator 一个 host facade：

```ts
const host = {
  execute,
  listDirectory,
  environment,
};
```

### 不建议

不要在 v1 把完整 Node runtime 嵌进 Rust。

原因：

- module resolution；
- Node builtin；
- package dependency；
- sandbox；
- memory；
- Windows runtime；
- package size；
- CVE surface。

---

# 16. Generator 安全策略

这一项不能省。

Fig generator 本质上允许 spec 声明命令执行。

例如：

```ts
generators: {
  script: ["git", "branch"]
}
```

在 SSH 场景，这意味着：

```text
autocomplete
  -> remote git branch
```

如果 spec 被篡改，就可能变成任意命令执行。

## 默认策略

```ts
export interface CompletionExecutionPolicy {
  enabled: boolean;
  maxRuntimeMs: number;
  maxOutputBytes: number;
  allowShellScript: boolean;
  allowNetwork: boolean;
}
```

默认：

```text
enabled = true
maxRuntimeMs = 1200
maxOutputBytes = 256 KiB
allowShellScript = false
allowNetwork = false
```

因此：

```text
["git", "branch"]
```

可以执行。

但：

```text
["bash", "-c", "git branch | grep ..."]
```

在默认安全模式下应降级为：

```text
pass-through / no dynamic result
```

后续可以增加：

```text
Settings -> Trust upstream completion generators
```

但不要默认开启任意 shell script generator。

---

# 17. 文件补全

Fig generator 并不应该承担所有 filesystem completion。

项目已有：

```text
SFTP
local/fs/browse
remote directory tracking
```

因此文件补全建议独立 provider：

```ts
export interface FileCompletionProvider {
  complete(request: FileCompletionRequest): Promise<CompletionItem[]>;
}
```

映射：

```text
Local target  -> local filesystem
SSH target    -> SFTP
WSL target    -> WSL filesystem
```

这样：

```text
git add src/<Tab>
```

不需要执行：

```text
find .
```

而是直接从文件 provider 返回候选。

---

# 18. Git / kubectl / docker 等动态候选

优先使用 Fig 的 declarative generator：

```text
git branch
kubectl get pods
helm list
```

但执行时经过：

```text
CompletionHost
```

示例：

```text
git checkout ma<Tab>

parse
  commandPath = ["git", "checkout"]
  arg = branch
  prefix = "ma"

spec generator
  script = ["git", "branch", "--format=..."]

host
  target = ssh(session-123)

remote execution
  git branch ...

postProcess
  master
  main
  maintenance

merge
  -> CompletionItem[]
```

---

# 19. CompletionController

新增：

```text
frontend/src/lib/completion/CompletionController.ts
```

API：

```ts
export interface CompletionController {
  updateBuffer(buffer: EditBufferState): void;
  request(trigger: CompletionTrigger): void;
  accept(item: CompletionItem): void;
  move(delta: number): void;
  dismiss(): void;
}
```

App.vue 只负责：

```ts
const completion = new CompletionController(...);
```

不再直接写：

```ts
matchSpecLine(...)
openCompletionMenu(...)
fetchDynamicCompletionRows(...)
```

这样以后 UI 换成 command palette、floating panel、inline hint 都无需改 parser。

---

# 20. xterm.js 输入链路改造

当前链路：

```text
xterm.onData
  -> sendTerminalBytes
  -> trackPendingInput
  -> refreshSuggestionsAfterInput
```

改成：

```text
xterm.onData
  -> updateEditBuffer(data)
  -> revision++
  -> sendTerminalBytes(data)
  -> completion.request("typing")
```

### 注意顺序

必须先更新 completion state，再发 async request。

同时保存：

```text
requestId
revision
sessionId
```

返回时三项都必须匹配。

---

# 21. 键盘消费语义

当前分支的 Enter 透传、动态 hint Tab 透传语义必须保留。

最终规则：

| 状态 | Enter | Tab | ↑↓ | Esc |
|---|---|---|---|---|
| passive completion | shell | shell / explicit enter-completion | menu | close |
| interactive completion | shell 默认；只有显式 accept 模式才消费 | accept | move | close |
| pass-through | shell | shell | shell | close |
| ghost only | shell | shell | shell | close |

### 最关键

```text
completionOpen !== keyboardOwnership
```

菜单显示，不代表菜单拥有 Enter / Tab。

这条规则必须写成单元测试，不允许回归。

---

# 22. Completion Accept：统一 Edit Operation

当前已有 `replaceStart / replaceEnd`，保留并升级为：

```ts
applyCompletionEdit(edit: CompletionEdit)
```

伪代码：

```ts
function applyCompletionEdit(edit: CompletionEdit) {
  const line = editBuffer.text;

  const next =
    line.slice(0, edit.replaceStart) +
    edit.text +
    line.slice(edit.replaceEnd);

  const nextCursor =
    edit.replaceStart +
    (edit.cursorOffset ?? edit.text.length);

  writeTerminalEdit(line, next, editBuffer.cursor, nextCursor);
}
```

### v1 限制

当前项目的 PTY line editor 仍是 shell 自己管理。

第一阶段可继续将 completion accept 限定在：

```text
cursor == logicalLineEnd
```

后续再增加任意 cursor position。

---

# 23. 任意光标位置支持路线

要最终支持：

```text
git sta<Tab> --oneline
```

而光标位于 `sta` 中间，需要：

1. `EditBufferState.cursor`；
2. shell cursor movement tracking；
3. xterm buffer cursor position；
4. prompt start offset；
5. wrapped line mapping；
6. wide char / surrogate pair mapping。

推荐先实现：

```text
line-end completion
```

再实现：

```text
in-line completion
```

不要在第一阶段同时解决 shell cursor reconstruction。

---

# 24. Overlay 与 Completion Engine 解耦

当前 `CompletionMenu.vue` 已经达到目标 UI 基础设施，迁移时不要重写。

只需要把：

```ts
CompletionRow[]
```

改成：

```ts
CompletionItem[]
```

然后：

```text
label
   -> label

description
   -> description

kind
   -> kind

accept
   -> item.edit
```

现有：

```text
overlayPlacement.ts
terminalAnchor.ts
```

继续复用。

---

# 25. Dynamic Provider 迁移

当前：

```text
frontend/src/lib/completions/provider.ts
```

当前 provider：

```ts
complete(): Promise<string[] | null>
```

应升级成：

```ts
interface CompletionProvider {
  id: string;

  matches(context: CompletionContext): boolean;

  complete(
    request: CompletionProviderRequest,
  ): Promise<CompletionItem[]>;
}
```

这样 provider 可以返回：

- description；
- icon；
- kind；
- score；
- edit range；
- source。

---

# 26. Target 抽象

不要使用：

```ts
isLocalMode
```

作为 completion 业务核心判断。

新增：

```ts
interface CompletionTargetInfo {
  kind: "local" | "ssh" | "wsl";
  sessionId: string;

  os: "macos" | "linux" | "windows" | "wsl";
  shell: ShellKind;
  cwd: string | null;
}
```

这样：

```text
UI Desktop OS
      ≠
Completion Target OS
```

### 示例

| Desktop | Target | Generator 执行地 |
|---|---|---|
| macOS | local zsh | macOS |
| macOS | SSH Ubuntu | Ubuntu |
| macOS | SSH Windows | Windows |
| Windows | local PowerShell | Windows |
| Windows | WSL Ubuntu | WSL Ubuntu |
| Windows | SSH Ubuntu | Ubuntu |
| Linux | SSH macOS | macOS |
| Linux | local bash | Linux |

---

# 27. Multi-platform 行为

## macOS

支持：

- zsh；
- bash；
- fish；
- SSH Linux / macOS / Windows。

不需要 Accessibility API，因为 overlay 已经是 xterm 容器内部 DOM。

---

## Linux

支持：

- bash；
- zsh；
- fish；
- SSH Linux / macOS / Windows。

---

## Windows

支持：

- PowerShell；
- pwsh；
- cmd；
- WSL；
- SSH Linux / macOS / Windows。

Completion engine 本身不需要平台 if/else。

平台差异全部在：

```text
CompletionHost
```

---

# 28. Shell 类型不要决定 Parser 类型

Parser 主要处理 CLI 语义。

Shell 差异主要体现在：

```text
quoting
escaping
path separators
environment
command invocation
```

因此：

```ts
parseCommandLine(text)
```

不能绑定 bash。

建议 parser context：

```ts
interface ShellParseContext {
  shell: ShellKind;
  platform: TargetPlatform;
}
```

但默认保持 shell-neutral。

---

# 29. Spec Cache

spec 应放到两级 cache：

```text
L1 Worker memory
L2 bundled/dynamic imported ESM
```

不要每个按键都重新加载文件。

每个 command spec：

```ts
Map<string, Promise<Fig.Spec | null>>
```

generator 候选单独缓存：

```text
(command, context, cwd, target, prefix)
```

TTL 建议从 300ms 起。

例如：

```text
git branch
kubectl get pods
```

快速连续输入时避免重复执行远端命令。

---

# 30. Request Cancellation

每次输入都可能产生 generator：

```text
git chec
 git checko
 git checkout
```

如果三个 generator 全部打远端，浪费 RTT。

因此增加：

```ts
AbortSignal
```

流程：

```text
request N
  ↓
request N+1
  ↓
abort N
```

Rust sidecar 侧：

- 已启动的 local child 进程必须 kill；
- SSH exec 使用已有 exec cancellation；
- timeout 后立即回收。

---

# 31. Generator Scheduler

不要：

```ts
await Promise.all(allGenerators)
```

第一版推荐：

```text
static results
   ↓ immediately render

async generators
   ↓ pending state

generator result
   ↓ merge + reorder
```

即：

```text
菜单先打开
   ↓
显示静态候选
   ↓
100~1000ms 内动态候选回来
   ↓
更新菜单
```

这样 SSH 高 RTT 不会让菜单整体等待。

---

# 32. Ranking

统一评分层：

```text
1. exact
2. prefix
3. priority
4. generator result
5. kind priority
6. lexical
```

不要把 ranking 分散在：

- legacy spec；
- dynamic provider；
- history；
- UI。

所有候选进统一：

```ts
rank(items, context)
```

---

# 33. History / Ghost / Fig 三路统一

当前存在三套候选：

```text
history suggestion
structured spec completion
ghost suggestion
```

最终应明确为：

```text
Completion Source
├── Spec
├── Generator
├── FileSystem
├── History
└── ShellFallback
```

但 UI 保持两种展示：

```text
interactive dropdown
inline ghost
```

### 关系

```text
Spec / Generator / File / History
             ↓
       CompletionEngine
             ↓
   dropdown candidate list

History
   ↓
 Ghost Engine
   ↓
 inline remainder
```

不要让 ghost 和 Fig parser 相互调用。

---

# 34. Shell fallback

当：

```text
无 spec
或
spec 无法解析当前 context
或
generator 不允许执行
```

应进入：

```text
pass-through
```

不要制造假的静态 hint。

例如：

```text
some-internal-cli <Tab>
```

没有 spec 时：

```text
CompletionEngine -> pass-through
```

Tab 继续交给真实 shell completion。

这是现有动态 hint 透传策略的升级版。

---

# 35. Legacy Spec 迁移

现有：

```text
frontend/src/lib/completions/spec.ts
frontend/src/lib/completions/specs/*.ts
```

不要一次删除。

先做：

```text
LegacyCompletionProvider
FigCompletionProvider
```

resolver：

```ts
const providers = [
  figProvider,
  legacyProvider,
];
```

优先：

```text
Fig > Legacy
```

如果 Fig spec 不存在，再走 legacy。

---

# 36. 迁移顺序

## M1：Completion Core

新增：

```text
CompletionItem
CompletionEdit
EditBufferState
CompletionRequest
CompletionResponse
```

并把现有 `SpecMatch` 转成 adapter。

验收：现有 12 个本地 spec 的行为零回归。

---

## M2：Worker

新增：

```text
completion.worker.ts
CompletionController
```

把 parser 从 App.vue 移出去。

验收：

```text
git ch<Tab>
git checkout -<Tab>
kubectl get -o <Tab>
```

与当前 UI 行为一致。

---

## M3：Fig Spec Bundle

新增 build pipeline：

```text
withfig/autocomplete snapshot
       ↓
compiled spec modules
       ↓
manifest
```

第一阶段只开放：

```text
git
kubectl
helm
docker
npm
pnpm
yarn
ssh
aws
cargo
systemctl
```

然后逐步扩充全部 spec。

---

## M4：CompletionHost

Rust 新增：

```text
completion/execute
completion/listDirectory
completion/environment
```

前端新增：

```text
HostClient
LocalTarget
SshTarget
```

验收：

```text
local git branch
SSH git branch
```

两者都从目标机器得到候选。

---

## M5：Declarative Generators

支持：

```text
script
postProcess
splitOn
```

至少覆盖：

```text
git branch
kubectl pods
helm releases
```

验收：

```text
git checkout <Tab>
kubectl delete pod <Tab>
helm uninstall <Tab>
```

SSH 场景必须执行到远端。

---

## M6：File Provider

支持：

```text
local
SSH/SFTP
WSL
```

验收：

```text
git add <Tab>
cat /etc/<Tab>
vim ./src/<Tab>
```

---

## M7：Custom Generator Compatibility

支持：

```text
custom
loadSpec
```

并引入 capability facade。

不支持的 Node API 返回：

```text
unsupported -> generator ignored -> fallback
```

不能因此让 completion engine 崩溃。

---

# 37. Rust 文件级任务清单

```text
backend/src/completion/mod.rs
```

注册 completion 子模块。

```text
backend/src/completion/protocol.rs
```

定义 JSON request / response。

```text
backend/src/completion/target.rs
```

定义：

- Local;
- SSH;
- WSL。

```text
backend/src/completion/executor.rs
```

统一 executor trait。

```text
backend/src/completion/local.rs
```

短命令进程 + timeout + output cap。

```text
backend/src/completion/ssh.rs
```

复用现有 `SshRuntime::exec`。

```text
backend/src/completion/wsl.rs
```

WSL command adapter。

```text
backend/src/completion/filesystem.rs
```

统一目录候选接口。

```text
backend/src/completion/security.rs
```

generator execution policy。

然后在：

```text
backend/src/main.rs
```

添加：

```text
completion/execute
completion/listDirectory
completion/environment
```

---

# 38. Frontend 文件级任务清单

保留并演进：

```text
frontend/src/lib/completions/spec.ts
frontend/src/lib/completions/provider.ts
frontend/src/lib/overlayPlacement.ts
frontend/src/lib/terminalAnchor.ts
frontend/src/components/CompletionMenu.vue
```

新增：

```text
frontend/src/lib/completion/core/types.ts
frontend/src/lib/completion/core/engine.ts
frontend/src/lib/completion/core/parser.ts
frontend/src/lib/completion/core/resolver.ts
frontend/src/lib/completion/core/ranking.ts
frontend/src/lib/completion/core/edit.ts
frontend/src/lib/completion/core/scheduler.ts

frontend/src/lib/completion/fig/adapter.ts
frontend/src/lib/completion/fig/specLoader.ts
frontend/src/lib/completion/fig/generatorRunner.ts
frontend/src/lib/completion/fig/compatibility.ts

frontend/src/lib/completion/host/protocol.ts
frontend/src/lib/completion/host/hostClient.ts

frontend/src/lib/completion/targets/local.ts
frontend/src/lib/completion/targets/ssh.ts
frontend/src/lib/completion/targets/wsl.ts

frontend/src/lib/completion/worker/completion.worker.ts
frontend/src/lib/completion/CompletionController.ts
```

---

# 39. App.vue 最终改造目标

当前：

```ts
matchSpecLine(...)
openCompletionMenu(...)
fetchDynamicCompletionRows(...)
acceptCompletionRow(...)
```

迁移后：

```ts
completionController.updateBuffer(editBuffer);
completionController.request("typing");
```

收到：

```ts
completionController.onResponse((response) => {
  completionItems.value = response.items;
});
```

接受：

```ts
completionController.accept(activeItem);
```

App.vue 不再知道：

- Fig parser；
- generator；
- spec shape；
- remote command；
- postProcess。

---

# 40. CompletionMenu.vue 最终改造目标

Props：

```ts
rows: CompletionItem[];
activeIndex: number;
anchor: SuggestionAnchor | null;
viewport?: { height: number };
```

Event：

```ts
activate(index)
accept(item)
```

它只关心：

```text
render
highlight
position
emit accept
```

不要把 parser logic 放回组件。

---

# 41. 测试设计

## 41.1 Parser Fixture

建立：

```text
frontend/src/lib/completion/fixtures/
```

每个 fixture：

```json
{
  "input": "git checkout -",
  "command": "git",
  "path": ["git", "checkout"],
  "level": "option"
}
```

至少覆盖：

```text
alias
short option
long option
--flag=value
quoted arg
escaped arg
--
variadic arg
repeatable option
nested subcommand
```

---

## 41.2 Generator Tests

所有 generator 使用 fake host：

```ts
const host = new FakeCompletionHost({
  execute: async () => ({
    stdout: "main\nmaster\n",
  }),
});
```

禁止单元测试真的运行本机 shell。

---

## 41.3 SSH Integration Test

使用当前项目已有 docker / smoke infrastructure。

测试：

```text
SSH Ubuntu
  git checkout <Tab>
  -> remote branch list
```

验证：

```text
local command count == 0
remote command count == 1+
```

---

## 41.4 Windows

必须覆盖：

```text
Windows local PowerShell
Windows local cmd
Windows WSL Ubuntu
Windows SSH Linux
```

特别检查：

```text
path separator
cwd mapping
UTF-16 replacement
ConPTY cursor
```

---

## 41.5 UI Regression

保留现有 issue #120：

```text
light theme
 dark theme
below
above
insufficient space
left clamp
host bottom
SSH RTT anchor resettle
```

并新增：

```text
static -> dynamic update
stale generator response
Tab pass-through
Enter pass-through
session switch stale response
```

---

# 42. 性能目标

不是以“每次按键一次远端 RPC”为目标。

目标链路：

```text
typing
  ↓
static result < immediate
  ↓
generator async
  ↓
merge
```

要求：

- 静态 spec 不经过 RPC；
- 同一 request 只跑一次 generator；
- 旧 revision 立即取消；
- generator output 必须上限；
- 结果必须上限 20~50 条 UI item；
- spec 动态 import 只发生一次。

---

# 43. 失败降级策略

任何一层失败都必须 fallback，而不是打断 terminal：

```text
spec load fail
   -> history / shell fallback

generator timeout
   -> static candidates

generator unsupported
   -> static candidates

RPC fail
   -> static candidates / shell fallback

stale result
   -> drop silently

bad spec
   -> blacklist command spec

worker crash
   -> restart worker
```

**补全绝对不能影响 PTY 输入链路。**

---

# 44. Worker Crash Recovery

`CompletionController` 必须拥有：

```ts
restartWorker(): void
```

当 Worker：

```text
messageerror
error
```

时：

```text
1. drop current completion
2. restart worker
3. keep terminal working
```

不要因为 completion worker 崩溃导致 terminal 页面失去输入。

---

# 45. Feature Flag

第一阶段增加：

```text
ssh-completion-engine
```

值：

```text
legacy
fig
fig-safe
```

推荐默认顺序：

```text
fig-safe
```

其中：

```text
fig-safe
 = static specs + safe declarative generator + filesystem provider
```

`fig`：

```text
full declarative + custom generator
```

仅作为实验开关。

---

# 46. 设置项

建议：

```text
Settings -> Terminal -> Command Completion

[✓] Structured completion
[✓] Remote dynamic completion
[✓] File completion
[ ] Trusted shell-script generators
```

默认：

```text
Structured completion = ON
Remote dynamic completion = ON
File completion = ON
Trusted shell-script generators = OFF
```

---

# 47. Spec 更新策略

不要启动时联网下载最新 spec。

采用：

```text
CI
 ↓
pinned spec commit
 ↓
bundle
 ↓
release artifact
```

每次 release 带：

```text
completionSpecSource
completionSpecCommit
completionEngineVersion
```

例如：

```json
{
  "engine": "dbx-fig-v1",
  "specSource": "withfig/autocomplete",
  "specCommit": "abc123..."
}
```

这样用户问题可以精确复现。

---

# 48. License / Attribution

必须随 vendor 一起保留 upstream license / notice。

推荐：

```text
frontend/vendor/NOTICE.fig.txt
frontend/vendor/LICENSE.fig.txt
frontend/vendor/NOTICE.amazon-q-autocomplete.txt
```

并在项目 `NOTICE` / about 页面说明：

```text
Completion specifications are derived from the public Fig/Amazon Q
autocomplete ecosystem and are not part of the dbx-plugin-ssh original
specification set.
```

实际采用哪个上游 parser snapshot 时，再按该 snapshot 的 LICENSE / NOTICE 精确落盘。

---

# 49. 不应做的事情

## 不要 1：把 Fig UI 整个搬进来

你现在已经有 Vue + xterm.js + terminal overlay。

搬 React UI 会导致：

- 双框架；
- CSS 隔离；
- keyboard ownership；
- focus；
- theme token；
- overlay 定位重复。

没有收益。

## 不要 2：在 Rust 重写 Fig parser

会形成：

```text
Fig parser semantics
         ≠
Rust parser semantics
```

最终 upstream spec 越多，兼容性越差。

## 不要 3：generator 在桌面机执行

SSH target 一定要 target-side execution。

## 不要 4：补全直接写用户交互 PTY

generator 必须使用独立 command execution。

## 不要 5：保留 `row.token` 作为唯一 accept 信息

必须升级成 `CompletionEdit`。

## 不要 6：用 `completionOpen` 判断键盘所有权

菜单可见与键盘消费是两个状态。

---

# 50. 最终目录结构

```text
dbx-plugin-ssh/
├── backend/
│   └── src/
│       ├── completion/
│       │   ├── mod.rs
│       │   ├── protocol.rs
│       │   ├── target.rs
│       │   ├── executor.rs
│       │   ├── local.rs
│       │   ├── ssh.rs
│       │   ├── wsl.rs
│       │   ├── filesystem.rs
│       │   └── security.rs
│       └── main.rs
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   └── CompletionMenu.vue
│   │   └── lib/
│   │       ├── completions/
│   │       │   ├── spec.ts
│   │       │   ├── provider.ts
│   │       │   └── specs/
│   │       └── completion/
│   │           ├── core/
│   │           ├── fig/
│   │           ├── host/
│   │           ├── targets/
│   │           ├── worker/
│   │           └── CompletionController.ts
│   │
│   └── vendor/
│       ├── fig-specs/
│       └── amazon-q-autocomplete-parser/
│
├── scripts/
│   ├── sync_fig_specs.mjs
│   └── verify_fig_specs.mjs
│
└── docs/
    └── FIG_AUTOCOMPLETE_INTEGRATION_PLAN.zh-CN.md
```

---

# 51. 最终完成判定

## A. Static Spec

```text
[ ] 100+ upstream specs 可加载
[ ] alias 正确
[ ] options 正确
[ ] args 正确
[ ] nested subcommands 正确
[ ] -- 正确
[ ] replacement range 正确
```

## B. Generator

```text
[ ] git dynamic
[ ] kubectl dynamic
[ ] helm dynamic
[ ] file provider
[ ] timeout
[ ] cancellation
[ ] stale response drop
```

## C. Target

```text
[ ] local macOS
[ ] local Linux
[ ] local Windows
[ ] WSL
[ ] SSH Linux
[ ] SSH macOS
[ ] SSH Windows
```

## D. UI

```text
[ ] light theme
[ ] dark theme
[ ] above
[ ] below
[ ] constrained height
[ ] right edge clamp
[ ] SSH RTT resettle
[ ] keyboard ownership tests
```

## E. Stability

```text
[ ] completion failure never blocks PTY
[ ] worker crash recovery
[ ] generator process cleanup
[ ] remote timeout
[ ] session switch stale result cleanup
```

---

# 52. 推荐的实际落地顺序

严格按下面顺序做，避免一次把 parser / generator / target / UI 全部揉在一起：

```text
Step 1
CompletionItem + CompletionEdit

Step 2
EditBufferState + revision

Step 3
CompletionController

Step 4
Worker 化现有 spec parser

Step 5
Fig adapter + upstream parser snapshot

Step 6
Fig static specs

Step 7
CompletionHost RPC

Step 8
SSH / Local executor

Step 9
Declarative generators

Step 10
Filesystem provider

Step 11
WSL

Step 12
Custom JS generator

Step 13
全量 spec corpus

Step 14
Legacy spec 下线
```

---

# 53. 对当前分支的最小改动起点

不建议现在再继续往 `frontend/src/lib/completions/spec.ts` 里堆 Fig 特性。

第一组真正应该开始写的文件是：

```text
frontend/src/lib/completion/core/types.ts
frontend/src/lib/completion/core/edit.ts
frontend/src/lib/completion/CompletionController.ts
frontend/src/lib/completion/worker/completion.worker.ts
```

然后把现有：

```ts
matchSpecLine(pendingTerminalInput, COMPLETION_SPECS)
```

封装进：

```ts
LegacyCompletionProvider
```

这一步完成后，后面接 Fig parser 就只是新增 provider，不再需要继续改 App.vue 的键盘 / overlay / SSH 代码。

Rust 侧第一组文件：

```text
backend/src/completion/mod.rs
backend/src/completion/protocol.rs
backend/src/completion/executor.rs
backend/src/completion/local.rs
backend/src/completion/ssh.rs
backend/src/main.rs
```

先跑通：

```text
local git branch
SSH git branch
```

再接其他 generator。

---

# 54. CI 验收命令

保持当前项目既有门禁，再增加 completion 专项：

```bash
pnpm --dir frontend typecheck
pnpm --dir frontend test
pnpm --dir frontend build

pnpm --dir frontend fig:test
pnpm --dir frontend fig:verify

cargo test --manifest-path backend/Cargo.toml
```

最终 smoke：

```text
local terminal smoke
SSH terminal smoke
completion static smoke
completion dynamic smoke
Windows / WSL smoke
```

任何 completion failure 都不能导致：

```text
PTY input failure
SSH terminal failure
local terminal failure
```

---

# 55. 实施后的最终责任边界

```text
Vue / App.vue
  只负责 UI + xterm + edit application

CompletionController
  只负责生命周期 / revision / UI state

Completion Worker
  只负责 Fig parser / resolver / ranking / generator scheduling

CompletionHost
  只负责 target capabilities

Rust Completion Executor
  只负责进程 / SSH / WSL / filesystem / timeout / security

xterm.js
  只负责 terminal rendering / terminal input

PTTY
  只负责真实 shell
```

这套边界一旦建立，未来增加：

```text
Docker target
Kubernetes exec target
MCP target
Container target
Serial target
```

都只需要增加新的 `CompletionTarget` / `CompletionExecutor`，不需要再次改 Fig parser。

---

## 结论

针对当前 `dbx-plugin-ssh`，最合理的集成不是“把 Fig 搬进项目”，而是把 Fig/Amazon Q 的 **Spec + Parser + Generator model** 当成 completion engine，把你现有的 **Rust sidecar + xterm.js + SSH/local PTY** 当成 host runtime。

这样才能同时满足：

```text
Fig spec 兼容
+ SSH target-side generator
+ 本地 completion
+ Windows / Linux / macOS
+ WSL
+ 当前 xterm overlay
+ 当前 #120 replacement / positioning 修复
+ 不影响 PTY 稳定性
```

并且可以从当前分支以最小风险渐进迁移，而不是重新造一个终端补全系统。
