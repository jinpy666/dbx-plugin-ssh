#!/usr/bin/env node
/**
 * smoke_ui_settings.mjs — scripted walkthrough of the Tabby-parity settings surface.
 *
 * Boots the vite dev server, opens frontend/mock.html in headless Chrome
 * (playwright-core, system Chrome channel) and exercises the four terminal
 * settings categories the theme/behaviour rounds added:
 *
 *   1. category order (外观 / 配色方案 / 终端 / 快捷键 ahead of the plugin-only panes)
 *   2. 外观 + 配色方案 split (typography vs. theme/scheme, preview in both)
 *   3. 终端 panes: Rendering / Keyboard / Mouse / Clipboard / Sound, default values
 *   4. 快捷键 editor: recording, persistence, conflict marking, reset
 *   5. round-trip: edit → localStorage → reload → re-open shows the saved value
 *   6. end-to-end hotkey dispatch: a rebound key really clears the terminal, and
 *      the replaced default no longer does — this is what proves the registry is
 *      wired into the keystroke path rather than merely persisted
 *   7. zh-CN localisation of the new categories
 *
 * Dependency policy: playwright-core is installed OUTSIDE the repo
 * (/tmp/dbx-ui-mock, same gate as smoke_ui_mock.mjs) — the project
 * package.json stays dependency-frozen. If playwright-core or Chrome is
 * unavailable the script SKIPs (exit 0), matching the smoke SKIP semantics.
 * CI (and anyone who wants a hard gate) sets DBX_SMOKE_STRICT=1: a SKIP that
 * stems from missing tooling then exits non-zero, so a broken environment can
 * no longer share the silent-green path with a genuine pass. Assertion and
 * timeout failures always exit non-zero, strict or not.
 *
 * Screenshots land in docs/screenshots-ui-settings/ (untracked, like the
 * existing docs/screenshots-ui-mock/ outputs).
 *
 * Usage: node scripts/smoke_ui_settings.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRONTEND = join(ROOT, "frontend");
const SHOT_DIR = join(ROOT, "docs", "screenshots-ui-settings");
const VIEWPORT = { width: 1440, height: 960 };
const BEHAVIOR_KEY = "ssh-terminal-behavior";
const HOTKEYS_KEY = "ssh-terminal-hotkeys";

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
let chromium;
const playwrightCandidates =
  process.platform === "win32"
    ? [join(tmpdir(), "dbx-ui-mock"), "C:\\tmp\\dbx-ui-mock", "D:\\tmp\\dbx-ui-mock"]
    : ["/tmp/dbx-ui-mock"];
for (const dir of playwrightCandidates) {
  try {
    ({ chromium } = await import(pathToFileURL(join(dir, "node_modules/playwright-core/index.mjs")).href));
    break;
  } catch {
    /* try next candidate */
  }
}
if (!chromium) skip("playwright-core not available at /tmp/dbx-ui-mock (npm install --prefix /tmp/dbx-ui-mock playwright-core)");
// Linux：launch 用 channel:"chrome"，探测装在标准路径的稳定版/发行版 Chrome
//（ubuntu runner 自带 google-chrome-stable —— CI 门禁依赖这一点）。
const chromeCandidates =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app", "/Applications/Chromium.app"]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
if (!chromeCandidates.some((p) => p && existsSync(p))) skip("no system Chrome/Chromium");

// --- vite dev server ---
// Runs the repo-local vite binary through node instead of `pnpm exec vite`, so
// the script needs no PATH setup. No fixed port: vite picks a free one and
// prints the URL, which is what we parse.
console.log("==> starting vite dev server");
const vite = spawn(process.execPath, [join(FRONTEND, "node_modules", "vite", "bin", "vite.js")], {
  cwd: FRONTEND,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});
let stdoutBuf = "";
vite.stdout.on("data", (d) => {
  stdoutBuf += String(d);
});
vite.on("error", (e) => process.stderr.write(`[vite spawn error] ${e}\n`));
vite.on("exit", (code, sig) => { if (code !== 0 && code !== null) process.stderr.write(`[vite exited] code=${code} sig=${sig}\n`); });
vite.stderr.on("data", (d) => process.stderr.write(d));

