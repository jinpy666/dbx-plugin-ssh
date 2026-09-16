const eventListeners = new Set<(event: DbxPluginEvent) => void>();
const binaryListeners = new Set<(event: DbxPluginBinaryEvent) => void>();
const appearanceListeners = new Set<(appearance: DbxPluginAppearance) => void>();
const contextListeners = new Set<(context: Record<string, unknown>) => void>();

const fixtureParams = new URLSearchParams(location.search);
// ?render=dom 强制关闭终端 WebGL 加速（localStorage 偏好）：mock walkthrough
// 的终端断言读 DOM 文本，WebGL 渲染下文本只存在于 GPU canvas，必须锁定
// DOM 渲染器路径（WebGL 自身的成功/回退由 terminalWebgl 单测覆盖）。
if (fixtureParams.get("render") === "dom") {
  try { localStorage.setItem("ssh-terminal-webgl", "0"); } catch { /* noop */ }
}
// ?rw=1 模拟可写连接（默认只读），供拖放上传等写路径 UI 验证。
const writable = fixtureParams.get("rw") === "1";
// ?err=disconnect 在会话建立 4s 后模拟一次传输断开（ssh/session/state
// disconnected，单次不复发），供重连横幅/倒计时/立即重连/恢复提示的全流程 UI 验证。
// 断开定时器同时挂在 open 与 attach 两条启动路径上：默认启动走
// sessions/list → reattach，只挂 open 会让该参数在首屏完全失效（P2-1）。
const disconnectAfterMs = fixtureParams.get("err") === "disconnect" ? 4000 : 0;
let disconnectEmitted = false;
// ?err=authfail 让 ssh/session/open 抛出真实 sidecar 风格的认证失败错误串，
// 供连接失败错误提示友好化（connectError.*）的浏览器 UI 验证。
const failSessionOpen = fixtureParams.get("err") === "authfail";
// 初始 locale 支持 ?locale= 覆盖（镜像真实桥 api.locale）；运行时经
// __dbxMockSetLocale 切换（镜像宿主桥 updateLocale 的"改字段 + 推监听"语义），
// 供 i18n 切换链（onLocaleChange）的浏览器与单测验证。
let currentLocale = fixtureParams.get("locale") || "en";
const localeListeners = new Set<(locale: string) => void>();
// 与 DBX globals.css 的 :root（pearl 浅色）和 .dark 规范块保持一致。
const light = fixtureParams.get("theme") === "light";

const context = {
  connectionId: "visual-connection",
  workbenchId: "visual-workbench",
  restored: false,
  workbenchState: { sftpPath: "/home/demo", splitRatio: 58, paneOrder: "terminal-left", visibleColumns: ["size", "modified", "permissions"] },
  connection: { name: "Production SSH", host: "192.168.1.64", port: 22, username: "user", color: "#3b82f6", readOnly: !writable },
};

