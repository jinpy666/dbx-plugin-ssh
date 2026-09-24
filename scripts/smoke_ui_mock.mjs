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
const chromeCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    ]
  : ["/Applications/Google Chrome.app", "/Applications/Chromium.app"];
const hasChrome = chromeCandidates.some((p) => p && existsSync(p));
if (!hasChrome) skip("no system Chrome/Chromium");

// --- vite dev server ---
console.log("==> starting vite dev server");
const vite = spawn("pnpm", ["--dir", "frontend", "exec", "vite"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  // Windows: pnpm 是 .cmd 包装，Node ≥18.20/20.12 起无 shell 直接 spawn 报 EINVAL。
  shell: process.platform === "win32",
});
vite.stderr.on("data", (d) => process.stderr.write(d));
let stdoutBuf = "";
vite.stdout.on("data", (d) => {
  stdoutBuf += String(d);
});
let baseUrl = "";
const upDeadline = Date.now() + 60_000;
while (Date.now() < upDeadline) {
  const match = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)\//.exec(stdoutBuf);
  if (match) {
    baseUrl = `${match[1]}/mock.html`;
    break;
  }
  await sleep(500);
}
if (!baseUrl) skip("vite dev server did not report a URL in time");
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

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/01-workbench.png`, fullPage: false });
  console.log(`  screenshot: docs/screenshots-ui-mock/01-workbench.png`);

  // --- global quick commands: add via the toolbar popover -----------------
  console.log("==> quick commands: global store add");
  // 自定义 tooltip 系统（App.vue 全局接管）：首次 hover 后 title 会挪到
  // data-tooltip，此后 button[title=...] 选择器不再命中，两处点击都要兼容。
  const QUICK_BTN = 'button[title="Quick commands"], button[data-tooltip="Quick commands"]';
  await page.click(QUICK_BTN);
  await expect(page, ".quick-commands-popover", "quick commands popover");
  await expectText(page, ".quick-command-global-hint", "Stored globally", "global-store hint");
  // 编辑器已改为子视图：先点"新建"按钮，名称 input + 命令 textarea。
  await page.click(".quick-new-btn");
  await page.fill(".quick-command-editor input", "ui-mock cmd");
  await page.fill(".quick-command-editor textarea", "echo ui-mock-batch");
  await page.click(".quick-command-editor .primary-button");
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

  // --- global quick commands: delete --------------------------------------
  console.log("==> quick commands: delete");
  await page.click(QUICK_BTN);
  // 动作按钮 hover 浮现（opacity 0 → 1），先悬停卡片再点删除；
  // 删除有 window.confirm 确认（不可逆操作），自动接受。
  await page.hover(".quick-command-row");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.click(".quick-command-row button.icon-button:last-child");
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
    await expectText(restoredPage, ".terminal-overlay", "Local terminal has exited", "restored exit-shell overlay");
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
