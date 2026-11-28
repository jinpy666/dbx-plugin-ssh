#!/usr/bin/env node
// 自测：scripts/refresh_structure_allowlist.mjs。
//
// 全部用例跑在 `os.tmpdir()` 下的临时 fixture 树上，不触碰真实仓库；守卫文件用
// 最小可解析片段生成（同样的常量声明 + LINE_ALLOWLIST 块 + DIRECTION_ALLOWLIST）。
// 运行：node scripts/refresh_structure_allowlist.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "refresh_structure_allowlist.mjs");

/* ------------------------------------------------------------------ */
/* fixture 构造                                                        */
/* ------------------------------------------------------------------ */

/** 1200 -> "1_200"，与真实守卫的书写风格一致（预算解析需兼容下划线）。 */
function formatBudget(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

function rustGuard(entries, { comments = {}, sourceBudget = 600, testBudget = 1200 } = {}) {
  const body = entries
    .map(([path, lines]) => [...(comments[path] ?? []), `    ("${path}", ${lines}),`].join("\n"))
    .join("\n");
  return [
    "// fixture rust guard",
    `const MAX_SOURCE_LINES: usize = ${formatBudget(sourceBudget)};`,
    `const MAX_TEST_LINES: usize = ${formatBudget(testBudget)};`,
    "",
    "const LINE_ALLOWLIST: &[(&str, usize)] = &[",
    ...(body === "" ? [] : body.split("\n")),
    "];",
    "",
    "fn ignored() {}",
    "",
  ].join("\n");
}

function tsGuard(entries, { comments = {}, direction = ["./lib/fileIcons.ts"] } = {}) {
  const body = entries
    .map(([path, lines]) => [...(comments[path] ?? []), `  ${JSON.stringify(path)}: ${lines},`].join("\n"))
    .join("\n");
  return [
    "// fixture ts guard",
    "const SOURCES = {} as Record<string, string>;",
    "const MAX_SOURCE_LINES = 600;",
    "const MAX_SPEC_LINES = 1_200;",
    "",
    "const LINE_ALLOWLIST: Record<string, number> = {",
    ...(body === "" ? [] : body.split("\n")),
    "};",
    "",
    `const DIRECTION_ALLOWLIST: string[] = [${direction.map((item) => JSON.stringify(item)).join(", ")}];`,
    "",
  ].join("\n");
}

function writeLines(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x\n".repeat(lines));
}

function makeFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "structure-allowlist-"));
  const rustDir = join(root, "backend/src");
  const tsDir = join(root, "frontend/src");
  mkdirSync(rustDir, { recursive: true });
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(
    join(rustDir, "structure_tests.rs"),
    rustGuard(options.rustEntries ?? [], { comments: options.rustComments, ...(options.rustGuard ?? {}) }),
  );
  writeFileSync(
    join(tsDir, "structure.spec.ts"),
    tsGuard(options.tsEntries ?? [], { comments: options.tsComments, ...(options.tsGuard ?? {}) }),
  );
  for (const [rel, lines] of Object.entries(options.rustFiles ?? {})) writeLines(join(rustDir, rel), lines);
  for (const [rel, lines] of Object.entries(options.tsFiles ?? {})) writeLines(join(tsDir, rel), lines);
  return root;
}

/** 每个用例独立 fixture，结束后删除。 */
function withFixture(options, fn) {
  const root = makeFixture(options);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
}