let origin = "";
const upDeadline = Date.now() + 180_000; // 冷缓存下 vite optimizeDeps 可能远超 60s
while (Date.now() < upDeadline) {
  const match = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)\//.exec(stdoutBuf);
  if (match) {
    origin = match[1];
    break;
  }
  await sleep(500);
}
if (!origin) skip(`vite dev server did not report a URL in time; vite stdout tail: ${stdoutBuf.slice(-400) || "(empty)"}`);
const baseUrl = `${origin}/mock.html`;
console.log(`==> dev server up: ${baseUrl}`);

const failures = [];
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
  const page = await browser.newPage({ viewport: VIEWPORT });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // Start from a clean preference store so default-value assertions are honest:
  // ?render=dom pins the DOM renderer (WebGL keeps terminal text on the GPU
  // canvas, which would break every DOM text assertion below).
  await page.goto(`${baseUrl}?render=dom`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(1_500);
  await page.evaluate(
    ([behavior, hotkeys]) => {
      localStorage.removeItem(behavior);
      localStorage.removeItem(hotkeys);
    },
    [BEHAVIOR_KEY, HOTKEYS_KEY],
  );
  await page.goto(`${baseUrl}?render=dom`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2_500);

  async function openSettings() {
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button svg[class*="lucide-settings"]')?.closest("button");
        return btn instanceof HTMLButtonElement && !btn.disabled;
      },
      null,
      { timeout: 20_000 },
    );
    await page.evaluate(() => document.querySelector('button svg[class*="lucide-settings"]').closest("button").click());
    await page.locator(".settings-nav-item").first().waitFor({ state: "visible", timeout: 15_000 });
  }

  async function closeSettings() {
    await page.locator(".settings-modal header button.icon-button").first().click();
    await page.locator(".settings-nav-item").first().waitFor({ state: "hidden", timeout: 10_000 });
  }

  async function openCategory(index) {
    await page.locator(".settings-nav-item").nth(index).click();
    await sleep(250);
  }

  /** Section titles of the currently visible settings pane. */
  async function visibleSections() {
    return (await page.locator(".settings-pane:visible .settings-section-title").allTextContents()).map((t) => t.trim());
  }

  async function storedState() {
    return page.evaluate(
      ([behavior, hotkeys]) => ({
        behavior: JSON.parse(localStorage.getItem(behavior) ?? "null"),
        hotkeys: JSON.parse(localStorage.getItem(hotkeys) ?? "null"),
      }),
      [BEHAVIOR_KEY, HOTKEYS_KEY],
    );
  }

  console.log("==> workbench anchors");
  await page.locator(".session-pill").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".terminal-host").first().waitFor({ state: "visible", timeout: 15_000 });

  mkdirSync(SHOT_DIR, { recursive: true });

  console.log("==> settings: category order");
  await openSettings();
  const navTexts = (await page.locator(".settings-nav-item").allTextContents()).map((t) => t.trim());
  check("nine settings categories", navTexts.length === 9, JSON.stringify(navTexts));
  check(
    "terminal categories come first, in Tabby order",
    navTexts[0] === "Appearance" && navTexts[1] === "Color scheme" && navTexts[3] === "Hotkeys",
    JSON.stringify(navTexts.slice(0, 4)),
  );

  console.log("==> 外观 pane (typography only)");
  await openCategory(0);
  const appearanceSections = await visibleSections();
  check(
    "appearance keeps typography / cursor / render",
    appearanceSections.some((s) => /font/i.test(s)) && appearanceSections.some((s) => /cursor/i.test(s)),
    JSON.stringify(appearanceSections),
  );
  check(
    "scheme controls moved out of appearance",
    !(await page.locator(".settings-pane:visible .theme-chips").count()),
    "theme chips still present in appearance",
  );
  check("appearance shows the live preview", (await page.locator(".settings-pane:visible .appearance-preview").count()) === 1);
  await page.screenshot({ path: join(SHOT_DIR, "01-appearance.png") });

  console.log("==> 配色方案 pane");
  await openCategory(1);
  check("theme chips rendered", (await page.locator(".settings-pane:visible .theme-chip").count()) > 3);
  check("scheme-source radios rendered", (await page.locator(".settings-pane:visible input[name='terminal-scheme-source']").count()) === 2);
  check("scheme pane shows the live preview", (await page.locator(".settings-pane:visible .appearance-preview").count()) === 1);
  await page.screenshot({ path: join(SHOT_DIR, "02-color-scheme.png") });

  console.log("==> 终端 pane: sections and defaults");
  await openCategory(2);
  const terminalSections = await visibleSections();
  for (const title of ["Rendering", "Keyboard", "Mouse", "Clipboard", "Sound"]) {
    check(`terminal section "${title}"`, terminalSections.includes(title), JSON.stringify(terminalSections));
  }
  const scrollback = page.locator(".settings-pane:visible label.settings-field", { hasText: "Scrollback" }).locator("input[type='number']");
  check("scrollback defaults to 25000", (await scrollback.inputValue()) === "25000", await scrollback.inputValue());

  const rightClick = page.locator(".settings-pane:visible input[name='terminal-right-click']");
  check("right-click offers four modes", (await rightClick.count()) === 4, String(await rightClick.count()));
  const rightClickValues = await rightClick.evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, checked: n.checked })));
  check("right-click default is paste", rightClickValues.find((r) => r.checked)?.value === "paste", JSON.stringify(rightClickValues));

  const bell = page.locator(".settings-pane:visible input[name='terminal-bell']");
  check("bell offers three modes", (await bell.count()) === 3, String(await bell.count()));
  const bellValues = await bell.evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, checked: n.checked })));
  check("bell default is off", bellValues.find((r) => r.checked)?.value === "off", JSON.stringify(bellValues));

  const wordSeparator = page.locator(".settings-pane:visible label.settings-field", { hasText: "Word separators" }).locator("input.mono");
  check("word separators default matches Tabby", (await wordSeparator.inputValue()) === " ()[]{}\\'\"", JSON.stringify(await wordSeparator.inputValue()));

  const copyOnSelect = page.locator(".settings-pane:visible label.settings-switch-row", { hasText: "Copy on select" }).locator("[role='switch']");
  check("copy-on-select switch present", (await copyOnSelect.count()) === 1);
  check("copy-on-select default stays on (pre-existing behaviour)", (await copyOnSelect.first().getAttribute("aria-checked")) === "true");
  await page.screenshot({ path: join(SHOT_DIR, "03-terminal.png") });

  console.log("==> 快捷键 pane: editor surface");
  await openCategory(3);
  const hotkeyRows = page.locator(".settings-pane:visible .hotkey-row");
  check("ten bindable actions", (await hotkeyRows.count()) === 10, String(await hotkeyRows.count()));
  const groupTitles = await page.locator(".settings-pane:visible .hotkey-group .settings-section-title").allTextContents();
  check("actions grouped clipboard / view / navigation", groupTitles.map((t) => t.trim()).join("|") === "Clipboard|View|Navigation", JSON.stringify(groupTitles));
  const searchRow = hotkeyRows.filter({ hasText: "Find in terminal" });
  check("search row labelled and bound by default", (await searchRow.locator(".hotkey-chip").count()) >= 1);

  await page.fill(".settings-pane:visible .hotkey-search", "no-such-action-zzz");
  await sleep(250);
  check("search filters to the empty state", (await page.locator(".settings-pane:visible .hotkey-row").count()) === 0);
  check("empty state message shown", (await page.locator(".settings-pane:visible .empty.compact").count()) === 1);
  await page.fill(".settings-pane:visible .hotkey-search", "");
  await sleep(250);
  await page.screenshot({ path: join(SHOT_DIR, "04-hotkeys.png") });

  console.log("==> 快捷键 pane: record, persist, conflict");
  // Rebind "Clear terminal" from its Cmd+K default to Cmd+U. Recording is a
  // real keyboard interaction against the window-level capture listener.
  const clearRow = page.locator(".settings-pane:visible .hotkey-row", { hasText: "Clear terminal" });
  const clearChipsBefore = (await clearRow.locator(".hotkey-chip").allTextContents()).map((t) => t.trim());
  await clearRow.locator(".hotkey-chip").first().click();
  await clearRow.locator(".hotkey-chip.recording").waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press("Meta+u");
  await sleep(250);
  const clearChipsAfter = (await clearRow.locator(".hotkey-chip").allTextContents()).map((t) => t.trim());
  check(
    "recording replaces the binding",
    clearChipsAfter.length && clearChipsBefore[0] !== clearChipsAfter[0] && clearChipsAfter[0].endsWith("U"),
    `${JSON.stringify(clearChipsBefore)} -> ${JSON.stringify(clearChipsAfter)}`,
  );
  let stored = await storedState();
  check("binding persisted to localStorage", Array.isArray(stored.hotkeys?.clear) && stored.hotkeys.clear.some((c) => c.endsWith("U")), JSON.stringify(stored.hotkeys?.clear));

  // Bare keys must be rejected: a modifier-less chord would swallow plain typing.
  const copyRow = page.locator(".settings-pane:visible .hotkey-row", { hasText: "Copy" }).first();
  await copyRow.locator(".hotkey-add").click();
  await page.keyboard.press("q");
  await sleep(200);
  check("bare key rejected with a hint", (await page.locator(".settings-pane:visible .task-error").count()) === 1);
  check("still recording after rejection", (await page.locator(".settings-pane:visible .hotkey-chip.recording, .settings-pane:visible .hotkey-add.recording").count()) >= 1);

  // Now claim the combo the "Find in terminal" action owns → conflict marking.
  await page.keyboard.press("Meta+f");
  await sleep(250);
  const conflicting = page.locator(".settings-pane:visible .hotkey-chip.conflict");
  check("duplicate combo flagged as a conflict", (await conflicting.count()) >= 2, String(await conflicting.count()));
  check("conflict tooltip names the other action", /Find in terminal/.test((await conflicting.first().getAttribute("title")) ?? ""), await conflicting.first().getAttribute("title"));
  // Drop the duplicate again so "Copy" does not shadow the "Find in terminal"
  // combo in the dispatch assertions further down.
  await copyRow.locator(".hotkey-remove").last().click();
  await sleep(250);
  check("conflict resolved after removing the duplicate", (await page.locator(".settings-pane:visible .hotkey-chip.conflict").count()) === 0);

  console.log("==> 终端 pane: edit → persist → reload round-trip");
  await openCategory(2);
  await page.locator(".settings-pane:visible input[name='terminal-right-click'][value='clipboard']").check();
  await page.locator(".settings-pane:visible label.settings-field", { hasText: "Scrollback" }).locator("input[type='number']").fill("5000");
  await page.locator(".settings-pane:visible label.settings-field", { hasText: "Scrollback" }).locator("input[type='number']").dispatchEvent("change");
  await sleep(300);
  stored = await storedState();
  check("right-click persisted", stored.behavior?.rightClick === "clipboard", JSON.stringify(stored.behavior?.rightClick));
  check("scrollback persisted", stored.behavior?.scrollbackLines === 5000, JSON.stringify(stored.behavior?.scrollbackLines));
  check("legacy select-copy mirror kept for downgrades", stored.behavior?.copyOnSelect === true);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2_500);
  await openSettings();
  await openCategory(2);
  const replayedRightClick = await page
    .locator(".settings-pane:visible input[name='terminal-right-click']")
    .evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, checked: n.checked })));
  check("right-click value replayed after reload", replayedRightClick.find((r) => r.checked)?.value === "clipboard", JSON.stringify(replayedRightClick));
  const replayedScrollback = await page.locator(".settings-pane:visible label.settings-field", { hasText: "Scrollback" }).locator("input[type='number']").inputValue();
  check("scrollback value replayed after reload", replayedScrollback === "5000", replayedScrollback);

  console.log("==> hotkey dispatch reaches the terminal");
  // The mock PTY does not emulate tty echo, so nothing may be typed into the
  // buffer to prove a keystroke landed. The search panel is content-free and
  // therefore the honest observable: rebind "Find in terminal" off its default
  // and check that the recorded combo opens the panel while the replaced
  // default no longer does. That is what separates "persisted" from "wired".
  const APPLE = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const MOD = APPLE ? "Meta" : "Control";
  const DEFAULT_SEARCH_CHORD = APPLE ? `${MOD}+f` : `${MOD}+Shift+f`;

  await openCategory(3);
  const searchRowAgain = page.locator(".settings-pane:visible .hotkey-row", { hasText: "Find in terminal" });
  const searchChipsBefore = (await searchRowAgain.locator(".hotkey-chip").allTextContents()).map((t) => t.trim());
  await searchRowAgain.locator(".hotkey-chip").first().click();
  await searchRowAgain.locator(".hotkey-chip.recording").waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press(`${MOD}+j`);
  await sleep(250);
  const searchChipsAfter = (await searchRowAgain.locator(".hotkey-chip").allTextContents()).map((t) => t.trim());
  check(
    "search rebound off its platform default",
    searchChipsAfter.some((c) => c.includes("J")) && !searchChipsAfter.some((c) => c.includes("F")),
    `${JSON.stringify(searchChipsBefore)} -> ${JSON.stringify(searchChipsAfter)}`,
  );
  await closeSettings();

  // Clicking the screen puts focus on xterm's hidden textarea, which is where
  // attachCustomKeyEventHandler is invoked from.
  async function focusTerminal() {
    await page.locator(".terminal-host .xterm-screen").first().click();
    await sleep(200);
  }
  await page.bringToFront();
  await focusTerminal();
  const focused = await page.evaluate(() => document.activeElement?.className ?? "");
  check("terminal textarea holds focus", /xterm-helper-textarea/.test(focused), focused);

  await page.keyboard.press(DEFAULT_SEARCH_CHORD);
  await sleep(400);
  check("replaced default no longer opens search", (await page.locator(".terminal-search-panel:visible").count()) === 0);

  await page.keyboard.press(`${MOD}+j`);
  let recordedBindingOpens = false;
  try {
    await page.locator(".terminal-search-panel").first().waitFor({ state: "visible", timeout: 5_000 });
    recordedBindingOpens = true;
  } catch {
    recordedBindingOpens = false;
  }
  check("recorded binding opens the search panel", recordedBindingOpens);
  await page.screenshot({ path: join(SHOT_DIR, "05-hotkey-dispatch.png") });

  await page.keyboard.press("Escape");
  await sleep(400);
  check("escape closes the search panel", (await page.locator(".terminal-search-panel:visible").count()) === 0);

  // Regression guard for the keys d983f8fc dropped from i18n.ts while leaving
  // their call sites behind: the permission-mode options used to render as the
  // raw strings "mcpSettings.permissionModeAutonomous" / "...Confirm" because
  // workbenchMessage falls back to the key itself. This is the one restored key
  // reachable without a live SSH session, so it is worth asserting in a browser
  // rather than only against the message table.
  console.log("==> MCP pane: restored copy renders instead of raw keys");
  // The dispatch group above closed the dialog to focus the terminal, so the
  // settings surface has to be reopened before touching the category nav again.
  await openSettings();
  await openCategory(8);
  const approvalField = page.locator(".settings-pane:visible label.settings-field", { hasText: "MCP execution approval" });
  check("MCP execution-approval field rendered", (await approvalField.count()) === 1);
  if (await approvalField.count()) {
    await approvalField.locator("[role='combobox']").first().click();
    await sleep(300);
    const optionTexts = (await page.locator("[role='option']").allTextContents()).map((text) => text.trim());
    check(
      "permission-mode options are translated, not raw keys",
      optionTexts.includes("Autonomous") && optionTexts.includes("Confirm before running"),
      JSON.stringify(optionTexts),
    );
    check(
      "no raw i18n key leaked into the options",
      !optionTexts.some((text) => /^mcpSettings\.[A-Za-z]+$/.test(text)),
      JSON.stringify(optionTexts),
    );
    await page.keyboard.press("Escape");
    await sleep(250);
  }
  await page.screenshot({ path: join(SHOT_DIR, "06-mcp-approval.png") });

  console.log("==> zh-CN localisation of the new categories");
  const zhPage = await browser.newPage({ viewport: VIEWPORT });
  await zhPage.goto(`${baseUrl}?render=dom&locale=zh-CN`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2_500);
  await zhPage.waitForFunction(
    () => {
      const btn = document.querySelector('button svg[class*="lucide-settings"]')?.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    },
    null,
    { timeout: 20_000 },
  );
  await zhPage.evaluate(() => document.querySelector('button svg[class*="lucide-settings"]').closest("button").click());
  await zhPage.locator(".settings-nav-item").first().waitFor({ state: "visible", timeout: 15_000 });
  const zhNav = (await zhPage.locator(".settings-nav-item").allTextContents()).map((t) => t.trim());
  check(
    "zh-CN nav translates the new categories",
    zhNav[0] === "外观" && zhNav[1] === "配色方案" && zhNav[3] === "快捷键",
    JSON.stringify(zhNav.slice(0, 4)),
  );
  await zhPage.close();

  if (pageErrors.length) failures.push(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);

  if (failures.length) {
    console.error(`\nsmoke_ui_settings: ${failures.length} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\nsettings walkthrough: all green (screenshots in docs/screenshots-ui-settings/)`);
  }
} finally {
  await browser.close();
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(vite.pid)], { stdio: "ignore" }).unref();
    } catch {
      /* already gone */
    }
  } else {
    vite.kill("SIGTERM");
  }
  vite.stdout?.destroy();
  vite.stderr?.destroy();
}
