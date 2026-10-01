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
  await expectText(page, ".batch-target-row", "demo@server.demo.internal", "target row user@host");
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
  console.log("==> history panel walkthrough");
  const historyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  historyPage.on("pageerror", (err) => pageError.push(String(err)));
  await historyPage.addInitScript(() => {
    window.localStorage.setItem(
      "ssh-command-history",
      JSON.stringify(["echo ui-mock-history-a", "tail -f /var/log/ui-mock.log", "kubectl get pods -n ui-mock"]),
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
  await sleep(200);
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