function assertExit(result, expected, label) {
  assert.equal(
    result.status,
    expected,
    `${label}: expected exit ${expected}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

const rustText = (root) => readFileSync(join(root, "backend/src/structure_tests.rs"), "utf8");
const tsText = (root) => readFileSync(join(root, "frontend/src/structure.spec.ts"), "utf8");

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("--check exits 0 when both allowlists match the tree", () =>
  withFixture(
    {
      rustFiles: { "big.rs": 700 },
      rustEntries: [["big.rs", 700]],
      tsFiles: { "./App.vue": 700 },
      tsEntries: [["./App.vue", 700]],
    },
    (root) => {
      const result = run(root, "--check");
      assertExit(result, 0, "clean");
      assert.match(result.stdout, /\[rust\].*ok（1 条/);
      assert.match(result.stdout, /\[ts\].*ok（1 条/);
    },
  ));

test("over-budget file appears: check=1, write adds, second write is idempotent, check=0", () =>
  withFixture({ rustFiles: { "new_big.rs": 700, "ok.rs": 10 } }, (root) => {
    const drift = run(root, "--check");
    assertExit(drift, 1, "drift");
    assert.match(drift.stdout, /DRIFT/);
    assert.ok(drift.stdout.includes('("new_big.rs", 700),'), drift.stdout);

    const first = run(root, "--write");
    assertExit(first, 0, "write");
    assert.ok(rustText(root).includes('    ("new_big.rs", 700),'));
    assert.ok(!rustText(root).includes("ok.rs"));

    const snapshot = rustText(root);
    const second = run(root, "--write");
    assertExit(second, 0, "second write");
    assert.match(second.stdout, /unchanged/);
    assert.equal(rustText(root), snapshot, "second --write must not change the file");

    assertExit(run(root, "--check"), 0, "check after write");
  }));

test("stale entry is dropped when the file falls back within budget", () =>
  withFixture({ rustFiles: { "shrunk.rs": 500 }, rustEntries: [["shrunk.rs", 800]] }, (root) => {
    const drift = run(root, "--check");
    assertExit(drift, 1, "drift");
    assert.match(drift.stdout, /stale/);

    const write = run(root, "--write");
    assertExit(write, 0, "write");
    assert.match(write.stdout, /stale/);
    assert.ok(!rustText(root).includes("shrunk.rs"));
    assertExit(run(root, "--check"), 0, "check after write");
  }));

test("entry for a file still over budget is never removed; value is tightened to actual lines", () =>
  withFixture({ rustFiles: { "grown.rs": 650, "tighten.rs": 640 }, rustEntries: [["grown.rs", 620], ["tighten.rs", 700]] }, (root) => {
    const write = run(root, "--write");
    assertExit(write, 0, "write");
    const text = rustText(root);
    assert.ok(text.includes('("grown.rs", 650),'), "entry must stay and follow the file");
    assert.ok(text.includes('("tighten.rs", 640),'), "entry must tighten to the real count");
    assert.ok(!text.includes("620"), "old value gone");
    assert.ok(!text.includes("700"), "old value gone");
    assertExit(run(root, "--check"), 0, "check after write");
  }));

test("invalid entry (allow <= budget) is corrected to the real line count", () =>
  withFixture({ rustFiles: { "mono.rs": 900 }, rustEntries: [["mono.rs", 500]] }, (root) => {
    const write = run(root, "--write");
    assertExit(write, 0, "write");
    assert.match(write.stdout, /invalid/);
    assert.ok(rustText(root).includes('("mono.rs", 900),'));
  }));

test("dead entry (file moved or deleted) is dropped", () =>
  withFixture({ rustEntries: [["gone.rs", 900]] }, (root) => {
    const write = run(root, "--write");
    assertExit(write, 0, "write");
    assert.match(write.stdout, /dead/);
    assert.ok(!rustText(root).includes("gone.rs"));
    assertExit(run(root, "--check"), 0, "check after write");
  }));

test("non-entry comments are preserved, follow their entry, and survive reordering", () =>
  withFixture(
    {
      rustFiles: { "ssh.rs": 1000, "ssh/tests.rs": 1310, "z.rs": 700 },
      rustEntries: [["ssh.rs", 1000], ["ssh/tests.rs", 1300], ["z.rs", 700]],
      rustComments: { "ssh/tests.rs": ["    // 说明：B1 纯搬移", "    // 第二行注释"] },
    },
    (root) => {
      const write = run(root, "--write");
      assertExit(write, 0, "write");
      const text = rustText(root);
      const first = text.indexOf("// 说明：B1 纯搬移");
      const second = text.indexOf("// 第二行注释");
      const entry = text.indexOf('("ssh/tests.rs", 1310),');
      assert.ok(first >= 0 && second > first, "both comment lines kept in order");
      assert.ok(entry > second, "comments sit directly above their entry");
      assert.equal(text.split("// 说明：B1 纯搬移").length - 1, 1, "comment not duplicated");
      assert.ok(text.indexOf('("ssh.rs", 1000),') < first, "ssh.rs stays ahead of its tests module");
      assertExit(run(root, "--check"), 0, "check after write");
    },
  ));

test("comment above a dropped entry is moved to the block end instead of deleted", () =>
  withFixture(
    {
      rustFiles: { "keep.rs": 800, "shrink.rs": 400 },
      rustEntries: [["keep.rs", 800], ["shrink.rs", 700]],
      rustComments: { "shrink.rs": ["    // 解释为何曾经冻结"] },
    },
    (root) => {
      const write = run(root, "--write");
      assertExit(write, 0, "write");
      assert.match(write.stdout, /comments above dropped entry preserved/);
      const text = rustText(root);
      assert.ok(text.includes("// 解释为何曾经冻结"), "comment must not be deleted");
      assert.ok(!text.includes('("shrink.rs",'), "entry itself must be dropped");
      assertExit(run(root, "--check"), 0, "check after write");
    },
  ));

test("test-file classification mirrors both guards", () =>
  withFixture(
    {
      rustFiles: {
        "mod_tests.rs": 700,
        "helper_test.rs": 700,
        "test_support.rs": 700,
        "tests/helper.rs": 700,
        "plain.rs": 700,
      },
      tsFiles: {
        "./lib/testing/helper.ts": 700,
        "./thing.spec.ts": 700,
        "./thing.test.ts": 700,
        "./plain.ts": 700,
      },
    },
    (root) => {
      assertExit(run(root, "--write"), 0, "write");
      const text = rustText(root);
      for (const keptOut of ["mod_tests.rs", "helper_test.rs", "test_support.rs", "tests/helper.rs"]) {
        assert.ok(!text.includes(keptOut), `${keptOut} 适用 1200 预算，不应入白名单`);
      }
      assert.ok(text.includes('("plain.rs", 700),'));

      const ts = tsText(root);
      for (const keptOut of ["lib/testing/helper.ts", "thing.spec.ts", "thing.test.ts"]) {
        assert.ok(!ts.includes(keptOut), `${keptOut} 适用 1200 预算，不应入白名单`);
      }
      assert.ok(ts.includes('"./plain.ts": 700,'));

      // 超过 1200 后必须入白名单。
      writeLines(join(root, "backend/src/tests/big.rs"), 1201);
      writeLines(join(root, "frontend/src/big.spec.ts"), 1201);
      assertExit(run(root, "--write"), 0, "write 2");
      assert.ok(rustText(root).includes('("tests/big.rs", 1201),'));
      assert.ok(tsText(root).includes('"./big.spec.ts": 1201,'));
    },
  ));

test("TS scan mirrors the Vite glob: no dotfiles, no node_modules, no self", () =>
  withFixture(
    {
      tsFiles: {
        "./node_modules/pkg/x.ts": 700,
        "./.hidden.ts": 700,
        "./visible.ts": 700,
      },
    },
    (root) => {
      // 让守卫文件自身也超过 1200 行：Vite 会过滤发起 glob 的模块自身。
      writeFileSync(join(root, "frontend/src/structure.spec.ts"), tsText(root) + "\n".repeat(1300));
      assertExit(run(root, "--write"), 0, "write");
      const ts = tsText(root);
      assert.ok(ts.includes('"./visible.ts": 700,'));
      assert.ok(!ts.includes("node_modules"));
      assert.ok(!ts.includes(".hidden"));
      assert.ok(!ts.includes('"./structure.spec.ts"'), "守卫自身不计入扫描结果");
    },
  ));

test("--check prints a real diff with - and + lines", () =>
  withFixture({ rustFiles: { "ssh.rs": 13930 }, rustEntries: [["ssh.rs", 13929]] }, (root) => {
    const result = run(root, "--check");
    assertExit(result, 1, "drift");
    assert.ok(result.stdout.includes('-     ("ssh.rs", 13929),'), result.stdout);
    assert.ok(result.stdout.includes('+     ("ssh.rs", 13930),'), result.stdout);
    assert.match(result.stdout, /updated: ssh\.rs 13929 -> 13930/);
  }));

test("DIRECTION_ALLOWLIST is reported and never rewritten", () =>
  withFixture(
    {
      tsFiles: { "./big.ts": 700 },
      tsGuard: { direction: ["./lib/fileIcons.ts", "./lib/other.ts"] },
    },
    (root) => {
      const result = run(root, "--write");
      assertExit(result, 0, "write");
      assert.match(result.stdout, /DIRECTION_ALLOWLIST: 2 条，未被本工具改动/);
      assert.ok(
        tsText(root).includes(
          'const DIRECTION_ALLOWLIST: string[] = ["./lib/fileIcons.ts", "./lib/other.ts"];',
        ),
      );
    },
  ));

test("budget constants are never modified", () =>
  withFixture({ rustFiles: { "big.rs": 900 }, tsFiles: { "./big.ts": 900 } }, (root) => {
    assertExit(run(root, "--write"), 0, "write");
    assert.ok(rustText(root).includes("const MAX_SOURCE_LINES: usize = 600;"));
    assert.ok(rustText(root).includes("const MAX_TEST_LINES: usize = 1_200;"));
    assert.ok(tsText(root).includes("const MAX_SOURCE_LINES = 600;"));
    assert.ok(tsText(root).includes("const MAX_SPEC_LINES = 1_200;"));
  }));

test("help exits 0 and unknown flags exit 2", () =>
  withFixture({}, (root) => {
    assertExit(run(root, "--help"), 0, "help");
    assertExit(run(root, "--nope"), 2, "unknown flag");
  }));

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL - ${name}\n`);
    process.stdout.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
