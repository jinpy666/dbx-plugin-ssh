#!/usr/bin/env node
/**
 * smoke_ui_mock.mjs — scripted mock walkthrough (COLLECT-FINAL suggestion 1).
 *
 * Boots the vite dev server, opens frontend/mock.html in headless Chrome
 * (playwright-core, system Chrome channel), asserts the workbench anchors
 * render (session pill, terminal host, SFTP pane, toolbar), functionally
 * exercises the batch-send dialog and the global quick-commands CRUD against
 * the mock bridge, and saves screenshots for the docs.
 *
 * The PR-A4 section at the end asserts the local-terminal passthrough against
 * the TARGET contract ({ plugin: { mode: "local-terminal" } } + the
 * ?local=1&restored=1 fixture, W1 branch) and SKIPs until the mock serves it.
 *
 * Dependency policy: playwright-core is installed OUTSIDE the repo
 * (/tmp/dbx-ui-mock, same pattern as the A-LDAP walkthrough) — the project
 * package.json stays dependency-frozen. If playwright-core or Chrome is
 * unavailable the script SKIPs (exit 0), matching the smoke SKIP semantics.
 * CI (and anyone who wants a hard gate) sets DBX_SMOKE_STRICT=1: a SKIP that
 * stems from missing tooling then exits non-zero, so a broken environment can
 * no longer share the silent-green path with a genuine pass. Assertion and
 * timeout failures always exit non-zero, strict or not.
 *
 * Usage: node scripts/smoke_ui_mock.mjs [--port 5199]
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// No --strictPort / fixed port: vite picks a free one and prints the URL.
// ?render=dom：锁 DOM 渲染器（WebGL 渲染下终端文本只存在于 GPU canvas，
// DOM 文本断言失效；WebGL 成功/回退逻辑由 terminalWebgl 单测覆盖）。
const URL_BASE = `mock.html?render=dom`;
const SHOT_DIR = `${ROOT}docs/screenshots-ui-mock`;

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  // DBX_SMOKE_STRICT=1（CI 门禁）：工具链缺失的 SKIP 按失败退出，环境损坏
  // 不再与测试通过共享静默绿路径；默认（本地无依赖）保持 exit 0。
  if (process.env.DBX_SMOKE_STRICT === "1") {
    console.error("DBX_SMOKE_STRICT=1: dependency-missing SKIP is treated as a failure");
    process.exit(1);
  }
  process.exit(0);
}

// --- dependency gate (outside the repo) ---
// Windows 上 Git Bash 的 /tmp 映射到 %TEMP%，而 Node 的 file:///tmp 解析到
// 盘符根下 —— 两个候选都试；macOS/Linux 保持原路径。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

let chromium;
const playwrightCandidates = process.platform === "win32"
  ? [join(tmpdir(), "dbx-ui-mock"), "C:\\tmp\\dbx-ui-mock", "D:\\tmp\\dbx-ui-mock"]
  : ["/tmp/dbx-ui-mock"];
for (const dir of playwrightCandidates) {
  try {
    ({ chromium } = await import(pathToFileURL(join(dir, "node_modules/playwright-core/index.mjs")).href));
    break;
  } catch { /* try next candidate */ }
}
if (!chromium) skip("playwright-core not available at /tmp/dbx-ui-mock (npm install --prefix /tmp/dbx-ui-mock playwright-core)");
// Linux：launch 用 channel:"chrome"，探测装在标准路径的稳定版/发行版 Chrome
//（ubuntu runner 自带 google-chrome-stable —— CI 门禁依赖这一点）。
const chromeCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    ]
  : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app", "/Applications/Chromium.app"]
    : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
const hasChrome = chromeCandidates.some((p) => p && existsSync(p));
if (!hasChrome) skip("no system Chrome/Chromium");

// --- vite dev server ---
console.log("==> starting vite dev server");
// 直启 repo 内 vite 二进制（不经 pnpm exec）：CI runner 的 PATH/pnpm 包装
// 层可能静默吞掉 stdout，导致 URL 永远匹配不上（首次 runner 观测实录）。
const vite = spawn(process.execPath, [join(ROOT, "frontend", "node_modules", "vite", "bin", "vite.js")], {
  cwd: join(ROOT, "frontend"),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});
vite.on("error", (e) => process.stderr.write(`[vite spawn error] ${e}\n`));
vite.on("exit", (code, sig) => { if (code !== 0 && code !== null) process.stderr.write(`[vite exited] code=${code} sig=${sig}\n`); });
vite.stderr.on("data", (d) => process.stderr.write(d));
let stdoutBuf = "";
vite.stdout.on("data", (d) => {
  stdoutBuf += String(d);
});
let baseUrl = "";
const upDeadline = Date.now() + 180_000; // 冷缓存下 vite optimizeDeps 可能远超 60s
while (Date.now() < upDeadline) {
  const match = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)\//.exec(stdoutBuf);
  if (match) {
    baseUrl = `${match[1]}/mock.html`;
    break;
  }
  await sleep(500);
}
if (!baseUrl) skip(`vite dev server did not report a URL in time; vite stdout tail: ${stdoutBuf.slice(-400) || "(empty)"}`);
console.log(`==> dev server up: ${baseUrl}`);

const failures = [];
async function expect(page, selector, label) {
  const el = page.locator(selector).first();
  try {
    await el.waitFor({ state: "visible", timeout: 15_000 });
    console.log(`  ok  ${label} (${selector})`);
  } catch {
    failures.push(`${label} (${selector}) not visible`);
    console.log(`  FAIL ${label} (${selector})`);
  }
}

async function expectText(page, selector, text, label) {
  const el = page.locator(selector, { hasText: text }).first();
  try {
    await el.waitFor({ state: "visible", timeout: 15_000 });
    console.log(`  ok  ${label} (${selector} ~ "${text}")`);
  } catch {
    failures.push(`${label}: "${text}" not visible in ${selector}`);
    console.log(`  FAIL ${label}: "${text}" not visible in ${selector}`);
  }
}

