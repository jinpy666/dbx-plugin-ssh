#!/usr/bin/env node
// Self-test for move-file.mjs. Builds a throwaway fixture in os.tmpdir(), runs
// the tool as a child process (so exit codes are exercised), and asserts the
// moved file, rewritten importers, untouched bare specifiers and a no-op
// dry-run. Plain node:assert; no dependencies.
//
//   node scripts/refactor/move-file.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "move-file.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "dbx-move-file-test-"));
const root = join(fixtureRoot, "repo");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(`  ${String(error.message).split("\n").join("\n  ")}`);
  }
}

function write(relativePath, contents) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function run(...args) {
  return spawnSync(process.execPath, [TOOL, "--root", root, ...args], { encoding: "utf8" });
}

function snapshot() {
  const files = new Map();
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  })(root);
  return files;
}

function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

try {
  // --- fixture ---------------------------------------------------------------
  write(
    "frontend/src/components/Widget.ts",
    [
      'import { helper } from "../lib/util";',
      'import type { WidgetOptions } from "./types";',
      'import vue from "vue";',
      "export const widget: WidgetOptions = { x: helper };",
      "export default vue;",
      "",
    ].join("\n"),
  );
  write("frontend/src/components/types.ts", "export type WidgetOptions = { x: number };\n");
  write("frontend/src/components/Panel.ts", 'import { widget } from "./Widget";\nexport const panel = widget;\n');
  write("frontend/src/components/Dup.ts", "export const dup = 1;\n");
  write("frontend/src/features/Dup.ts", "export const dup = 2;\n");
  write(
    "frontend/src/components/icons/index.ts",
    "export const icons = ['one'];\n",
  );
  write("frontend/src/lib/icons.ts", 'import { icons } from "../components/icons";\nexport const all = icons;\n');
  write("frontend/src/lib/util.ts", "export const helper = 1;\n");
  write(
    "frontend/src/lib/consumer.ts",
    'import { widget } from "../components/Widget.ts";\nexport const consumed = widget;\n',
  );
  write(
    "frontend/src/App.vue",
    [
      '<script setup lang="ts">',
      'import { widget } from "./components/Widget";',
      'import { ref } from "vue";',
      'import alias from "@/components/Widget";',
      'import pkg from "@scope/pkg/Widget";',
      'import tilde from "~/components/Widget";',
      "const W = widget;",
      "const R = ref;",
      "const A = [alias, pkg, tilde];",
      "</script>",
      "",
    ].join("\n"),
  );
  write("frontend/src/raw.ts", 'import text from "./components/Widget?raw";\nexport default text;\n');
  write(
    "frontend/src/dynamic.ts",
    'const mod = import("./components/Widget");\nexport default mod;\n',
  );
  write("frontend/package.json", '{ "name": "fixture" }\n');
  write("frontend/src/style.css", "body { color: red; }\n");
  write("backend/src/lib.rs", "pub fn main() {}\n");

  git("init", "-q");
  git("add", "-A");

  const from = "frontend/src/components/Widget.ts";
  const to = "frontend/src/features/nested/Widget.ts";
  const movedPath = join(root, to);
  const before = snapshot();

  test("dry-run exits 0, writes nothing, creates no target directory", () => {
    const result = run("--dry-run", from, to);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(movedPath), false, "target must not exist after dry-run");
    assert.equal(existsSync(join(root, "frontend/src/features/nested")), false, "no dirs created");
    assert.match(result.stdout, /DRY-RUN MOVE frontend\/src\/components\/Widget\.ts -> frontend\/src\/features\/nested\/Widget\.ts/);
    assert.match(result.stdout, /nothing written/);
    const after = snapshot();
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [path, contents] of before) assert.equal(after.get(path), contents, `dry-run touched ${path}`);
  });

  test("moves the file and rewrites every relative importer", () => {
    const result = run(from, to);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, from)), false, "source still on disk");
    assert.equal(existsSync(movedPath), true, "target missing");
    assert.match(result.stdout, /rewrote 7 specifier\(s\) in 6 file\(s\)/);
  });

  test("moved file re-bases its own imports", () => {
    const text = read(to);
    assert.match(text, /from "\.\.\/\.\.\/lib\/util"/, text);
    assert.match(text, /from "\.\.\/\.\.\/components\/types"/, text);
    assert.match(text, /from "vue"/, "bare package import must stay put");
  });

  test("importers are rewritten (extension style preserved)", () => {
    assert.match(read("frontend/src/components/Panel.ts"), /from "\.\.\/features\/nested\/Widget"/);
    assert.match(read("frontend/src/lib/consumer.ts"), /from "\.\.\/features\/nested\/Widget\.ts"/);
    assert.match(read("frontend/src/App.vue"), /from "\.\/features\/nested\/Widget"/);
    assert.match(read("frontend/src/raw.ts"), /from "\.\/features\/nested\/Widget\?raw"/);
    assert.match(read("frontend/src/dynamic.ts"), /import\("\.\/features\/nested\/Widget"\)/);
  });

  test("bare and aliased specifiers are untouched", () => {
    const app = read("frontend/src/App.vue");
    assert.match(app, /from "vue"/);
    assert.match(app, /from "@\/components\/Widget"/);
    assert.match(app, /from "@scope\/pkg\/Widget"/);
    assert.match(app, /from "~\/components\/Widget"/);
  });

  test("re-running the same move is an idempotent no-op", () => {
    const beforeRerun = snapshot();
    const result = run(from, to);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already moved/);
    assert.match(result.stdout, /repaired 0 specifier\(s\) in 0 file\(s\)/);
    assert.deepEqual(snapshot(), beforeRerun);
  });

  test("directory/index imports keep their original style and empty dirs are pruned", () => {
    const result = run("frontend/src/components/icons/index.ts", "frontend/src/assets/icons/index.ts");
    assert.equal(result.status, 0, result.stderr);
    assert.match(read("frontend/src/lib/icons.ts"), /from "\.\.\/assets\/icons"/);
    assert.equal(existsSync(join(root, "frontend/src/components/icons")), false, "empty dir pruned");
    assert.equal(existsSync(join(root, "frontend/src/assets/icons/index.ts")), true);
  });

  test("target that already exists is refused with exit 4", () => {
    const result = run("frontend/src/components/Dup.ts", "frontend/src/features/Dup.ts");
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /target already exists/);
    assert.equal(existsSync(join(root, "frontend/src/components/Dup.ts")), true);
  });

  test("paths outside frontend/src are refused with exit 3", () => {
    const result = run("frontend/package.json", "frontend/src/package.json");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /inside frontend\/src/);
    const traversal = run("frontend/src/../package.json", "frontend/src/package.json");
    assert.equal(traversal.status, 3, traversal.stderr);
  });

  test("backend/src is refused with exit 6 and an explicit reason", () => {
    const result = run("backend/src/lib.rs", "backend/src/lib2.rs");
    assert.equal(result.status, 6, result.stderr);
    assert.match(result.stderr, /Rust module paths/);
    assert.equal(existsSync(join(root, "backend/src/lib2.rs")), false);
  });

  test("unsupported extensions are refused with exit 6", () => {
    const result = run("frontend/src/style.css", "frontend/src/theme/style.css");
    assert.equal(result.status, 6, result.stderr);
    assert.match(result.stderr, /only \.ts/);
  });

  test("missing source is refused with exit 4", () => {
    const result = run("frontend/src/nope.ts", "frontend/src/nope2.ts");
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /missing file/);
  });

  test("usage errors exit 2", () => {
    const result = run("only-one-arg");
    assert.equal(result.status, 2, result.stderr);
  });
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
