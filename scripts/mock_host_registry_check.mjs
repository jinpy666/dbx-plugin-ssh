#!/usr/bin/env node
// mockDbxHost 注册表比对（docs/MOCK_HOST_STRICTNESS_PLAN.zh-CN.md）：
// 后端 handle_request 分派表（backend/src/main.rs 的 "域/动作" => case）为
// 事实全集，与 mock 的已实现方法（frontend/src/mockDbxHost.ts 的
// method === "..." 比较）比对：
//   缺口 = 后端有、mock 未实现、且不在 ALLOWLIST/SKIP → exit 1；
//   幽灵 = ALLOWLIST/SKIP 里不存在于后端全集的拼错项 → exit 1。
// 白名单/SKIP 逐条带注释；`域/*` 形式按前缀整域声明。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendSrc = readFileSync(join(root, "backend/src/main.rs"), "utf8");
const mockSrc = readFileSync(join(root, "frontend/src/mockDbxHost.ts"), "utf8");

const backendMethods = new Set();
for (const m of backendSrc.matchAll(/^\s*"([a-z][a-z0-9_]*(?:\/[a-z0-9_]+)+)" =>/gm)) {
  backendMethods.add(m[1]);
}

const mockMethods = new Set();
for (const m of mockSrc.matchAll(/method === "([a-z][a-z0-9_]*(?:\/[a-z0-9_]+)+)"/g)) {
  mockMethods.add(m[1]);
}

// mock 未实现、但调用方依赖默认成功语义的方法（默认分支已改为 throw）。
// 逐条注释理由；不允许 `域/*` 前缀项——白名单必须精确到方法。
const ALLOWLIST = new Set([
  // "sftp/transfer/history/clear" 例子占位：纯通知/幂等类
]);

// 真实宿主/会话能力，GUI 走查主链路不触达；显式列出而非静默漏掉。
// 依据：默认分支改 throw 后跑 smoke_ui_mock / smoke_ui_settings 与前端全量
// 单测（2026-09 review-fix-5 轮），以下方法零触达——触达即抛错显形，届时
// 按真实调用形状补桩（禁止凭空编形状）再从这里移除。
// `域/*` 形式按前缀整域声明。
const SKIP_PREFIXES = [
  "completion/*", // 补全执行面走 host 侧通道（completion::executor 内部分派），走查不触达
  "mcp/*", // MCP 工具面是给 AI 的执行面，工作台经设置页管理而非逐方法调用
  "rdp/*", // RDP 会话域：GUI 冒烟无 RDP 服务，连不上即不会触达
  "serial/*", // 串口域：CI 无串口硬件
  "telnet/*", // Telnet 域：冒烟走 SSH 容器
  "vnc/*", // VNC 域：冒烟无 VNC 服务
];
const SKIP_EXACT = new Set([
  // 连接管理：mock 环境的会话由外层 fixture 预置，不走真实 connect 流程
  "connection/action",
  "connection/connect",
  "connection/disconnect",
  "connection/test",
  // 宿主 filesystem-provider 贡献点：宿主桥能力，走查不挂载
  "filesystem/delete",
  "filesystem/list",
  "filesystem/read",
  "filesystem/rename",
  "filesystem/write",
  // 导入向导预览会话：设置走查未进入导入流程
  "import/preview/cancel",
  "import/preview/finish",
  "import/preview/start",
  // 密钥发现表单选项：设置走查未打开密钥发现
  "keys/discover/options",
  // 本机文件管理器/壁纸：桌面宿主能力，走查环境 no-op 不安全（会真开窗口）
  "local/open",
  "local/reveal",
  "local/wallpaper/clear",
  "local/wallpaper/get",
  "local/wallpaper/set",
  // 树下载/续传面板/传输状态：走查传输流程走单文件链路
  "sftp/download/tree/start",
  "sftp/transfer/resumable",
  "sftp/transfer/status",
  // 智能体终端模式与指标历史：走查未打开对应面板
  "ssh/agent/mode/get",
  "ssh/agent/resolve",
  "ssh/metrics/history",
  // 终端录制：走查未点录制
  "ssh/recording/start",
  "ssh/recording/stop",
  // 会话生命周期与状态：mock 会话由 fixture 预置，close/status 不经分派链
  "ssh/session/close",
  "ssh/status",
  "ssh/terminal/resize",
  // sudo 模式文件操作：走查未启用 sudo 模式
  "sudo/exists",
  "sudo/profiles/options",
  "sudo/rename",
  "sudo/stat",
  "sudo/touch",
  // 终端触发器校验：设置走查未编辑触发器
  "triggers/validate",
  // 文件监视（预览冲突检测）：走查未进入编辑冲突路径
  "watch/start",
  "watch/stop",
  "watch/upload",
  // 宿主 1.1 workbenchState 关闭事件：走查关闭 tab 不经此 RPC
  "workbench/close",
]);

const skipMatched = (method) =>
  SKIP_EXACT.has(method) ||
  SKIP_PREFIXES.some((prefix) => {
    if (!prefix.endsWith("/*")) return false;
    return method.startsWith(prefix.slice(0, -1)); // "serial/*" → "serial/"
  });

const gaps = [...backendMethods]
  .filter((method) => !mockMethods.has(method) && !ALLOWLIST.has(method) && !skipMatched(method))
  .sort();
const ghosts = [...ALLOWLIST, ...SKIP_EXACT, ...SKIP_PREFIXES]
  .filter((method) => !method.endsWith("/*") && !backendMethods.has(method))
  .sort();

if (gaps.length || ghosts.length) {
  if (gaps.length) {
    console.error(`mockDbxHost 未实现且未声明（${gaps.length}）：`);
    for (const method of gaps) console.error(`  - ${method}`);
    console.error("处理三选一：实现桩 / 加 ALLOWLIST（注释理由）/ 加 SKIP（GUI 走查不触达）");
  }
  if (ghosts.length) {
    console.error(`ALLOWLIST/SKIP 拼错（后端无此方法，${ghosts.length}）：`);
    for (const method of ghosts) console.error(`  - ${method}`);
  }
  process.exit(1);
}
console.log(
  `mock host registry check PASS: backend ${backendMethods.size} methods, mock ${mockMethods.size} implemented, allowlist ${ALLOWLIST.size}, skip ${SKIP_EXACT.size + SKIP_PREFIXES.length}`,
);
