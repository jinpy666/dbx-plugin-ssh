#!/usr/bin/env node
// mockDbxHost 注册表比对（docs/MOCK_HOST_STRICTNESS_PLAN.zh-CN.md）：
// 后端 handle_request 分派表（backend/src/main.rs 的 "域/动作" => case）为
// 事实全集，四路比对：
//   ① backend 分派（含 `"a" | "b" =>` 别名臂）
//   ② mock 已实现方法（mockDbxHost.ts 的 method === "..." 比较）
//      缺口 = 后端有、mock 未实现、且不在 ALLOWLIST/SKIP → exit 1；
//      幽灵 = ALLOWLIST/SKIP 里不存在于后端全集的拼错项 → exit 1。
//   ③ 前端 invoke 字面量（frontend/src 的 .invoke("域/动作"）——前端调用
//      后端不存在的方法会在运行时静默落 "Method not found" → exit 1。
//   ④ docs/PROTOCOL.zh-CN.md 的方法条目——report-only 警告（文档允许短暂
//      滞后，但滞后必须可见）。
// 白名单/SKIP 逐条带注释；`域/*` 形式按前缀整域声明。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendSrc = readFileSync(join(root, "backend/src/main.rs"), "utf8");
const mockSrc = readFileSync(join(root, "frontend/src/mockDbxHost.ts"), "utf8");

// 方法名段含连字符（ssh/host-key/resolve 等）：字符集必须收 `-`，否则别名
// 臂与前端的这些方法全部静默漏检（原脚本的盲区）。
const METHOD_PATTERN = "[a-z][a-z0-9_-]*(?:/[a-z0-9_-]+)+";
const METHOD_RE = new RegExp(METHOD_PATTERN, "g");

const backendMethods = new Set();
// 别名臂 `"vnc/input" | "vnc/write" =>`：整行的每个名字都是真实分派入口，
// 单名正则会把整行漏掉（盲区）。
for (const m of backendSrc.matchAll(
  new RegExp(`^\\s*"(${METHOD_PATTERN})"(?:\\s*\\|\\s*"(${METHOD_PATTERN})")*\\s*=>`, "gm"),
)) {
  for (const alias of m[0].matchAll(new RegExp(`"(${METHOD_PATTERN})"`, "g"))) {
    backendMethods.add(alias[1]);
  }
}

const mockMethods = new Set();
for (const m of mockSrc.matchAll(new RegExp(`method === "(${METHOD_PATTERN})"`, "g"))) {
  mockMethods.add(m[1]);
}

// 前端 invoke 字面量：剥掉 invoke<T> 的泛型（可跨行、不含分号/圆括号）后
// 匹配 `.invoke("method"`（模板串拼接的动态方法天然不在字面量集）。
function collectFrontendSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFrontendSources(full));
    } else if ((name.endsWith(".ts") || name.endsWith(".vue")) && !name.endsWith(".spec.ts")) {
      out.push(readFileSync(full, "utf8"));
    }
  }
  return out;
}
const frontendInvokeMethods = new Set();
for (const source of collectFrontendSources(join(root, "frontend/src"))) {
  const stripped = source.replace(/\.invoke<[^();{}]*>/g, ".invoke");
  for (const m of stripped.matchAll(new RegExp(`\\.invoke\\(\\s*"(${METHOD_PATTERN})"`, "g"))) {
    frontendInvokeMethods.add(m[1]);
  }
}

// docs/PROTOCOL.zh-CN.md 的方法条目（列表项反引号开头的 RPC 名）。
const docsSrc = readFileSync(join(root, "docs/PROTOCOL.zh-CN.md"), "utf8");
const docMethods = new Set();
for (const m of docsSrc.matchAll(new RegExp(`^- \\\`(${METHOD_PATTERN})\\\``, "gm"))) {
  docMethods.add(m[1]);
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
  // 连接挑战与主机密钥确认：fixture 不走真实 connect 流程，挑战臂不触达
  // （TunnelManager 的隧道连接同样不在走查主链路）
  "connection/challenge/resolve",
  "ssh/host-key/check",
  "ssh/host-key/resolve",
  // 本地终端启动选项面板：走查未打开本地终端的启动配置
  "local/terminal/launch-options",
  // 浏览器 File 车道上传：走查上传走宿主桥/mock 文件，不经该入口
  "sftp/upload-local",
  // 符号链接管理：走查不创建/查看符号链接
  "sftp/symlink-create",
  "sftp/symlink-read",
  "sftp/symlink-update",
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
  "watch/stop-all", // 卸载兜底全停（App.vue onBeforeUnmount），走查关闭 tab 不经此 RPC
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
// 前端调后端不存在的方法：运行时静默落 "Method not found"，必须编译期拦下。
const feMissing = [...frontendInvokeMethods]
  .filter((method) => !backendMethods.has(method))
  .sort();
// 文档滞后：backend 有、PROTOCOL 无。report-only——文档允许短暂滞后，但
// 必须在检查输出里可见，防止"文档没人看"退化成"文档没人写"。
const docsMissing = [...backendMethods]
  .filter((method) => !docMethods.has(method))
  .sort();

let failed = false;
if (gaps.length || ghosts.length) {
  failed = true;
  if (gaps.length) {
    console.error(`mockDbxHost 未实现且未声明（${gaps.length}）：`);
    for (const method of gaps) console.error(`  - ${method}`);
    console.error("处理三选一：实现桩 / 加 ALLOWLIST（注释理由）/ 加 SKIP（GUI 走查不触达）");
  }
  if (ghosts.length) {
    console.error(`ALLOWLIST/SKIP 拼错（后端无此方法，${ghosts.length}）：`);
    for (const method of ghosts) console.error(`  - ${method}`);
  }
}
if (feMissing.length) {
  failed = true;
  console.error(`前端 invoke 了后端不存在的方法（${feMissing.length}）：`);
  for (const method of feMissing) console.error(`  - ${method}`);
  console.error("处理：补 backend 分派臂，或修正前端方法名（运行时会静默 Method not found）");
}
if (docsMissing.length) {
  console.warn(
    `[report-only] docs/PROTOCOL.zh-CN.md 缺以下 ${docsMissing.length} 个后端方法的条目：`,
  );
  for (const method of docsMissing) console.warn(`  - ${method}`);
}
if (failed) process.exit(1);
console.log(
  `mock host registry check PASS: backend ${backendMethods.size} methods (aliases included), mock ${mockMethods.size} implemented, frontend-invoke ${frontendInvokeMethods.size} verified, allowlist ${ALLOWLIST.size}, skip ${SKIP_EXACT.size + SKIP_PREFIXES.length}, docs ${docMethods.size}/${backendMethods.size} documented`,
);
