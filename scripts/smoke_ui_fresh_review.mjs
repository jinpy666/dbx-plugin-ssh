#!/usr/bin/env node
// Round4: exercise failed reads, alert retries and keyboard routing in the real
// Vue/xterm page. Uses the same optional browser dependency as smoke_ui_mock.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// 依赖门槛与 smoke_ui_mock.mjs 同规：playwright-core 装在仓库外（%TMP%/dbx-ui-mock
// 或 /tmp/dbx-ui-mock），Chrome 取系统安装；缺任一则 SKIP（exit 0）。
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
if (!chromium) {
  console.log("SKIP: playwright-core unavailable (npm install --prefix /tmp/dbx-ui-mock playwright-core)");
  process.exit(0);
}
const chromeCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    ]
  : ["/Applications/Google Chrome.app", "/Applications/Chromium.app"];
if (!chromeCandidates.some((p) => p && existsSync(p))) {
  console.log("SKIP: system Chrome is unavailable");
  process.exit(0);
}

let vite;
let browser;
try {
  let url = process.env.DBX_SSH_MOCK_URL;
  if (!url) {
    vite = spawn("pnpm", ["--dir", "frontend", "exec", "vite", "--host", "127.0.0.1"], {
      cwd: root,
      // Windows: pnpm 是 .cmd 包装，无 shell 直接 spawn 报 EINVAL。
      shell: process.platform === "win32",
    });
    let output = "";
    vite.stdout.on("data", data => { output += data; });
    vite.stderr.on("data", data => process.stderr.write(data));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !url) {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) url = `${match[0]}mock.html`;
      else await sleep(100);
    }
  }
  assert.ok(url, "Vite must start");
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):\d+\/mock\.html$/, "mock page only");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const shots = `${root}docs/screenshots-ui-mock`;
  mkdirSync(shots, { recursive: true });
  const reload = async () => {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector(".session-pill")?.textContent?.includes("Connected"));
  };

  await reload();
  await page.evaluate(() => {
    const base = window.dbxPlugin.invoke;
    window.__freshReview = { writes: 0, pending: true };
    window.dbxPlugin.invoke = (method, ...args) => {
      if (method === "ssh/settings/get" && window.__freshReview.pending) {
        return new Promise((_resolve, reject) => { window.__freshReview.reject = reject; });
      }
      if (method === "ssh/settings/set") window.__freshReview.writes++;
      return base(method, ...args);
    };
  });
  await page.locator('button[title="SSH settings"]').click();
  const save = page.locator(".settings-modal > footer .primary-button");
  assert.equal(await save.isDisabled(), true, "pending settings cannot be saved");
  await page.evaluate(() => window.__freshReview.reject(new Error("fixture read failure")));
  await page.locator('.settings-modal [role="alert"]').waitFor();
  assert.equal(await save.isDisabled(), true, "failed settings cannot be saved");
  assert.equal(await page.locator(".settings-modal .credential-source-row").count(), 0, "failed read must not expose stale connection settings");
  await save.dispatchEvent("click");
  assert.equal(await page.evaluate(() => window.__freshReview.writes), 0, "handler guards writes even on synthetic clicks");
  await page.screenshot({ path: `${shots}/round4-settings-failed.png` });
  await page.evaluate(() => { window.__freshReview.pending = false; });
  await page.locator('.settings-modal [role="alert"] button').click();
  // Tabby-parity category reorder moved the credential source off the dialog's
  // default tab ("Appearance") into the "Quick Sudo" pane — select it first.
  await page.locator(".settings-modal .settings-nav-item", { hasText: "Quick Sudo" }).click();
  await page.locator(".settings-modal .credential-source-row").waitFor();
  assert.equal(await save.isDisabled(), false);
  await save.click();
  assert.equal(await page.evaluate(() => window.__freshReview.writes), 1, "retry restores normal saving");
  console.log("PASS settings: loading / failure block writes; retry restores editing and saving");

  await reload();
  await page.locator('button[title="Alert triage"]').click();
  const payload = page.locator(".alert-triage-payload");
  const analyze = page.locator(".alert-triage-modal .primary-button");
  await payload.fill("Disk space is full");
  await analyze.click();
  await page.locator(".alert-triage-result").waitFor();
  await page.evaluate(() => {
    const base = window.dbxPlugin.invoke;
    window.__freshReview = { pending: true };
    window.dbxPlugin.invoke = (method, ...args) => {
      if (method === "ssh/alert/triage" && window.__freshReview.pending) {
        return new Promise((_resolve, reject) => { window.__freshReview.reject = reject; });
      }
      return base(method, ...args);
    };
  });
  await payload.fill("CPU load is high");
  assert.equal(await page.locator(".alert-triage-result").count(), 0, "editing invalidates the old result");
  await analyze.click();
  await page.locator('.alert-triage-modal [role="status"]').waitFor();
  assert.equal(await payload.isDisabled(), true, "in-flight payload stays paired with its response");
  await page.evaluate(() => window.__freshReview.reject(new Error("fixture analysis failure")));
  await page.locator('.alert-triage-modal [role="alert"]').waitFor();
  assert.equal(await page.locator(".alert-triage-result").count(), 0);
  assert.match(await page.locator('.alert-triage-modal [role="alert"]').innerText(), /Could not analyze this alert/);
  assert.equal(await payload.isDisabled(), false);
  assert.equal(await analyze.isDisabled(), false);
  await page.screenshot({ path: `${shots}/round4-alert-failed.png` });
  await page.evaluate(() => { window.__freshReview.pending = false; });
  await analyze.click();
  await page.locator(".alert-triage-result").waitFor();
  assert.equal(await page.locator(".alert-category").innerText(), "CPU");
  assert.equal(await page.locator('.alert-triage-modal [role="alert"]').count(), 0);
  console.log("PASS alerts: editing clears stale results; pending / failure / retry stay in the dialog");

  await reload();
  // 粘贴组合键（mod+V）keydown 不 preventDefault 是有意设计：放行浏览器原生
  // paste 事件（自带真实 clipboardData），由 terminalHost 捕获拦截器统一走风险
  // 确认（App.vue interceptTerminalPaste）；keydown 只 stopPropagation + 让 xterm
  // 跳过。快捷键注册表（lib/terminalHotkeys.ts）默认表按平台分：macOS 占 Cmd 系，
  // 其余平台占 Ctrl(+Shift) 系，且刻意不绑裸 Ctrl+F / Esc（留给远端 readline），
  // Esc 只在搜索面板打开时被消费。故按平台取默认绑定逐键断言。
  const APPLE = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const SEARCH = APPLE ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
  const UNOWNED_SEARCH = APPLE ? { ctrlKey: true } : { metaKey: true };
  const RESET_ZOOM = APPLE ? { metaKey: true } : { ctrlKey: true };
  const PASTE = APPLE ? { metaKey: true } : { ctrlKey: true };
  // keyComboFromEvent folds events by KeyboardEvent.code, so synthetic events
  // must carry the code (a bare { key } leaves code="" and every chord misses).
  for (const [key, code, modifiers, expected] of [
    ["f", "KeyF", SEARCH, { cancelled: true, bubbled: false }],
    // Search is open after the previous row: Esc is consumed closing it.
    ["Escape", "Escape", {}, { cancelled: true, bubbled: false }],
    // Search closed again: an off-table chord is not claimed by the app and
    // reaches the shell (terminalHotkeys.ts keeps Ctrl+F / Cmd-F split per
    // platform on purpose).
    ["f", "KeyF", UNOWNED_SEARCH, { cancelled: false, bubbled: true }],
    ["0", "Digit0", RESET_ZOOM, { cancelled: true, bubbled: false }],
    ["v", "KeyV", PASTE, { cancelled: false, bubbled: false }],
  ]) {
    const result = await page.evaluate(({ key, code, modifiers }) => {
      let bubbled = false;
      const listener = () => { bubbled = true; };
      document.addEventListener("keydown", listener);
      const event = new KeyboardEvent("keydown", { key, code, ...modifiers, bubbles: true, cancelable: true });
      document.querySelector(".xterm-helper-textarea").dispatchEvent(event);
      document.removeEventListener("keydown", listener);
      return { cancelled: event.defaultPrevented, bubbled };
    }, { key, code, modifiers });
    assert.deepEqual(result, expected, `owned shortcut ${key}`);
  }
  // 粘贴链路的另一端：原生 paste 事件必须在捕获阶段被拦截（取消默认 + 不冒泡），
  // 与 keydown 的放行配合保证「只走风险确认一次」。
  const pasteResult = await page.evaluate(() => {
    let bubbled = false;
    const listener = () => { bubbled = true; };
    document.addEventListener("paste", listener);
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "echo fresh-review-paste");
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector(".xterm-helper-textarea").dispatchEvent(event);
    document.removeEventListener("paste", listener);
    return { cancelled: event.defaultPrevented, bubbled };
  });
  assert.deepEqual(pasteResult, { cancelled: true, bubbled: false }, "paste event captured by risk-confirm interceptor");
  await page.evaluate(() => {
    const base = window.dbxPlugin.sendBinary;
    window.__freshReview = { input: [] };
    window.dbxPlugin.sendBinary = (channel, data) => {
      if (channel.startsWith("ssh/terminal/in/")) {
        const bytes = typeof data === "string" ? window.dbxPlugin.decodeBase64(data) : new Uint8Array(data);
        window.__freshReview.input.push(...bytes.slice(8));
      }
      return base(channel, data);
    };
  });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => window.__freshReview.input.includes(3) && window.__freshReview.input.includes(9));
  console.log("PASS keyboard: owned shortcuts cancel defaults and bubbling; Ctrl+C / Tab still reach PTY");
  assert.deepEqual(errors, [], "no unhandled page errors");
  console.log("PASS round4 fresh review UI smoke");
} finally {
  await browser?.close();
  if (vite) {
    if (process.platform === "win32") {
      // vite 经 cmd shell → pnpm.cmd → node 三层包裹，必须 taskkill /T 杀整棵树。
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(vite.pid)], { stdio: "ignore" }).unref();
      } catch { /* already gone */ }
    } else {
      vite.kill("SIGTERM");
    }
    vite.stdout?.destroy();
    vite.stderr?.destroy();
  }
}