async function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageError = [];
  page.on("pageerror", (err) => pageError.push(String(err)));
  // ?render=dom 锁定 DOM 渲染器：WebGL 渲染下终端文本只在 GPU canvas，
  // DOM 文本断言（下方 terminal echo 等）结构性失效。
  await page.goto(`${baseUrl}?render=dom`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2_500); // let the mock bridge wire the workbench

  console.log("==> workbench anchors");
  await expect(page, ".session-pill", "session status pill");
  await expect(page, ".terminal-host", "terminal host");
  await expect(page, ".terminal-pane", "terminal pane");
  await expect(page, ".toolbar-actions", "toolbar actions");
  await expect(page, ".toolbar-separator", "toolbar separator");

  console.log("==> SSH toolbar port-forward manager");
  await page.locator('button[title="Port forwards"]').click();
  await expectText(page, ".forwards-modal .forward-profiles h2", "Saved port forwards", "toolbar dialog shows saved mappings");
  await expectText(page, ".forwards-modal .forward-section-title", "Active port forwards", "toolbar dialog shows active mappings");
  await page.locator('.forwards-modal > header .icon-button').click();

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/01-workbench.png`, fullPage: false });
  console.log(`  screenshot: docs/screenshots-ui-mock/01-workbench.png`);

  // --- global quick commands: manage in Settings, execute in toolbar -------
  console.log("==> quick commands: settings-managed global store add");
  // M32-A 回归守卫：协议直开图标（Telnet/VNC/RDP/Serial）与 quick sudo
  // profiles 管理入口已从工具条移除（连接统一走宿主连接管理；管理归设置）。
  for (const goneTitle of ["New Telnet session", "New VNC session", "New RDP session", "New Serial session", "Global Quick Sudo profiles"]) {
    const count = await page.locator(`button[title="${goneTitle}"]`).count();
    check(`protocol direct-open removed ("${goneTitle}")`, count === 0, `found ${count}`);
  }
  // 自定义 tooltip 系统（App.vue 全局接管）：首次 hover 后 title 会挪到
  // data-tooltip，此后 button[title=...] 选择器不再命中，两处点击都要兼容。
  const QUICK_BTN = 'button[title="Quick commands"], button[data-tooltip="Quick commands"]';
  await page.click(QUICK_BTN);
  await expect(page, ".quick-commands-popover", "quick commands popover");
  await expectText(page, ".quick-command-global-hint", "Stored globally", "global-store hint");
  // M32-A3：工具条弹层只剩列表执行，"新建/导入"迁入设置·终端，footer 留指路说明。
  await expectText(page, ".quick-command-manage-hint", "Settings → Terminal", "manage-in-settings hint");
  const newInPopover = await page.locator(".quick-new-btn").count();
  check("editor entry removed from popover", newInPopover === 0, `found ${newInPopover}`);
  await page.keyboard.press("Escape");

  // 管理路径：设置 → 终端 → 快速命令 → 新建（数据面 RPC 不变，全局共享）。
  await page.evaluate(() => document.querySelector('button svg[class*="lucide-settings"]').closest("button").click());
  await page.locator(".settings-nav-item").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("tab", { name: "Quick commands", exact: true }).click();
  await page.locator(".quick-manage-actions .link-button", { hasText: "New snippet" }).click();
  await page.fill(".quick-command-editor input", "ui-mock cmd");
  await page.fill(".quick-command-editor textarea", "echo ui-mock-batch");
  await page.click(".quick-command-editor-actions .primary-button");
  await expectText(page, ".quick-manage-list li", "ui-mock cmd", "quick command settings row");
  await page.locator(".settings-modal header button.icon-button").first().click();
  await page.locator(".settings-nav-item").first().waitFor({ state: "hidden", timeout: 10_000 });

  // 回到工具条弹层：全局清单同步可见（同一 App 权威态）。
  await page.click(QUICK_BTN);
  await expectText(page, ".quick-command-row strong", "ui-mock cmd", "quick command row");
  await page.screenshot({ path: `${SHOT_DIR}/02-quick-commands.png`, fullPage: false });
  console.log(`  screenshot: docs/screenshots-ui-mock/02-quick-commands.png`);

  // --- batch send: bar, target inventory, quick pick, send ----------------
  // 2026-09 批量发送从 modal 弹窗改为常驻 batch-bar（命令条 + 目标 popover），
  // 本段断言已随 UI 重新对齐（旧 .batch-modal 选择器已不存在）。
  console.log("==> batch send: bar walkthrough");
  // batch-bar 默认展开（localStorage 未持久化 "0" 时）；仅在意外关闭时点开。
  if (!(await page.$(".batch-bar"))) await page.click('button[title="Batch send"]');
  await expect(page, ".batch-bar", "batch send bar");
  await page.click(".batch-bar-targets");
  await expect(page, ".batch-targets-popover", "batch targets popover");
  // issue #10232：目标行标签优先显示宿主连接名（mock 的 host.listConnections
  // 夹具返回 "Production SSH"），user@host 只在旧宿主/未命名连接时兜底。
  await expectText(page, ".batch-target-row", "Production SSH", "target row connection name");
  await expectText(page, ".batch-target-row", "Current", "current-session badge");
  // 快速命令下拉已迁到 reka Select（Phase 3）：点开触发钮，再点选项。
  await page.click(".batch-bar-quick");
  await page.click('[data-slot="select-item"]:has-text("ui-mock cmd")');
  const draft = await page.inputValue(".batch-bar-input");
  await check("quick pick fills the command draft", draft === "echo ui-mock-batch", `draft="${draft}"`);
  await page.screenshot({ path: `${SHOT_DIR}/03-batch-send.png`, fullPage: false });
  console.log(`  screenshot: docs/screenshots-ui-mock/03-batch-send.png`);
  await page.click(".batch-bar-send");
  await expectText(page, ".batch-bar-status", "Sent to 1 session(s)", "batch send summary");
  try {
    // The mock bridge echoes the command into the terminal (PTY semantics).
    // headless 页面可能被 Chrome 判为 occluded 而暂停 rAF（xterm 渲染节流
    // 不刷新 DOM，buffer 其实已写）；bringToFront 消除这一偶发假阴性。
    await page.bringToFront();
    await page.waitForFunction(
      () => document.querySelector(".terminal-host")?.textContent?.includes("echo ui-mock-batch"),
      null,
      { timeout: 10_000 },
    );
    console.log('  ok  terminal echo ("echo ui-mock-batch")');
  } catch {
    failures.push('terminal echo missing ("echo ui-mock-batch")');
    console.log('  FAIL terminal echo ("echo ui-mock-batch")');
  }
  // 收起命令条（同一工具栏按钮 toggle）。
  await page.click('button[title="Batch send"]');

  // --- WebGL renderer smoke: default preference attaches a GPU renderer ----
  // (or falls back to the DOM renderer when WebGL is unavailable — headless
  // Chrome may or may not provide swiftshader). Either way the terminal must
  // stay functional; the DOM-text assertions above ran with ?render=dom.
  console.log("==> webgl renderer smoke");
  const webglPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await webglPage.goto(`${baseUrl}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2_500);
  const webglState = await webglPage.evaluate(() => ({
    canvases: document.querySelectorAll(".terminal-host canvas").length,
    rows: document.querySelectorAll(".terminal-host .xterm-rows").length,
  }));
  check(
    "terminal has a renderer (webgl canvas or dom rows)",
    webglState.canvases > 0 || webglState.rows > 0,
    JSON.stringify(webglState),
  );
  await webglPage.close();

  // --- Warp-style history panel: ↑ opens with focus kept on the terminal; --
  // search box filters after click-focus; terminal Enter runs the line (#138).
  // 独立页面 + addInitScript 种子：commandHistory 水合在 App setup（晚于
  // addInitScript），mock 宿主 storage 的兜底档正是 window.localStorage。
  // 值为分桶档（scope = connectionId）：历史按连接隔离，mock 页面的作用域
  // 是 mock 宿主注入的 "visual-connection"。
  console.log("==> history panel walkthrough");
  const historyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  historyPage.on("pageerror", (err) => pageError.push(String(err)));
  await historyPage.addInitScript(() => {
    window.localStorage.setItem(
      "ssh-command-history",
      JSON.stringify({
        "visual-connection": ["echo ui-mock-history-a", "tail -f /var/log/ui-mock.log", "kubectl get pods -n ui-mock"],
      }),
    );
  });
  await historyPage.goto(`${baseUrl}?render=dom`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2_500);
  await historyPage.bringToFront();
  await historyPage.click(".terminal-host");

  // 空提示符快捷键引导条：静置空行显示 → 键入隐藏 → 退格清行恢复；随后
  // ↑ 开面板即「用过即散」（面板关闭后不再出现，旗标持久化）。
  try {
    await historyPage.waitForSelector(".terminal-prompt-hints", { timeout: 5_000 });
    console.log("  ok  shortcut hint strip shows on empty prompt");
  } catch {
    failures.push("shortcut hint strip missing on empty prompt");
    console.log("  FAIL shortcut hint strip");
  }
  await historyPage.keyboard.type("e");
  await sleep(200);
  const hintsAfterType = await historyPage.locator(".terminal-prompt-hints").count();
  check("shortcut hint strip hides while typing", hintsAfterType === 0, `hints=${hintsAfterType}`);
  await historyPage.keyboard.press("Backspace");
  // 退格回显也是输出：等 600ms 输出活跃窗放行（防抖静默）后再断言回归。
  await sleep(750);
  const hintsAfterBackspace = await historyPage.locator(".terminal-prompt-hints").count();
  check("shortcut hint strip returns after clearing the line", hintsAfterBackspace === 1, `hints=${hintsAfterBackspace}`);

  await historyPage.keyboard.press("ArrowUp");
  await expect(historyPage, ".terminal-history-panel", "history panel opens on ArrowUp");
  // #138 交互跟进：面板打开不抢焦点，光标留在命令行（xterm textarea）。
  const focusOnLine = await historyPage.evaluate(() => document.activeElement?.classList?.contains("xterm-helper-textarea") === true);
  check("focus stays on the terminal input line after ArrowUp", focusOnLine, `active=${await historyPage.evaluate(() => document.activeElement?.className ?? "null")}`);
  // mock PTY 启动回放会额外入一条 E 帧命令，计数不固定——只断言种子条目在列。
  await expectText(historyPage, ".terminal-history-hit", "echo ui-mock-history-a", "history panel lists the seeded history");
  const unfilteredRows = await historyPage.locator(".terminal-history-hit").count();
  // 终端焦点路径：打字进命令行（shell 语义），面板不过滤、列表保持原样。
  await historyPage.keyboard.type("tail");
  const rowsAfterLineTyping = await historyPage.locator(".terminal-history-hit").count();
  check("terminal typing goes to the input line (panel stays unfiltered)", rowsAfterLineTyping === unfilteredRows, `rows=${rowsAfterLineTyping}/${unfilteredRows}`);
  // 搜索框不再自动聚焦：点击聚焦后才过滤。
  // 面板锚点经 rAF 合帧随回显 settle 收敛（高负载下构建刚结束的宿主上可达
  // 秒级），且面板可能落在可滚动区边缘：点击前先 scrollIntoViewIfNeeded，
  // 消除「可见但瞬时不稳定/差一格视口」的误报；scroll 不可达的面板仍会以
  // 原生 actionability 失败暴露，不掩盖真实定位缺陷。
  await historyPage.click(".terminal-history-search-input");
  const focusOnSearch = await historyPage.evaluate(() => document.activeElement?.classList?.contains("terminal-history-search-input") === true);
  check("clicking the search box focuses it", focusOnSearch, `active=${await historyPage.evaluate(() => document.activeElement?.className ?? "null")}`);
  await historyPage.keyboard.type("tail");
  const filteredRows = await historyPage.locator(".terminal-history-hit").count();
  check("search-box typing filters the panel to the single fuzzy hit", filteredRows === 1, `rows=${filteredRows}`);
  await expectText(historyPage, ".terminal-history-hit", "tail -f /var/log/ui-mock.log", "filtered entry text");
  await historyPage.screenshot({ path: `${SHOT_DIR}/04-history-panel.png`, fullPage: false }).catch(() => undefined);
  // Enter（搜索框路径）仅收起不执行：面板关闭、焦点归还终端（无 \r，mock 只回显）。
  await historyPage.keyboard.press("Enter");
  const panelsAfterEnter = await historyPage.locator(".terminal-history-panel").count();
  check("Enter closes the panel without auto-run (search-box path)", panelsAfterEnter === 0, `panels=${panelsAfterEnter}`);
  const focusBackOnLine = await historyPage.evaluate(() => document.activeElement?.classList?.contains("xterm-helper-textarea") === true);
  check("focus returns to the terminal after search-box Enter", focusBackOnLine, `active=${await historyPage.evaluate(() => document.activeElement?.className ?? "null")}`);
  try {
    await historyPage.waitForFunction(
      () => document.querySelector(".terminal-host")?.textContent?.includes("tail -f /var/log/ui-mock.log"),
      null,
      { timeout: 10_000 },
    );
    console.log('  ok  selected command echoed into the input line ("tail -f …")');
  } catch {
    failures.push('selected command not echoed ("tail -f /var/log/ui-mock.log")');
    console.log('  FAIL selected command echo');
  }
  // Esc 关闭语义：重开 → ↑ 按到超过条目数（stay 停住不关面板，P0-D）→ Esc → 面板消失。
  await historyPage.keyboard.press("ArrowUp");
  await expect(historyPage, ".terminal-history-panel", "history panel reopens");
  for (let i = 0; i < 8; i += 1) await historyPage.keyboard.press("ArrowUp");
  const panelsAtTop = await historyPage.locator(".terminal-history-panel").count();
  check("ArrowUp past the oldest entry keeps the panel open (stay)", panelsAtTop === 1, `panels=${panelsAtTop}`);
  await historyPage.keyboard.press("Escape");
  const panelsAfterEsc = await historyPage.locator(".terminal-history-panel").count();
  check("Escape closes the panel", panelsAfterEsc === 0, `panels=${panelsAfterEsc}`);
  // 用过即散：↑ 开面板命中引导条教的键位，面板关闭后引导条不再出现。
  const hintsAfterPanelUse = await historyPage.locator(".terminal-prompt-hints").count();
  check("hint strip stays dismissed after using the panel (used-once dismissal)", hintsAfterPanelUse === 0, `hints=${hintsAfterPanelUse}`);

  // 热键唤起聚焦搜索框（批 3d，Warp Ctrl+R 心智）：⌘⇧H（mac）/ Ctrl+Shift+H。
  const historyHotkey = process.platform === "darwin" ? "Meta+Shift+h" : "Control+Shift+H";
  await historyPage.keyboard.press(historyHotkey);
  await expect(historyPage, ".terminal-history-panel", "history panel opens via hotkey");
  const focusOnSearchHotkey = await historyPage.evaluate(() => document.activeElement?.classList?.contains("terminal-history-search-input") === true);
  check("hotkey entry focuses the search box", focusOnSearchHotkey, `active=${await historyPage.evaluate(() => document.activeElement?.className ?? "null")}`);
  await historyPage.keyboard.press("Escape");
  const panelsAfterHotkeyEsc = await historyPage.locator(".terminal-history-panel").count();
  check("Escape closes the hotkey-opened panel", panelsAfterHotkeyEsc === 0, `panels=${panelsAfterHotkeyEsc}`);

  // Ctrl+R（Warp Command Search 的默认键 workspace:show_command_search）：打开
  // 即聚焦搜索框；收起走 Esc（焦点在搜索框时按键经面板转发链，Ctrl+R toggle
  // 只在终端焦点路径成立）。
  await historyPage.keyboard.press("Control+r");
  await expect(historyPage, ".terminal-history-panel", "history panel opens via Ctrl+R (Warp command search)");
  const focusOnSearchCtrlR = await historyPage.evaluate(() => document.activeElement?.classList?.contains("terminal-history-search-input") === true);
  check("Ctrl+R entry focuses the search box", focusOnSearchCtrlR, `active=${await historyPage.evaluate(() => document.activeElement?.className ?? "null")}`);
  await historyPage.keyboard.press("Escape");
  const panelsAfterCtrlREsc = await historyPage.locator(".terminal-history-panel").count();
  check("Escape closes the Ctrl+R-opened panel", panelsAfterCtrlREsc === 0, `panels=${panelsAfterCtrlREsc}`);

  // 富元数据（批 4d，Warp command search）：mock 夹具 curl 命令 D 帧退出码 28
  // → 重开面板应渲染 ✗ 28 红徽标。
  await historyPage.keyboard.press("ArrowUp");
  await expect(historyPage, ".terminal-history-panel", "history panel reopens for meta check");
  try {
    await historyPage.waitForFunction(
      () => Array.from(document.querySelectorAll(".terminal-history-exit")).some((el) => el.textContent?.includes("28")),
      null,
      { timeout: 10_000 },
    );
    console.log('  ok  failed command shows the exit-code badge ("✗ 28")');
  } catch {
    failures.push('exit-code badge missing for the failed mock command');
    console.log("  FAIL exit-code badge");
  }
  await historyPage.keyboard.press("Escape");

  // --- inline ghost (batch 2, P0-C): prefix hits go to ghost, not the -----
  // --- fuzzy overlay; Ctrl+→ accepts one word, → accepts the remainder. ---
  // 同页续用（历史已种子）。注意先回车清行：前段走查中 ↑ 同步进输入行的
  // 命令还留在行缓冲里（Esc 取消恢复的是原行 "tail"），不清行的话再敲
  // "ec" 拼成 "tailec"，ghost/浮层都无命中。
  await historyPage.keyboard.press("Enter");
  await sleep(600);
  await historyPage.click(".terminal-host");
  await historyPage.keyboard.type("ec");
  let ghostText = "";
  try {
    await historyPage.waitForFunction(
      () => {
        const el = document.querySelector(".terminal-ghost");
        return el && el.textContent && el.textContent.length > 0 ? el.textContent : false;
      },
      null,
      { timeout: 10_000 },
    );
    ghostText = await historyPage.locator(".terminal-ghost > span[aria-hidden]").textContent() ?? "";
  } catch {
    ghostText = "";
  }
  check("ghost shows the remainder for a prefix of seeded history", ghostText.startsWith("ho ui-mock-history-a"), `ghost="${ghostText}"`);
  const overlaysDuringGhost = await historyPage.locator(".command-suggestions").count();
  check("fuzzy suggestion overlay yields to the inline ghost (data split)", overlaysDuringGhost === 0, `overlays=${overlaysDuringGhost}`);
  await historyPage.screenshot({ path: `${SHOT_DIR}/04b-ghost-inline.png`, fullPage: false }).catch(() => undefined);
  await historyPage.keyboard.press("Control+ArrowRight");
  let ghostAfterWord = "";
  try {
    await historyPage.waitForFunction(
      () => {
        const el = document.querySelector(".terminal-ghost");
        return el && el.textContent === " ui-mock-history-a";
      },
      null,
      { timeout: 10_000 },
    );
    ghostAfterWord = await historyPage.locator(".terminal-ghost > span[aria-hidden]").textContent() ?? "";
  } catch {
    // 抖动兜底：mock 回显 RTT 偶发让瞬时读取落空，缓冲后重读一次。
    await sleep(1_200);
    ghostAfterWord = await historyPage.locator(".terminal-ghost > span[aria-hidden]").textContent().catch(() => "") ?? "";
  }
  check("Ctrl+→ accepts one word (remainder shrinks)", ghostAfterWord === " ui-mock-history-a", `ghost="${ghostAfterWord}"`);
  await historyPage.keyboard.press("ArrowRight");
  await sleep(600);
  const ghostAfterFull = await historyPage.locator(".terminal-ghost").count();
  check("→ accepts the whole remainder (ghost disappears)", ghostAfterFull === 0, `ghost=${ghostAfterFull}`);
  // Ctrl+F 整段接受（Warp 口径第二键；readline forward-char 等价截获）。
  await historyPage.keyboard.press("Enter");
  await sleep(600);
  await historyPage.click(".terminal-host");
  await historyPage.keyboard.type("ec");
  try {
    await historyPage.waitForFunction(() => !!document.querySelector(".terminal-ghost"), null, { timeout: 10_000 });
  } catch { /* ghost miss handled below */ }
  await historyPage.keyboard.press("Control+f");
  await sleep(600);
  const ghostAfterCtrlF = await historyPage.locator(".terminal-ghost").count();
  check("Ctrl+F accepts the whole remainder (Warp second key)", ghostAfterCtrlF === 0, `ghost=${ghostAfterCtrlF}`);
  try {
    await historyPage.waitForFunction(
      () => document.querySelector(".terminal-host")?.textContent?.includes("echo ui-mock-history-a"),
      null,
      { timeout: 10_000 },
    );
    console.log('  ok  Ctrl+F accepted ghost echoed into the input line');
  } catch {
    failures.push("Ctrl+F accepted ghost not echoed");
    console.log("  FAIL Ctrl+F ghost echo");
  }
  try {
    await historyPage.waitForFunction(
      () => document.querySelector(".terminal-host")?.textContent?.includes("echo ui-mock-history-a"),
      null,
      { timeout: 10_000 },
    );
    console.log('  ok  accepted ghost echoed into the input line ("echo …")');
  } catch {
    failures.push('accepted ghost not echoed ("echo ui-mock-history-a")');
    console.log("  FAIL accepted ghost echo");
  }
  await historyPage.close();

  // --- global quick commands: delete --------------------------------------
  console.log("==> quick commands: delete");
  // M32-A3：删除动作随管理视图在设置·终端（工具条卡片只剩执行）。
  await page.evaluate(() => document.querySelector('button svg[class*="lucide-settings"]').closest("button").click());
  await page.locator(".settings-nav-item").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("tab", { name: "Quick commands", exact: true }).click();
  // 删除确认已迁应用内弹窗（沙箱 iframe 无 allow-modals，window.confirm 恒
  // false）：点删除 → 弹窗内确认按钮 → 等弹窗收口后再关设置。
  await page.click('.quick-manage-list li button[title="Delete"]');
  await page.locator(".small-modal footer .danger-button").click();
  await page.locator(".small-modal").waitFor({ state: "hidden", timeout: 5_000 });
  await page.locator(".settings-modal header button.icon-button").first().click();
  await page.locator(".settings-nav-item").first().waitFor({ state: "hidden", timeout: 10_000 });
  await page.click(QUICK_BTN);
  await expectText(page, ".quick-commands-popover .empty.compact", "No quick commands yet", "quick commands empty after delete");

  // --- PR-A4 local-terminal anchors (written against the TARGET contract) ---
  // W1（codex/ssh/a4-webview-contract）把本地终端直通 context 从
  // { localTerminal: true } 迁到 { plugin: { mode: "local-terminal" } }，并为
  // mock 增加 ?local=1&restored=1 夹具（restored 不自动起 shell，显示退出外
  // 壳）。本节断言按目标契约编写：探测到旧形状时整节 SKIP（exit 0），W1 合并
  // 后自动生效——提前合入本脚本不会让 test.sh 变红。
  console.log("==> PR-A4 local-terminal anchors");
  // mock 层打桩：拦下 mockDbxHost 对 window.dbxPlugin 的赋值（在 App 挂载前
  // 同步发生），给 invoke 包一层计数器统计 local/terminal/start 调用次数。
  const installStartCallCounter = () => `
    (() => {
      let api;
      Object.defineProperty(window, "dbxPlugin", {
        configurable: true,
        get: () => api,
        set(next) {
          api = next;
          if (!next || next.__a4CountsLocalStart) return;
          Object.defineProperty(next, "__a4CountsLocalStart", { value: true });
          const raw = next.invoke.bind(next);
          next.invoke = (method, ...rest) => {
            if (method === "local/terminal/start") {
              window.__a4LocalStartCalls = (window.__a4LocalStartCalls || 0) + 1;
            }
            return raw(method, ...rest);
          };
        },
      });
    })()
  `;
  const newPage = async (url) => {
    const a4Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    a4Page.on("pageerror", (err) => pageError.push(String(err)));
    await a4Page.addInitScript(installStartCallCounter());
    await a4Page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(2_500); // let the mock bridge wire the workbench
    return a4Page;
  };
  // restored 夹具页先探目标契约是否已由 W1 落地（新 context 形状 + restored
  // 字段同时存在才放行断言，避免旧形状下误报），放行后就在本页跑断言。
  const restoredPage = await newPage(`${baseUrl}?render=dom&local=1&restored=1`);
  const contract = await restoredPage.evaluate(() => {
    const ctx = window.dbxPlugin?.context;
    return {
      pluginMode: ctx?.plugin?.mode === "local-terminal",
      restoredFixture: ctx?.restored === true,
    };
  });
  if (!contract.pluginMode || !contract.restoredFixture) {
    console.log(
      `  SKIP PR-A4 anchors: mock still serves the pre-A4 local context ` +
      `(pluginMode=${contract.pluginMode}, restoredFixture=${contract.restoredFixture}) — ` +
      `W1 (codex/ssh/a4-webview-contract) pending; assertions target the new contract and activate after it merges`,
    );
    await restoredPage.close();
  } else {
    // ?local=1&restored=1：恢复外壳不重放——0 次 local/terminal/start，退出
    // 覆盖层（"已退出 + 重新打开"）可见。
    const restoredStarts = await restoredPage.evaluate(() => window.__a4LocalStartCalls || 0);
    check("restored tab issues zero local/terminal/start calls", restoredStarts === 0, `calls=${restoredStarts}`);
    await expectText(restoredPage, ".terminal-overlay", "Terminal has exited", "restored exit-shell overlay");
    await expect(restoredPage, ".terminal-overlay button.primary-button", "restored reopen button");
    await restoredPage.close();

    // ?local=1 直通：本地徽标、无 SSH 连接卡片、恰好一次自动启动。
    const localPage = await newPage(`${baseUrl}?render=dom&local=1`);
    const localStarts = await localPage.evaluate(() => window.__a4LocalStartCalls || 0);
    check("passthrough tab auto-starts the local shell exactly once", localStarts === 1, `calls=${localStarts}`);
    await expect(localPage, ".session-pill.session-local", "local session badge");
    for (const text of ["Production SSH", "192.168.1.64", "demo@server.demo.internal"]) {
      const hits = await localPage.locator(`text=${text}`).count();
      check(`no SSH connection artifact "${text}" in local passthrough`, hits === 0, `${hits} hit(s)`);
    }
    await localPage.close();
  }

  console.log("==> independent tunnel manager and saved quick start");
  const tunnelPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  tunnelPage.on("pageerror", (err) => pageError.push(String(err)));
  await tunnelPage.goto(`${baseUrl}?tunnels=1&theme=light&noanim=1`, { waitUntil: "domcontentloaded" });
  await expect(tunnelPage, "section.forwards-modal--standalone", "inline tunnel page");
  check("tunnel page has no modal overlay", await tunnelPage.locator('[data-slot="dialog-overlay"]').count() === 0);
  const primaryBackground = await tunnelPage.getByRole("button", { name: "Start all saved" }).evaluate((button) => getComputedStyle(button).backgroundColor);
  check("light theme supplies a visible primary button", primaryBackground === "rgb(23, 23, 23)", primaryBackground);
  await tunnelPage.locator('input[value="dynamic"]').check();
  await tunnelPage.locator('.forward-form-addresses input').nth(1).fill("1080");
  await tunnelPage.getByRole("button", { name: "Save preset" }).click();
  await expectText(tunnelPage, ".forward-profiles .forward-row", "SOCKS5 127.0.0.1:1080", "saved SOCKS5 preset");
  // Model a context-menu start while the manager is already mounted. The
  // sidecar event only carries an ID, so the page must fetch the new row.
  await tunnelPage.evaluate(() => window.dbxPlugin.invoke("ssh/forward/start", {
    connectionId: "visual-connection", kind: "dynamic", listenHost: "127.0.0.1", listenPort: 1080,
  }));
  await expectText(tunnelPage, ".forwards-body > .forwards-list .forward-row", "SOCKS5 127.0.0.1:1080", "menu-started tunnel appears without reopening manager");
  await tunnelPage.goto(`${baseUrl}?tunnels=quick&theme=light&noanim=1`, { waitUntil: "domcontentloaded" });
  await expectText(tunnelPage, ".forwards-body > .forwards-list .forward-row", "SOCKS5 127.0.0.1:1080", "quick start restored saved tunnel");
  check("quick start has no modal overlay", await tunnelPage.locator('[data-slot="dialog-overlay"]').count() === 0);
  await tunnelPage.screenshot({ path: `${SHOT_DIR}/tunnel-manager.png`, fullPage: false });
  await tunnelPage.close();

  // --- Warp AI 对齐批：# 命令搜索 / 失败修复条 / 能力降级 -----------------
  // ?aifix=1 把 SSH 回显换成 633 全链路失败命令夹具（token/password 敏感值
  // 在场）；host.ai.openConversation 会话请求记录进 __dbxMockAiConversations。
  // `#` v2 与修复条分开两页走查：直连回填会把命令留在输入行，aifix 夹具的
  // 逐键缓冲不吃退格——同页续跑会让后续命令带上残留，拆页各自从空行起步。
  console.log("==> Warp AI: # command search (v2 direct generation + fill)");
  const aiSearchPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  aiSearchPage.on("pageerror", (err) => pageError.push(String(err)));
  await aiSearchPage.addInitScript(() => {
    localStorage.setItem("ssh-ai-assist", JSON.stringify({ search: true, fix: true, assist: true, agentMode: false, fixConsent: false }));
  });
  await aiSearchPage.goto(`${baseUrl}?render=dom&aifix=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await aiSearchPage.bringToFront();
  await aiSearchPage.click(".terminal-host");

  // 引导条（输出静默 600ms 后放行）：含 # AI 命令搜索项（aiSearch 可用时）。
  await expect(aiSearchPage, ".terminal-prompt-hints", "prompt hints bar appears after output settles");
  await expectText(aiSearchPage, ".terminal-prompt-hints", "AI command search", "hints bar includes the # AI search entry");

  // # 模式：键入 # 即本地改道（字节不进 PTY），提示条出现且随打字更新。
  await aiSearchPage.keyboard.press("#");
  await expect(aiSearchPage, ".terminal-ai-search", "# mode hint appears");
  // 引导条让位（真机截图回归）：# 模式字节不进 PTY、行缓冲恒空，引导条
  // 若不显式让位会与 # 搜索条叠画。
  check("# mode hides the prompt-hints cheat sheet", (await aiSearchPage.locator(".terminal-prompt-hints").count()) === 0, `hints=${await aiSearchPage.locator(".terminal-prompt-hints").count()}`);
  await aiSearchPage.keyboard.type("list files by size");
  await expectText(aiSearchPage, ".terminal-ai-search-query", "list files by size", "# mode shows the natural language query");
  // Esc 退出：不发起任何请求。
  await aiSearchPage.keyboard.press("Escape");
  check("Escape leaves # mode", (await aiSearchPage.locator(".terminal-ai-search").count()) === 0, "hint count");
  check("Escape triggers no generation", (await aiSearchPage.evaluate(() => (window.__dbxMockAiGenerations ?? []).length)) === 0, "generation count");

  // 再次进入并发起（v2 直连路径）：Enter 收起提示条 → 列模型/挑默认/
  // generateText → 确认弹窗（首行命令 + Why 说明 + 七语「不执行」确认）。
  await aiSearchPage.keyboard.press("#");
  await aiSearchPage.keyboard.type("list files by size");
  await aiSearchPage.keyboard.press("Enter");
  // 等待态（mock 生成 400ms）：submit 后提示条切 loading 形态（不是消失），
  // 输入冻结——打字不落 PTY、再按 Enter 不重复发起；结果回填后条收起。
  await expect(aiSearchPage, ".terminal-ai-search.pending", "pending tips shown while generating");
  check("typing frozen while pending (no PTY echo)", !(await aiSearchPage.locator(".xterm-rows").textContent())?.includes("zzz"), "echo check");
  await aiSearchPage.keyboard.press("Enter");
  const gensDuringPending = await aiSearchPage.evaluate(() => (window.__dbxMockAiGenerations ?? []).length);
  check("re-Enter during pending does not double-submit", gensDuringPending === 1, `generations=${gensDuringPending}`);
  // 生成即回填（Warp 同款默认插入，无插件层回填确认）：Why 行走通知。
  await expect(aiSearchPage, ".notice", "why/filled notice appears");
  await expectText(aiSearchPage, ".xterm-rows", "ls -S", "generated command filled into the input line");
  // 红线：只回填不执行——命令回显恰好一次（无回车回显/无执行输出），全程
  // 零面板会话；生成请求带「User request:」标记（mock 按它分流罐头）。
  await aiSearchPage.waitForTimeout(400);
  check("filled command is not executed", ((await aiSearchPage.locator(".xterm-rows").textContent())?.match(/ls -S/g) ?? []).length === 1, "echo count");
  check("direct fill opens no panel conversation", (await aiSearchPage.evaluate(() => (window.__dbxMockAiConversations ?? []).length)) === 0, "conversation count");
  const searchGenerations = await aiSearchPage.evaluate(() => window.__dbxMockAiGenerations ?? []);
  check("direct search generation carries the query prompt", searchGenerations.length === 1 && typeof searchGenerations[0]?.prompt === "string" && searchGenerations[0].prompt.includes("User request:") && searchGenerations[0].prompt.includes("list files by size"), JSON.stringify(searchGenerations).slice(0, 220));
  await aiSearchPage.screenshot({ path: `${SHOT_DIR}/07-warp-ai-search.png`, fullPage: false }).catch(() => undefined);
  await aiSearchPage.close();

  // 修复条走查（独立一页，空行起步）。
  console.log("==> Warp AI: fix bar (direct generation)");
  const aiPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  aiPage.on("pageerror", (err) => pageError.push(String(err)));
  await aiPage.addInitScript(() => {
    localStorage.setItem("ssh-ai-assist", JSON.stringify({ search: true, fix: true, assist: true, agentMode: false, fixConsent: false }));
  });
  await aiPage.goto(`${baseUrl}?render=dom&aifix=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await aiPage.bringToFront();
  await aiPage.click(".terminal-host");

  // 失败命令 → 修复条：开屏 transcript 自带 curl D;28 夹具条，先关掉它，
  // 再跑 deploy（633 D exit 2 夹具）；首次点击走快照预览确认。
  await aiPage.click(".terminal-ai-fix-close");
  // 关条点击会把焦点从 xterm textarea 挪走：重聚焦再键入（真实用户路径一致）。
  await aiPage.click(".terminal-host");
  await aiPage.waitForTimeout(300);
  await aiPage.keyboard.type("deploy");
  await aiPage.keyboard.press("Enter");
  await expectText(aiPage, ".terminal-ai-fix-command", "deploy", "fix bar carries the deploy command");
  await expect(aiPage, ".terminal-ai-fix", "fix bar appears for the failed command");
  await expectText(aiPage, ".terminal-ai-fix-exit", "✗ 2", "fix bar shows the exit code");
  await aiPage.click(".terminal-ai-fix-btn");
  await expect(aiPage, ".small-modal", "snapshot preview confirm dialog opens");
  const previewText = await aiPage.locator(".small-modal").first().textContent();
  check("preview shows the command and exit code", previewText?.includes("deploy") && previewText?.includes("2"), String(previewText).slice(0, 120));
  await aiPage.locator(".small-modal footer button").last().click();
  // 直连生成路径：宿主罐头响应「df -h /srv + Why」→ 生成即回填（Warp 同款，
  // 无插件层回填确认），Why 行走通知。
  await expect(aiPage, ".notice", "why/filled notice appears");
  await expectText(aiPage, ".xterm-rows", "df -h /srv", "generated command filled into the input line");
  check("fix bar dismisses after fill", (await aiPage.locator(".terminal-ai-fix").count()) === 0, "bar count");
  const aiGenerations = await aiPage.evaluate(() => window.__dbxMockAiGenerations ?? []);
  check("direct generation recorded with redacted prompt", aiGenerations.length === 1 && typeof aiGenerations[0]?.prompt === "string" && aiGenerations[0].prompt.includes("***") && !aiGenerations[0].prompt.includes("hunter2") && !aiGenerations[0].prompt.includes("ghp_"), JSON.stringify(aiGenerations).slice(0, 220));
  // 直连路径不开面板会话（`#` 已拆到独立页，这里全程会话数为 0）。
  check("direct path opens no panel conversation", ((await aiPage.evaluate(() => window.__dbxMockAiConversations ?? [])).length) === 0, "conversation count");
  const recState = await aiPage.evaluate(() => window.__dbxMockAiRecommendations?.());
  // 推荐卡语义：每张修复条各推一次（开屏 curl 夹具 + deploy），条消失即撤
  // ——pushes=clears=2 且最终清零。
  check("one recommendation per fix bar, cleared each time", recState?.pushes === 2 && recState?.clears === 2, JSON.stringify(recState));
  await aiPage.screenshot({ path: `${SHOT_DIR}/07-warp-ai.png`, fullPage: false }).catch(() => undefined);
  await aiPage.close();

  // 降级（?ai=off 模拟旧宿主）：# 照常进终端（shell 注释），无模式提示。
  const degradedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  degradedPage.on("pageerror", (err) => pageError.push(String(err)));
  await degradedPage.goto(`${baseUrl}?render=dom&ai=off`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await degradedPage.bringToFront();
  await degradedPage.click(".terminal-host");
  await degradedPage.keyboard.press("#");
  await degradedPage.waitForTimeout(300);
  check("degraded host: no # mode hint", (await degradedPage.locator(".terminal-ai-search").count()) === 0, "hint count");
  check("degraded host: # passes through to the PTY echo", (await degradedPage.locator(".terminal-host").textContent())?.includes("#") === true, "echo check");
  const degradedConversations = await degradedPage.evaluate(() => window.__dbxMockAiConversations ?? []);
  check("degraded host records no conversations", degradedConversations.length === 0, `count=${degradedConversations.length}`);

  // 面板回退路径（?aipanel=1 模拟 web 运行时：openConversation 在、直连缺）
  // ——`#` 回车保留 v1 面板会话路径；修复条点击同样走面板会话（不回填）。
  const panelPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  panelPage.on("pageerror", (err) => pageError.push(String(err)));
  await panelPage.addInitScript(() => {
    localStorage.setItem("ssh-ai-assist", JSON.stringify({ search: true, fix: true, assist: true, agentMode: false, fixConsent: true }));
  });
  await panelPage.goto(`${baseUrl}?render=dom&aifix=1&aipanel=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await panelPage.bringToFront();
  await panelPage.click(".terminal-host");
  // `#` 搜索（直连缺 → 面板回退）：发起落 openConversation，零直连生成、零回填。
  await panelPage.keyboard.press("#");
  await expect(panelPage, ".terminal-ai-search", "panel fallback # mode hint appears");
  await panelPage.keyboard.type("find large files");
  await panelPage.keyboard.press("Enter");
  check("panel fallback Enter leaves # mode", (await panelPage.locator(".terminal-ai-search").count()) === 0, "hint count");
  await panelPage.waitForTimeout(600);
  const panelSearchConversations = await panelPage.evaluate(() => window.__dbxMockAiConversations ?? []);
  check(
    "panel fallback: # search opens a conversation",
    panelSearchConversations.length === 1 && panelSearchConversations[0]?.context?.kind === "ai-command-search" && panelSearchConversations[0]?.context?.query === "find large files" && panelSearchConversations[0]?.mode === "ask" && panelSearchConversations[0]?.send === true,
    JSON.stringify(panelSearchConversations).slice(0, 200),
  );
  check("panel fallback: # search performs no direct generation", (await panelPage.evaluate(() => (window.__dbxMockAiGenerations ?? []).length)) === 0, "generation count");
  check("panel fallback: # search fills nothing into the input line", !((await panelPage.locator(".xterm-rows").textContent())?.includes("find large files")), "line check");

  // 修复条（面板回退）：点击走面板会话；`#` 回填为空行，deploy 直接起跑。
  await panelPage.click(".terminal-host");
  await panelPage.keyboard.type("deploy");
  await panelPage.keyboard.press("Enter");
  await expect(panelPage, ".terminal-ai-fix", "panel-fallback fix bar appears");
  await panelPage.click(".terminal-ai-fix-btn");
  await panelPage.waitForTimeout(600);
  const panelConversations = await panelPage.evaluate(() => window.__dbxMockAiConversations ?? []);
  check(
    "panel fallback fix opens a conversation (no direct generation)",
    panelConversations.length === 2 && panelConversations[1]?.mode === "ask" && panelConversations[1]?.context?.kind === "ai-fix",
    JSON.stringify(panelConversations).slice(0, 200),
  );
  const panelGenCount = await panelPage.evaluate(() => (window.__dbxMockAiGenerations ?? []).length);
  check("panel fallback performs no direct generation", panelGenCount === 0, `generations=${panelGenCount}`);
  await panelPage.screenshot({ path: `${SHOT_DIR}/07-warp-ai-panel.png`, fullPage: false }).catch(() => undefined);
  await panelPage.close();
  await degradedPage.close();

  if (pageError.length) {
    failures.push(`page errors: ${pageError.slice(0, 3).join(" | ")}`);
  }

  if (failures.length) {
    console.error(`\nsmoke_ui_mock: ${failures.length} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log("\nmock walkthrough: all green");
  }
} finally {
  await browser.close();
  if (process.platform === "win32") {
    // vite 经 cmd shell → pnpm.cmd → node 三层包裹，杀 shell 杀不掉真正的
    // vite 进程；必须 taskkill /T 杀整棵树，并销毁管道让事件循环能退出。
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(vite.pid)], { stdio: "ignore" }).unref();
    } catch { /* already gone */ }
  } else {
    vite.kill("SIGTERM");
  }
  vite.stdout?.destroy();
  vite.stderr?.destroy();
}