const appearance: DbxPluginAppearance = {
  colorScheme: light ? "light" : "dark",
  colors: light
    ? { background: "rgb(255 255 255)", foreground: "rgb(10 10 10)", muted: "rgb(245 245 245)", mutedForeground: "rgb(115 115 115)", accent: "rgb(245 245 245)", accentForeground: "rgb(23 23 23)", border: "rgb(229 229 229)", destructive: "rgb(231 0 11)" }
    : { background: "rgb(19 20 22)", foreground: "rgb(215 215 219)", muted: "rgb(42 42 45)", mutedForeground: "rgb(151 152 157)", accent: "rgb(46 47 51)", accentForeground: "rgb(221 221 226)", border: "rgb(110 110 114 / 0.28)", destructive: "rgb(243 98 95)" },
  terminal: { fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace", fontSize: 13 },
};

// 镜像宿主 1.1 theme 通道形状（colors 反查 --color-* 令牌），与真实宿主一致。
const theme: DbxPluginTheme = {
  appearance: appearance.colorScheme,
  tokens: Object.fromEntries(
    Object.entries(appearance.colors).map(([key, value]) => [`--color-${key.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)}`, value]),
  ),
};

function terminalFrame(sequence: number, text: string) {
  const data = new TextEncoder().encode(text);
  const frame = new Uint8Array(9 + data.length);
  frame[0] = 0;
  new DataView(frame.buffer).setBigUint64(1, BigInt(sequence), false);
  frame.set(data, 9);
  return frame;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let sequence = 0;
function emitTerminal(text: string) {
  sequence += 1;
  // mock 镜像当前宿主桥的二进制事件形状（零拷贝 data 字段），与真实宿主一致。
  const event = { channel: "ssh/terminal/out/visual-session", data: terminalFrame(sequence, text) };
  for (const listener of binaryListeners) listener(event);
}

// ---- 内存 fixture 树：路径感知的 sftp/list 与写操作（无条件生效，无开关参数）----
interface MockNode {
  name: string;
  kind: "directory" | "file";
  size: number;
  modifiedAt: number;
  permissions: string;
  children?: MockNode[];
}

let mockStamp = 1786262400;
function nextMockStamp() {
  mockStamp += 3600;
  return mockStamp;
}
function mockDir(name: string, children: MockNode[] = []): MockNode {
  return { name, kind: "directory", size: 0, modifiedAt: nextMockStamp(), permissions: "0755", children };
}
function mockFile(name: string, size: number, permissions = "0644"): MockNode {
  return { name, kind: "file", size, modifiedAt: nextMockStamp(), permissions };
}

const mockTree: MockNode = mockDir("/", [
  mockDir("home", [
    mockDir("demo", [
      mockDir(".config"),
      mockDir("projects"),
      mockFile("deploy.sh", 2481, "0755"),
      mockFile("docker-compose.yml", 8192),
      mockFile("server.log", 741248),
      // 超长名称夹具：锁定 SFTP 文件列表/侧栏/预览标题在极端宽度下的省略号
      // 截断（回归：长名曾把行布局挤错位）。
      mockDir("a-very-long-directory-name-that-easily-overflows-narrow-side-panels"),
      mockFile("release-artifact-bundle-2026-09-15-final-signed-verification-report.pdf", 999_999),
    ]),
  ]),
  mockDir("etc", [mockFile("hosts", 221), mockDir("nginx", [mockFile("nginx.conf", 1264)])]),
  mockDir("tmp"),
  mockDir("var", [mockDir("log", [mockFile("syslog", 15432)])]),
  mockDir("root"),
]);

function normalizeMockPath(path: string): string {
  let value = (path || "/").trim() || "/";
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  return value === "/" ? value : value.replace(/\/+$/, "");
}

function findMockNode(path: string): MockNode | null {
  const normalized = normalizeMockPath(path);
  if (normalized === "/") return mockTree;
  let node: MockNode = mockTree;
  for (const segment of normalized.slice(1).split("/")) {
    const next = node.children?.find((child) => child.name === segment);
    if (!next) return null;
    node = next;
  }
  return node;
}

function mockParentAndName(path: string): { parent: MockNode | null; name: string } {
  const normalized = normalizeMockPath(path);
  const index = normalized.lastIndexOf("/");
  const parentPath = index <= 0 ? "/" : normalized.slice(0, index);
  return { parent: findMockNode(parentPath), name: normalized.slice(index + 1) };
}

function mockEntryOf(node: MockNode, parentPath: string) {
  return {
    name: node.name,
    uri: `sftp:${parentPath === "/" ? "" : parentPath}/${node.name}`,
    kind: node.kind,
    ...(node.kind === "file" ? { size: node.size } : {}),
    modifiedAt: node.modifiedAt,
    permissions: node.permissions,
  };
}

function mockList(path: string) {
  const parentPath = normalizeMockPath(path);
  const node = findMockNode(parentPath);
  if (!node || node.kind !== "directory") throw new Error(`sftp: no such directory: ${parentPath}`);
  return (node.children ?? [])
    .map((child) => mockEntryOf(child, parentPath))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
}

function mockWriteEntry(path: string, node: MockNode): { success: true } {
  const { parent, name } = mockParentAndName(path);
  if (!parent || parent.kind !== "directory" || !name || parent.children?.some((child) => child.name === name)) {
    throw new Error(`sftp: cannot write ${normalizeMockPath(path)}`);
  }
  parent.children!.push(node);
  return { success: true };
}

const fixtureDownloads = new Map<string, { fileName: string; size: number; offset: number }>();
const fixtureUploadCount = { value: 0 };
// 可视化 mock 也需要具备真实的“清空后刷新为空”语义，否则历史工具栏
// 的刷新/清空按钮看起来没有效果。
let mockTransferHistoryCleared = false;
// 编辑器 sftp/write 落盘的内存副本（按路径）：sftp/read 优先回读，保证
// "保存 → 重开预览" 在可视化夹具里闭环（真实 sidecar 写远端文件）。
const mockFileContents = new Map<string, Uint8Array>();
// 全局快速命令（ssh/quickCommands/*）与批量发送（ssh/terminal/batchInput）的
// mock 状态：镜像真实 sidecar 的响应形状与上限/错误语义，防可视化夹具脱节。
const QUICK_COMMANDS_LIMIT = 20;
const quickCommandsState: { id: string; name: string; command: string; createdAt: number; updatedAt: number }[] = [];
const settingsState = { quickSudo: true, sudoUsePty: false, sudoPasswordSet: true, totpConfigured: false, authFlowMode: "password_then_otp", passwordPromptHint: "", totpPromptHint: "", agentTerminalMode: "off", rememberedCommands: [] as string[] };

// 关键词高亮规则（ssh/highlightRules/*）mock 状态：镜像 sidecar 存储
// （highlight-rules.json，0600）的响应形状/上限/默认值语义，并镜像后端
// 首次初始化播种的 22 条默认规则（highlight_rules::DEFAULT_RULE_SPECS：
// 严重度分色，长短语精确、词干兜底），防可视化夹具脱节。
const HIGHLIGHT_RULES_LIMIT = 30;
const HIGHLIGHT_PATTERN_MAX = 200;
const HIGHLIGHT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HIGHLIGHT_DEFAULT_SEEDS: Array<{ id: string; pattern: string; color: string; caseSensitive?: boolean; isRegex?: boolean }> = [
  { id: "default-error", pattern: "ERROR", color: "#ef4444" },
  { id: "default-fatal", pattern: "FATAL", color: "#ef4444" },
  { id: "default-permission-denied", pattern: "Permission denied", color: "#ef4444" },
  { id: "default-no-such-file", pattern: "No such file or directory", color: "#ef4444" },
  { id: "default-command-not-found", pattern: "command not found", color: "#ef4444" },
  { id: "default-connection-refused", pattern: "Connection refused", color: "#ef4444" },
  { id: "default-no-space-left", pattern: "No space left on device", color: "#ef4444" },
  { id: "default-failed-to", pattern: "Failed to", color: "#ef4444" },
  { id: "default-cannot", pattern: "cannot", color: "#ef4444" },
  { id: "default-exception", pattern: "Exception", color: "#ef4444" },
  { id: "default-traceback", pattern: "Traceback (most recent call last)", color: "#ef4444" },
  { id: "default-fail", pattern: "FAIL", color: "#f59e0b" },
  { id: "default-denied", pattern: "denied", color: "#f59e0b" },
  { id: "default-timed-out", pattern: "timed out", color: "#f59e0b" },
  { id: "default-warn", pattern: "WARN", color: "#facc15" },
  { id: "default-deprecated", pattern: "deprecated", color: "#facc15" },
  { id: "default-success", pattern: "SUCCESS", color: "#22c55e" },
  { id: "default-active-running", pattern: "active (running)", color: "#22c55e" },
  { id: "default-done", pattern: "done", color: "#22c55e" },
  { id: "default-check", pattern: "✓", color: "#22c55e" },
  { id: "default-passed", pattern: "PASSED", color: "#22c55e", caseSensitive: true },
  { id: "default-ipv4", pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b", color: "#3b82f6", isRegex: true },
];
let highlightRuleSeq = 0;
let metricsRefreshTick = 0;
interface MockHighlightRule { id: string; pattern: string; isRegex: boolean; color: string; caseSensitive: boolean; enabled: boolean; createdAt: number; updatedAt: number }
const highlightRulesState: MockHighlightRule[] = HIGHLIGHT_DEFAULT_SEEDS.map(({ id, pattern, color, caseSensitive = false, isRegex = false }) => ({
  id, pattern, isRegex, color, caseSensitive, enabled: true, createdAt: 1786262400, updatedAt: 1786262400,
}));
const highlightRuleViews = () => [...highlightRulesState].sort((a, b) => a.createdAt - b.createdAt);

// MCP 设置（mcp/settings/get|set）新字段（IMPL_PLAN_NETCATTY_PARITY §1.3）：
// 权限档与连接作用域，镜像持久化 + 校验语义。
const mcpSettingsState = { execPermissionMode: "autonomous", connectionScope: [] as string[] };
// 镜像并行批次 ssh/audit/list 的真实形状（AuditEntry：tsMs/tool/connectionId/
// gate/approval/outcome/exitCode/durationMs/mode/command/output/error，
// 0.4.77 起带 command/output 尾部）；末条保留计划 §1.1 旧形状（ts 秒 + kind +
// command）验证前端多形状容忍。
const AUDIT_FIXTURE: Array<Record<string, unknown>> = [
  { tsMs: 1786262400000, tool: "ssh_exec", connectionId: "Production SSH", gate: "pass", approval: "none", outcome: "ok", exitCode: 0, durationMs: 812, mode: "stdio", command: "df -h /data", output: "Filesystem Size Used Avail Capacity Mounted on\n/dev/vda1 98G 41G 52G 45% /data" },
  { tsMs: 1786262460000, tool: "ssh_exec_sudo", connectionId: "Production SSH", gate: "pass", approval: "prompt", outcome: "ok", exitCode: 0, durationMs: 2310, mode: "terminal", command: "systemctl restart nginx" },
  { tsMs: 1786262520000, tool: "ssh_exec", connectionId: "Production SSH", gate: "destructive-unconfirmed", approval: "none", outcome: "error", error: "destructive command requires confirmDestructive: true", durationMs: 3, mode: "stdio", command: "rm -rf /var/log/old" },
  { tsMs: 1786262580000, tool: "ssh_terminal_input", connectionId: "Production SSH", gate: "write-denied", approval: "none", outcome: "error", durationMs: 1, mode: "embedded" },
  { ts: 1786262640, kind: "agent.challenge", sessionId: "visual-session", command: "rm -rf /tmp/scratch", decision: "approved", risk: "elevated" },
];
let auditEntriesState: Array<Record<string, unknown>> = AUDIT_FIXTURE.map((entry) => ({ ...entry }));

// 录制回放 fixture：一条 ~24s 的输出事件流，供录制浮条与回放弹窗（进度条/
// 倍速/GIF 导出）走查。data 为直写 xterm 的原始文本（asciicast eventdata）。
const RECORDING_FIXTURE_EVENTS = [
  { time: 0, type: "o", data: "user@server:~$ ./deploy.sh --env=production\r\n" },
  { time: 1.2, type: "o", data: "[1/4] building image …\r\n" },
  { time: 4.5, type: "o", data: "[2/4] pushing registry.demo.internal/app:1.4.2\r\n" },
  { time: 9.8, type: "o", data: "[3/4] rolling update 3/3 replicas ✓\r\n" },
  { time: 15.4, type: "o", data: "[4/4] health check passed (200 OK)\r\n" },
  { time: 18.0, type: "o", data: "deploy finished SUCCESS in 17.6s\r\n" },
  { time: 23.5, type: "o", data: "user@server:~$ " },
];
const RECORDING_FIXTURE_SUMMARY = {
  recordingId: "visual-recording-1",
  sessionId: "visual-session",
  host: "server.demo.internal",
  startedAt: Date.now() - 3_600_000,
  durationSecs: 23.5,
  bytes: 4096,
};


// 模拟 VS Code 风格 shell-integration 周期（OSC 633），让 command-marker 条
// 在 open 与 reattach 两条启动路径下都有内容可渲染（P2-2）。
const OSC_633 = "\u001b]633;";
const BEL = "\u0007";
const shellIntegrationCycle = [
  `${OSC_633}P;Cwd=/home/demo${BEL}`,
  `${OSC_633}A${BEL}`,
  `${OSC_633}E;systemctl status nginx${BEL}`,
  "user@server:~$ systemctl status nginx\r\n",
  `${OSC_633}C${BEL}`,
  "● nginx.service - A high performance web server\r\n   Active: active (running)\r\n",
  `${OSC_633}D;0${BEL}`,
  // 默认高亮规则的演示输出：挂载即可见红（ERROR/No such file/command not
  // found）、黄（WARN）、琥珀（denied/timed out）、绿（SUCCESS/active running）、
  // 蓝（IPv4）五类着色。
  "user@server:~$ tail -n 3 /var/log/deploy.log\r\n",
  "2026-09-11 10:00:01 WARN disk usage 87%\r\n",
  "2026-09-11 10:00:04 ERROR Permission denied: /var/backup\r\n",
  "2026-09-11 10:00:09 deploy finished SUCCESS\r\n",
  "user@server:~$ cat /etc/nope; bash xyz\r\n",
  "cat: /etc/nope: No such file or directory\r\n",
  "bash: xyz: command not found\r\n",
  "user@server:~$ curl -m 3 http://10.0.0.12:8080/health\r\n",
  "curl: (28) Connection timed out\r\n",
  `${OSC_633}A${BEL}`,
  "user@server:~$ ",
].join("");
const terminalTranscript = `Welcome to DBX SSH/SFTP visual fixture\r\n${shellIntegrationCycle}`;

// ?err=disconnect 注入入口：open 与 attach 完成后都调用一次；全局单发，
// 重连（再次 open/attach）后不再复发，与真实传输断开的单次语义一致。
function scheduleDisconnect() {
  if (!disconnectAfterMs || disconnectEmitted) return;
  disconnectEmitted = true;
  setTimeout(() => {
    for (const listener of eventListeners) listener({ method: "ssh/session/state", params: { sessionId: "visual-session", state: "disconnected" } });
  }, disconnectAfterMs);
}

const request: DbxPluginApi["request"] = async <T = unknown>(method: string) =>
  (method === "host.getContext" ? context : null) as T;

const invoke: DbxPluginApi["invoke"] = async <T = unknown>(method: string, params?: unknown) => {
  let result: unknown;
  if (method === "ssh/session/open") {
    if (failSessionOpen) throw new Error("SSH password authentication failed: password rejected by server");
    // A fresh session restarts sequence numbering at 1 (real sidecar
    // semantics): after an auto-reconnect the client resets its cursor to 0,
    // so continuing the global counter here would leave a permanent hole at
    // the old tail and spin the client's replay loop.
    sequence = 0;
    setTimeout(() => emitTerminal(terminalTranscript), 30);
    scheduleDisconnect();
    result = { sessionId: "visual-session", connectionId: context.connectionId, workbenchId: context.workbenchId, connected: true, sequence: 0, chunkSize: 262144, directoryTrackingSupported: true };
  } else if (method === "ssh/terminal/replay") result = { frameCount: 0, firstAvailableSequence: 1, tailSequence: sequence, complete: true };
  else if (method === "ssh/sessions/list") result = { sessions: failSessionOpen ? [] : [{ sessionId: "visual-session", connectionId: context.connectionId, workbenchId: context.workbenchId, readOnly: !writable, connected: true, sudoKeepalive: true, createdAt: Math.floor(Date.now() / 1000), authMethod: "private-key", host: "server.demo.internal", port: 22, username: "demo" }] };
  else if (method === "ssh/session/attach") {
    const input = params as Record<string, unknown>;
    if (failSessionOpen) throw new Error("Connection is not active");
    // Mirror the real sidecar: the session already owned by this workbench is
    // reported with a complete replay. The transcript (Welcome + OSC 633
    // cycle) is pushed as live frames right after attach so the first paint
    // under the default reattach startup already shows shell-integration
    // content (P2-2), not a bare prompt.
    result = {
      sessionId: String(input.sessionId || "") || "visual-session",
      connectionId: context.connectionId,
      workbenchId: context.workbenchId,
      connected: true,
      sequence,
      chunkSize: 262144,
      directoryTrackingSupported: true,
      replay: { complete: true, frameCount: 0, firstAvailableSequence: sequence + 1, tailSequence: sequence },
    };
    setTimeout(() => emitTerminal(terminalTranscript), 30);
    scheduleDisconnect();
  }
  else if (method === "sftp/list" || method === "sudo/listDir") result = { entries: mockList(String((params as Record<string, unknown>)?.path || "/")) };
  else if (method === "sftp/home") result = { path: "/home/demo" };
  else if (method === "sftp/createDirectory" || method === "sudo/mkdir") result = mockWriteEntry(String((params as Record<string, unknown>)?.path || ""), mockDir(String((params as Record<string, unknown>)?.path || "/").split("/").pop() || "folder"));
  else if (method === "sftp/touch") result = mockWriteEntry(String((params as Record<string, unknown>)?.path || ""), mockFile(String((params as Record<string, unknown>)?.path || "").split("/").pop() || "file.txt", 0));
  else if (method === "sftp/archive") {
    const input = params as Record<string, unknown>;
    const sources = Array.isArray(input.sourcePaths) ? (input.sourcePaths as string[]) : [];
    const total = sources.reduce((sum, source) => sum + (findMockNode(source)?.size || 1024), 0);
    result = mockWriteEntry(String(input.archivePath || ""), mockFile(String(input.archivePath || "").split("/").pop() || "archive.tar.gz", Math.max(total, 512)));
  }
  else if (method === "sftp/extract") {
    const input = params as Record<string, unknown>;
    const destination = String(input.destinationPath || "");
    result = mockWriteEntry(destination, mockDir(destination.split("/").pop() || "extracted", [mockFile("README", 64)]));
  }
  else if (method === "sftp/delete" || method === "sudo/remove" || method === "sudo/removeAll") {
    const { parent, name } = mockParentAndName(String((params as Record<string, unknown>)?.path || ""));
    const index = parent?.children?.findIndex((child) => child.name === name) ?? -1;
    if (!parent || index < 0) throw new Error(`sftp: no such file: ${name}`);
    parent.children!.splice(index, 1);
    result = { success: true };
  }
  else if (method === "sftp/rename") {
    const input = params as Record<string, unknown>;
    const node = findMockNode(String(input.sourcePath || ""));
    if (!node) throw new Error(`sftp: no such file: ${input.sourcePath}`);
    const { parent: sourceParent, name: sourceName } = mockParentAndName(String(input.sourcePath || ""));
    const targetPath = normalizeMockPath(String(input.targetPath || ""));
    const { parent: targetParent, name: targetName } = mockParentAndName(targetPath);
    if (!sourceParent || !targetParent || targetParent.kind !== "directory" || !targetName) throw new Error(`sftp: cannot write ${targetPath}`);
    // 原子语义：先摘除目标位置同名节点（覆盖，对应前端 exists 预检确认），
    // 再摘源、改名、落位——撞名时源文件不再丢失（R3-P2-2 夹具缺陷收口）。
    const targetIndex = targetParent.children?.findIndex((child) => child.name === targetName && child !== node) ?? -1;
    if (targetIndex >= 0) targetParent.children!.splice(targetIndex, 1);
    const sourceIndex = sourceParent.children!.findIndex((child) => child.name === sourceName);
    sourceParent.children!.splice(sourceIndex, 1);
    node.name = targetName;
    targetParent.children!.push(node);
    result = { success: true };
  }
  else if (method === "sftp/exists") result = { exists: !!findMockNode(String((params as Record<string, unknown>)?.path || "")) };
  else if (method === "sftp/stat") {
    const node = findMockNode(String((params as Record<string, unknown>)?.path || ""));
    if (!node) throw new Error("sftp: no such file");
    result = { path: normalizeMockPath(String((params as Record<string, unknown>)?.path || "")), kind: node.kind, ...(node.kind === "file" ? { size: node.size } : {}), modifiedAt: node.modifiedAt, mode: node.permissions };
  }
  else if (method === "sftp/transfer/list") result = { tasks: [] };
  else if (method === "ssh/recording/list") result = { recordings: [RECORDING_FIXTURE_SUMMARY] };
  else if (method === "ssh/recording/get") {
    const input = (params || {}) as Record<string, unknown>;
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const limit = Math.max(1, Math.floor(Number(input.limit) || 500));
    const events = RECORDING_FIXTURE_EVENTS.slice(offset, offset + limit);
    result = { events, total: RECORDING_FIXTURE_EVENTS.length, hasMore: offset + events.length < RECORDING_FIXTURE_EVENTS.length };
  }
  else if (method === "ssh/recording/delete") result = { success: true };
  else if (method === "sftp/transfer/history") {
    // ?err=transferHistory 模拟历史查询失败，供面板 loadFailed+重试态走查。
    if (fixtureParams.get("err") === "transferHistory") throw new Error("sftp: transfer history unavailable");
    // 镜像真实 sidecar 契约（transfer-history.json 环形 200 + live 合并、
    // 新→旧排序、status 枚举无 queued、时间戳 Unix 毫秒、failed 带 error）。
    const input = (params || {}) as Record<string, unknown>;
    const limitRaw = Number(input.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
    const now = Date.now();
    const entries: Array<Record<string, unknown>> = mockTransferHistoryCleared ? [] : [
      { taskId: "visual-hist-4", connectionId: context.connectionId, direction: "upload", fileName: "deploy.sh", size: 2481, transferred: 2481, status: "completed", startedAt: now - 400_000, finishedAt: now - 396_000 },
      { taskId: "visual-hist-3", connectionId: context.connectionId, direction: "download", fileName: "server.log", size: 741_248, transferred: 741_248, status: "completed", startedAt: now - 800_000, finishedAt: now - 790_000 },
      { taskId: "visual-hist-2", connectionId: context.connectionId, direction: "download", fileName: "core.dump", size: 268_435_456, transferred: 268_435_456, status: "failed", startedAt: now - 1_600_000, finishedAt: now - 1_590_000, error: "disk quota exceeded" },
      { taskId: "visual-hist-1", connectionId: context.connectionId, direction: "upload", fileName: "backup.tar.gz", size: 52_428_800, transferred: 0, status: "cancelled", startedAt: now - 3_200_000, finishedAt: now - 3_190_000 },
    ];
    result = { tasks: entries.slice(0, limit) };
  }
  else if (method === "sftp/transfer/history/clear") {
    mockTransferHistoryCleared = true;
    result = { success: true };
  }
  else if (method === "local/capabilities") result = { canSaveLocal: false, downloadsDir: "" };
  else if (method === "sftp/upload/start") result = { taskId: `visual-upload-${++fixtureUploadCount.value}`, chunkSize: 262144 };
  else if (method === "sftp/upload/finish") result = { success: true };
  else if (method === "sftp/transfer/cancel") result = { success: true };
  else if (method === "sftp/write" || method === "sudo/writeFile") {
    // 镜像真实契约：整文件覆写（sftp/write 用 remotePath、sudo/writeFile 用
    // path）。节点必须已存在，内容驻留内存供读回，树节点 size 同步更新。
    const input = params as Record<string, unknown>;
    const writePath = normalizeMockPath(String(input.remotePath || input.path || ""));
    const node = findMockNode(writePath);
    if (!node || node.kind !== "file") throw new Error(`sftp: no such file: ${writePath}`);
    const bytes = Uint8Array.from(atob(String(input.dataBase64 || "")), (value) => value.charCodeAt(0));
    mockFileContents.set(writePath, bytes);
    node.size = bytes.byteLength;
    result = { success: true };
  }
  else if (method === "sftp/copy" || method === "sftp/move") {
    // 镜像 sftp/copy | sftp/move 契约：`from`（单个或数组）逐项执行进 `toDir`、
    // 保留基名；overwrite:false 时目标已存在按项失败；逐项回报
    // { from, to, ok, error? }，任一失败 success=false。move 额外摘除源节点。
    const input = params as Record<string, unknown>;
    const sources = Array.isArray(input.from) ? input.from.map(String) : [String(input.from || "")];
    const toDir = normalizeMockPath(String(input.toDir || ""));
    const overwrite = input.overwrite === true;
    const targetDir = findMockNode(toDir);
    if (!targetDir || targetDir.kind !== "directory") throw new Error(`sftp: no such directory: ${toDir}`);
    const rows = sources.map((source) => {
      const fromPath = normalizeMockPath(source);
      const name = fromPath.split("/").pop() || "";
      const toPath = `${toDir === "/" ? "" : toDir}/${name}`;
      try {
        const node = findMockNode(fromPath);
        if (!node || !name) throw new Error(`sftp: no such file: ${fromPath}`);
        const targetNode = findMockNode(toPath);
        if (targetNode && targetNode !== node && !overwrite) throw new Error(`sftp: target exists: ${toPath}`);
        if (targetNode && targetNode !== node) {
          const { parent } = mockParentAndName(toPath);
          const targetIndex = parent?.children?.indexOf(targetNode) ?? -1;
          if (!parent || targetIndex < 0) throw new Error(`sftp: cannot write ${toPath}`);
          parent.children!.splice(targetIndex, 1);
        }
        if (method === "sftp/move") {
          if (fromPath !== toPath) {
            const { parent: sourceParent } = mockParentAndName(fromPath);
            const sourceIndex = sourceParent?.children?.indexOf(node) ?? -1;
            if (!sourceParent || sourceIndex < 0) throw new Error(`sftp: no such file: ${fromPath}`);
            sourceParent.children!.splice(sourceIndex, 1);
            node.name = name;
            targetDir.children!.push(node);
          }
        } else if (!targetNode || targetNode !== node) {
          const copy = structuredClone(node);
          copy.name = name;
          targetDir.children!.push(copy);
        }
        return { from: fromPath, to: toPath, ok: true };
      } catch (cause) {
        return { from: fromPath, to: toPath, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    });
    result = { success: rows.every((row) => row.ok), results: rows };
  }
  else if (method === "sftp/read" || method === "sudo/readFile") {
    const readPath = normalizeMockPath(String((params as Record<string, unknown>)?.path || ""));
    const stored = mockFileContents.get(readPath);
    result = stored
      ? { dataBase64: base64(stored), truncated: false }
      : { dataBase64: base64(new TextEncoder().encode("#!/usr/bin/env bash\nset -euo pipefail\n\necho deploy\n")), truncated: false };
  }
  else if (method === "sftp/download/start") {
    const remotePath = normalizeMockPath(String((params as Record<string, unknown>)?.remotePath || "download.bin"));
    const node = findMockNode(remotePath);
    const taskId = `visual-download-${fixtureDownloads.size + 1}`;
    const fileName = node?.kind === "file" ? node.name : remotePath.split("/").pop() || "download.bin";
    const size = node?.kind === "file" ? node.size : 32;
    fixtureDownloads.set(taskId, { fileName, size, offset: 0 });
    for (const listener of eventListeners) listener({ method: "sftp/transfer/progress", params: { taskId, sessionId: "visual-session", direction: "download", fileName, transferred: 0, size, status: "queued" } });
    result = { taskId, fileName, size, chunkSize: 262144 };
  } else if (method === "sftp/download/next") {
    const input = params as Record<string, unknown>;
    const taskId = String(input.taskId || "");
    const task = fixtureDownloads.get(taskId)!;
    const offset = Number(input.offset || 0);
    const length = Math.min(262144, task.size - offset);
    const payload = new Uint8Array(8 + length);
    new DataView(payload.buffer).setBigUint64(0, BigInt(offset), false);
    for (const listener of binaryListeners) listener({ channel: `sftp/download/${taskId}`, data: payload });
    task.offset = offset + length;
    for (const listener of eventListeners) listener({ method: "sftp/transfer/progress", params: { taskId, sessionId: "visual-session", direction: "download", fileName: task.fileName, transferred: task.offset, size: task.size, status: "running" } });
    result = { length, eof: task.offset >= task.size };
  } else if (method === "sftp/download/finish") {
    const taskId = String((params as Record<string, unknown>)?.taskId || "");
    const task = fixtureDownloads.get(taskId)!;
    for (const listener of eventListeners) listener({ method: "sftp/transfer/progress", params: { taskId, sessionId: "visual-session", direction: "download", fileName: task.fileName, transferred: task.size, size: task.size, status: "completed" } });
    fixtureDownloads.delete(taskId);
    result = { success: true };
  } else if (method === "ssh/exec") {
    const input = params as Record<string, unknown>;
    const command = String(input.command || "");
    const sudo = input.sudo === true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!sudo && !command.includes("sudo")) {
      // ANSI colour codes exercise the control-sequence sanitization in the dialog.
      result = { success: true, output: `\u001b[32muid=1000(demo) gid=1000(demo)\u001b[0m\n$ ${command}`, exitCode: 0 };
    } else {
      setTimeout(() => emitTerminal("user@server:~$ sudo -S systemctl status nginx\r\n[sudo] password for user: \r\n● nginx.service - A high performance web server\r\n   Active: active (running)\r\n"), 30);
      result = { success: true, output: "● nginx.service - A high performance web server\n   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\n   Active: active (running) since Mon 2026-08-24 09:12:31 UTC; 3 days ago", exitCode: 0 };
    }
  }
  else if (method === "ssh/metrics") {
    const totalBytes = 16_573_006_848;
    const availableBytes = 11_012_874_240;
    // 网络速率随刷新次数变化（正弦扰动），让 sparkline 曲线肉眼可见地滚动；
    // processes/osId 镜像 §1.5 与既有扩展字段，供 B2 视觉验证。
    metricsRefreshTick += 1;
    const wave = (base: number, amplitude: number) => Math.max(0, Math.round(base + amplitude * Math.sin(metricsRefreshTick / 2)));
    result = {
      hostname: "web-01.demo.internal",
      kernel: "6.1.0-18-amd64",
      uptimeSeconds: 1_234_567,
      osId: "ubuntu",
      osPretty: "Ubuntu 22.04.5 LTS",
      cpu: { cores: 8, percent: 23.4, load1: 0.42, load5: 0.51, load15: 0.48 },
      memory: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, swapTotalBytes: 2_147_483_648, swapUsedBytes: 0 },
      disks: [
        { filesystem: "/dev/sda1", mount: "/", totalBytes: 52_723_200_512, usedBytes: 24_023_981_056, availableBytes: 26_005_927_936, percentUsed: 48 },
        // /data 固定给 87%（>=85 警戒阈值），让 disk-warn 红色进度条始终可被视觉验证。
        { filesystem: "/dev/sdb1", mount: "/data", totalBytes: 105_550_471_168, usedBytes: 91_828_909_916, availableBytes: 13_721_561_252, percentUsed: 87 },
        { filesystem: "tmpfs", mount: "/dev/shm", totalBytes: 8_146_615_296, usedBytes: 0, availableBytes: 8_146_615_296, percentUsed: 0 },
        // 超长挂载点夹具：锁定 disk-row 第一列的省略号截断（回归：长路径曾
        // 外溢压住进度条与数值列，metrics 面板错位严重）。
        { filesystem: "/dev/mapper/vg--main-very--long--logical--volume", mount: "/mnt/data/services/postgres/bind-mounts/very/long/path", totalBytes: 211_100_942_336, usedBytes: 12_000_000_000, availableBytes: 199_100_942_336, percentUsed: 6 },
      ],
      network: [
        { name: "eth0", rxRate: wave(48_000, 40_000), txRate: wave(12_000, 9_000), rxTotal: 123_456_789_012, txTotal: 9_876_543_210 },
        { name: "lo", rxRate: wave(1_200, 800), txRate: wave(1_200, 800), rxTotal: 5_555_555, txTotal: 5_555_555 },
        // 超长网卡名夹具：同上，锁定 disk-row 截断。
        { name: "br-0f17c3a9d2e4-docker-custom-network", rxRate: wave(2_400, 1_800), txRate: wave(1_800, 1_200), rxTotal: 12_345_678, txTotal: 8_765_432 },
      ],
      processes: [
        { pid: 1, user: "root", cpuPercent: 0.1, memPercent: 0.4, command: "systemd" },
        { pid: 812, user: "www-data", cpuPercent: 12.6, memPercent: 3.1, command: "nginx: worker process" },
        { pid: 1042, user: "demo", cpuPercent: 2.4, memPercent: 1.2, command: "htop" },
      ],
    };
  }
  else if (method === "sftp/diskUsage") {
    result = { filesystem: "/dev/sda1", mount: "/", totalBytes: 52_723_200_512, usedBytes: 24_023_981_056, availableBytes: 26_005_927_936, percentUsed: 48 };
  }
  else if (method === "sftp/chmod" || method === "sudo/chmod") {
    const input = params as Record<string, unknown>;
    const node = findMockNode(String(input.path || ""));
    if (node) node.permissions = String(input.mode || node.permissions);
    result = { success: true };
  }
  else if (method === "ssh/settings/get") {
    const base = { quickSudo: true, sudoUsePty: false, sudoPasswordSet: true, totpConfigured: false, authFlowMode: "password_then_otp", passwordPromptHint: "", totpPromptHint: "", agentTerminalMode: settingsState.agentTerminalMode, rememberedCommands: [...settingsState.rememberedCommands] };
    // revealSecrets: true 时镜像真实桥的回显形状（mock 不存原值，回空串）。
    result = (params as Record<string, unknown>).revealSecrets === true
      ? { ...base, sudoPassword: "", totpSecret: "" }
      : base;
  }
  else if (method === "ssh/settings/set") {
    const input = params as Record<string, unknown>;
    settingsState.quickSudo = typeof input.quickSudo === "boolean" ? input.quickSudo : settingsState.quickSudo;
    settingsState.authFlowMode = typeof input.authFlowMode === "string" ? input.authFlowMode : settingsState.authFlowMode;
    settingsState.passwordPromptHint = typeof input.passwordPromptHint === "string" ? input.passwordPromptHint : settingsState.passwordPromptHint;
    settingsState.totpPromptHint = typeof input.totpPromptHint === "string" ? input.totpPromptHint : settingsState.totpPromptHint;
    settingsState.sudoPasswordSet = typeof input.sudoPassword === "string" ? input.sudoPassword.length > 0 : settingsState.sudoPasswordSet;
    settingsState.totpConfigured = typeof input.totpSecret === "string" ? input.totpSecret.trim().length > 0 : settingsState.totpConfigured;
    if (typeof input.agentTerminalMode === "string") settingsState.agentTerminalMode = input.agentTerminalMode;
    if (Array.isArray(input.rememberedCommands)) {
      settingsState.rememberedCommands = (input.rememberedCommands as unknown[])
        .map((line) => String(line).trim()).filter((line) => line.length > 0).slice(0, 50);
    }
    result = { ...settingsState };
  }
  else if (method === "ssh/quickCommands/list") result = { commands: quickCommandsState };
  else if (method === "ssh/quickCommands/save") {
    const input = params as Record<string, unknown>;
    const command = String(input.command || "").trim();
    if (!command) throw new Error("Missing command");
    if (command.length > 500) throw new Error("Quick command is limited to 500 characters");
    const name = (String(input.name || "").trim() || command.slice(0, 60)).slice(0, 60);
    const id = String(input.id || "").trim();
    const now = Math.floor(Date.now() / 1000);
    const existing = quickCommandsState.findIndex((entry) => entry.id === id);
    if (existing >= 0) {
      quickCommandsState[existing] = { ...quickCommandsState[existing], name, command, updatedAt: now };
      result = { quickCommand: quickCommandsState[existing], created: false, commands: [...quickCommandsState] };
    } else {
      if (quickCommandsState.length >= QUICK_COMMANDS_LIMIT) throw new Error(`At most ${QUICK_COMMANDS_LIMIT} quick commands are supported`);
      const entry = { id: `mock-qc-${quickCommandsState.length + 1}-${now}`, name, command, createdAt: now, updatedAt: now };
      quickCommandsState.push(entry);
      result = { quickCommand: entry, created: true, commands: [...quickCommandsState] };
    }
  }
  else if (method === "ssh/quickCommands/delete") {
    const id = String((params as Record<string, unknown>)?.id || "");
    const index = quickCommandsState.findIndex((entry) => entry.id === id);
    if (index >= 0) quickCommandsState.splice(index, 1);
    result = { removed: index >= 0, commands: [...quickCommandsState] };
  }
  else if (method === "ssh/highlightRules/list") result = { rules: highlightRuleViews() };
  else if (method === "ssh/highlightRules/save") {
    const input = params as Record<string, unknown>;
    const pattern = String(input.pattern || "").trim();
    if (!pattern) throw new Error("Missing pattern");
    if (pattern.length > HIGHLIGHT_PATTERN_MAX) throw new Error(`Pattern is limited to ${HIGHLIGHT_PATTERN_MAX} characters`);
    const color = typeof input.color === "string" && HIGHLIGHT_COLOR_RE.test(input.color) ? input.color : "#f59e0b";
    const id = String(input.id || "").trim();
    const now = Math.floor(Date.now() / 1000);
    const existing = highlightRulesState.findIndex((entry) => entry.id === id);
    if (existing >= 0) {
      highlightRulesState[existing] = {
        ...highlightRulesState[existing],
        pattern,
        isRegex: input.isRegex === true,
        color,
        caseSensitive: input.caseSensitive === true,
        enabled: input.enabled !== false,
        updatedAt: now,
      };
      result = { rule: highlightRulesState[existing], created: false, rules: highlightRuleViews() };
    } else {
      if (highlightRulesState.length >= HIGHLIGHT_RULES_LIMIT) throw new Error(`At most ${HIGHLIGHT_RULES_LIMIT} highlight rules are supported`);
      const entry: MockHighlightRule = {
        id: `mock-hr-${++highlightRuleSeq}-${now}`,
        pattern,
        isRegex: input.isRegex === true,
        color,
        caseSensitive: input.caseSensitive === true,
        enabled: input.enabled !== false,
        createdAt: now,
        updatedAt: now,
      };
      highlightRulesState.push(entry);
      result = { rule: entry, created: true, rules: highlightRuleViews() };
    }
  }
  else if (method === "ssh/highlightRules/delete") {
    const id = String((params as Record<string, unknown>)?.id || "");
    const index = highlightRulesState.findIndex((entry) => entry.id === id);
    if (index >= 0) highlightRulesState.splice(index, 1);
    // 未知 id 不报错（幂等），镜像真实 sidecar 的 removed:false 语义。
    result = { removed: index >= 0, rules: highlightRuleViews() };
  }
  else if (method === "ssh/audit/list") {
    // 镜像并行批次契约：limit ∈ [1,500] 缺省 100；行序保持文件序（旧→新）取
    // 最新 limit 条；`kind` 参数后端不识别（过滤由前端客户端做）。
    const input = (params || {}) as Record<string, unknown>;
    const limitRaw = Number(input.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const truncated = auditEntriesState.length > limit;
    result = { entries: auditEntriesState.slice(-limit), truncated };
  }
  else if (method === "ssh/audit/clear") {
    auditEntriesState = [];
    result = { cleared: true };
  }
  else if (method === "ssh/alert/triage") {
    // 镜像真实 sidecar 契约形状（normalized/category/suggestions + purposeKey），
    // 简化分类：关键词命中哪个组回哪组，兜底 generic；命令清单为只读诊断面。
    const payload = String((params as Record<string, unknown>)?.payload || "").trim();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { /* 纯文本回退 */ }
    const text = [parsed.title, parsed.message, payload].filter(Boolean).join(" ").toLowerCase();
    const category =
      text.includes("oom") || text.includes("out of memory") ? "oom" :
      text.includes("inode") ? "inode" :
      text.includes("cpu") || text.includes("负载") ? "cpu" :
      text.includes("memory") || text.includes("内存") ? "memory" :
      text.includes("disk") || text.includes("磁盘") || text.includes("空间") ? "disk" :
      text.includes("network") || text.includes("丢包") ? "network" :
      text.includes("service") || text.includes("systemd") ? "service" : "generic";
    const severityRaw = String(parsed.severity || "unknown").toLowerCase();
    // severity/source 均小写化，镜像后端 normalize（alert_triage::normalize）。
    result = {
      normalized: {
        alertId: String(parsed.alertId || ""),
        title: String(parsed.title || ""),
        message: String(parsed.message || payload),
        severity: severityRaw,
        source: String(parsed.source || "").toLowerCase(),
        dataJson: parsed.data && typeof parsed.data === "object" ? JSON.stringify(parsed.data, null, 2) : "",
      },
      category,
      suggestions: category === "disk"
        ? [{ command: "df -h", purposeKey: "diskUsage" }, { command: "du -x -d 1 / | sort -rh | head -15", purposeKey: "diskDu" }]
        : [{ command: "uptime", purposeKey: "loadSnapshot" }, { command: "free -m", purposeKey: "memFree" }, { command: "df -h", purposeKey: "diskUsage" }],
    };
  }
  else if (method === "ssh/terminal/batchInput") {
    const input = params as Record<string, unknown>;
    const sessionIds = Array.isArray(input.sessionIds) ? (input.sessionIds as string[]) : [];
    const command = String(input.command || "");
    const results = sessionIds.map((sessionId) =>
      sessionId === "visual-session"
        ? { sessionId, success: true }
        : { sessionId, success: false, error: "SSH session was not found" });
    if (results.some((row) => row.success)) {
      setTimeout(() => emitTerminal(`$ ${command}\r\nuser@server:~$ `), 30);
    }
    result = { results, sent: results.filter((row) => row.success).length, failed: results.filter((row) => !row.success).length };
  }
  else if (method === "ssh/exec/cancel") result = { success: true };
  else if (method === "sudo/profiles/list") result = { profiles: [] };
  else if (method === "sudo/profiles/reveal") result = { profile: {} };
  else if (method === "sudo/profiles/save" || method === "sudo/profiles/delete") result = { success: true };
  else if (method === "ssh/knownHosts/list") result = { entries: [] };
  else if (method === "keys/discover") result = { keys: [] };
  else if (method === "mcp/settings/get") result = { maxReadBytes: 8 * 1024 * 1024, maxUploadBytes: 64 * 1024 * 1024, maxDownloadBytes: 256 * 1024 * 1024, execPermissionMode: mcpSettingsState.execPermissionMode, connectionScope: [...mcpSettingsState.connectionScope] };
  else if (method === "mcp/settings/set") {
    const input = (params || {}) as Record<string, unknown>;
    if (typeof input.execPermissionMode === "string") {
      if (input.execPermissionMode !== "autonomous" && input.execPermissionMode !== "confirm") throw new Error("Invalid execPermissionMode: expected autonomous or confirm");
      mcpSettingsState.execPermissionMode = input.execPermissionMode;
    }
    if (Array.isArray(input.connectionScope)) {
      mcpSettingsState.connectionScope = input.connectionScope
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 20);
    }
    result = { maxReadBytes: 8 * 1024 * 1024, maxUploadBytes: 64 * 1024 * 1024, maxDownloadBytes: 256 * 1024 * 1024, execPermissionMode: mcpSettingsState.execPermissionMode, connectionScope: [...mcpSettingsState.connectionScope] };
  }
  else result = { success: true };
  return result as T;
};

window.dbxPlugin = {
  ready: Promise.resolve(context),
  context,
  appearance,
  theme,
  get locale() {
    return currentLocale;
  },
  request,
  invoke,
  notify: async () => undefined,
  sendBinary: async (channel, data) => {
    if (channel.startsWith("sftp/upload/")) {
      const bytes = typeof data === "string" ? Uint8Array.from(atob(data), (value) => value.charCodeAt(0)) : data instanceof Uint8Array ? data : new Uint8Array(data);
      const offset = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false));
      const taskId = channel.slice("sftp/upload/".length);
      for (const listener of eventListeners) listener({ method: "sftp/upload/ack", params: { taskId, nextOffset: offset + Math.max(0, bytes.byteLength - 8) } });
      return;
    }
    if (!channel.startsWith("ssh/terminal/in/")) return;
    const bytes = typeof data === "string" ? Uint8Array.from(atob(data), (value) => value.charCodeAt(0)) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const inputSequence = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false));
    for (const listener of eventListeners) listener({ method: "ssh/terminal/inputAck", params: { sequence: inputSequence } });
  },
  onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
  onBinary: (listener) => { binaryListeners.add(listener); return () => binaryListeners.delete(listener); },
  onAppearanceChange: (listener) => { appearanceListeners.add(listener); listener(appearance); return () => appearanceListeners.delete(listener); },
  // 镜像 env.d.ts 声明的宿主 1.1 形状（(listener) => unsubscribe）；立即回调
  // 当前 locale 与 mock 的 onAppearanceChange/onContextChange 同构。
  onLocaleChange: (listener) => { localeListeners.add(listener); listener(currentLocale); return () => localeListeners.delete(listener); },
  onContextChange: (listener) => { contextListeners.add(listener); listener(context); return () => contextListeners.delete(listener); },
  decodeBase64: (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  encodeBase64: base64,
  workbenchState: { set: async () => undefined },
  clipboard: { readText: async () => "", writeText: async () => undefined },
  fileTransfer: {
    pick: async () => ({ files: [] }),
    read: async () => ({ dataBase64: "", length: 0, eof: true }),
    beginSave: async () => ({ handleId: "visual-save-handle-0001", chunkBytes: 262144 }),
    write: async (_handleId, offset, data) => {
      // 字符串载荷为 base64；确认的是解码后的字节数，与二进制载荷同义。
      const written = typeof data === "string" ? atob(data).length : data.byteLength;
      return { written, nextOffset: offset + written };
    },
    finish: async () => undefined,
    cancel: async () => undefined,
    onDragState: () => () => undefined,
    onDrop: () => () => undefined,
  },
};

// mock 专有调试入口（真实桥无此字段）：切换 locale 并推送 onLocaleChange
// 监听，供 mock.html 控制台 / 单测走查 i18n 切换链（瞬态 notice 不随切语
// 重译的 R5-P2-2 维持豁免，不在本夹具模拟范围）。
(window as unknown as { __dbxMockSetLocale?: (next: string) => void }).__dbxMockSetLocale = (next: string) => {
  currentLocale = next || "en";
  for (const listener of localeListeners) listener(currentLocale);
};

// 供单元测试（mockDbxHost.spec.ts）以模块形式动态导入并重置状态。
export {};
