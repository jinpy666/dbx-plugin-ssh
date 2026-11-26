#!/usr/bin/env node
// Moves one frontend source file and rewrites every relative import that points
// at it (plus the moved file's own relative imports). Usage is path-based so the
// caller can run it repeatedly for grouped migrations.
//
//   node scripts/refactor/move-file.mjs [--dry-run] [--root <dir>] <from> <to>
//
// Both paths are resolved against the repo root (absolute paths also work) and
// must live inside `frontend/src`. Non-relative specifiers (`@/...`, `~/...`,
// packages) are never touched.
//
// Scope note: `backend/src` is deliberately refused. Rust module paths are not
// file-relative in the same sense as JS specifiers (`mod` declarations,
// `#[path]`, inline modules, `super::` depth, macros), so a generic rewrite
// cannot be proven correct. The ssh split plan keeps `ssh.rs` as the module
// root and only adds `ssh/*.rs` children, which needs no path rewriting.
//
// Exit codes:
//   0  success (including the idempotent "already moved" re-run)
//   1  unexpected I/O or git failure
//   2  usage error
//   3  path outside the allowed root(s)
//   4  invalid move (missing source, existing target, same path, symlink)
//   5  post-move verification failed (stale importer left behind)
//   6  unsupported scope (backend/src or unsupported file type)
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FRONTEND_GLOB = /\.(ts|tsx|vue|js|mjs|mts)$/;
const EXTENSIONS = [".d.ts", ".ts", ".tsx", ".vue", ".js", ".mjs", ".mts", ".json"];

// Matches `from "x"`, `import("x")`, `require("x")`, `export ... from "x"` and
// bare `import "x"` forms; group 3 is the specifier. Only relative specifiers
// (leading dot) are considered.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])(\.[^"']*)\2/gm;

const EXIT = {
  UNEXPECTED: 1,
  USAGE: 2,
  OUTSIDE_ROOT: 3,
  INVALID_MOVE: 4,
  VERIFY: 5,
  UNSUPPORTED: 6,
};

/** Thrown failures carry their documented exit code. */
function fail(code, message) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

// macOS/Windows filesystems are case-insensitive, so importers may spell a path
// differently from the on-disk name. Compare case-insensitively there.
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
const normalize = (path) => (caseInsensitive ? path.toLowerCase() : path);
const same = (a, b) => normalize(a) === normalize(b);
const inside = (path, base) => path === base || path.startsWith(`${base}${sep}`);
const rel = (root, path) => relative(root, path).split(sep).join("/");

/** Split `"./x.ts?raw"` into its path part and its `?query`/`#hash` suffix. */
function splitSuffix(spec) {
  const clean = spec.replace(/[?#].*$/, "");
  return { clean, suffix: spec.slice(clean.length) };
}

/** True when the written specifier carries a file extension. */
function hasExtension(clean) {
  return /\.[A-Za-z0-9]+$/.test(basename(clean));
}

/** All on-disk candidates a relative specifier may resolve to (bundler order). */
function resolveCandidates(importerDir, clean) {
  const base = resolve(importerDir, clean);
  return [
    base,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
}

/**
 * Resolve a relative specifier to a concrete file on disk, mirroring the
 * bundler's rules (exact path, then known extensions, then `index.*`).
 * Returns null when nothing exists (e.g. virtual modules).
 */
function resolveOnDisk(importerDir, clean) {
  for (const candidate of resolveCandidates(importerDir, clean)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** True when a specifier written from `importerDir` points at `target` even
 *  after `target` has been moved away (used by the idempotent re-run). */
function lexicallyTargets(target, importerDir, clean) {
  return resolveCandidates(importerDir, clean).some((candidate) => same(candidate, target));
}

/** Build the specifier that points from `importerDir` at `target`. */
function specifierFor(importerDir, target, clean) {
  const extensionless = !hasExtension(clean);
  const explicitIndex = clean.endsWith("/index");
  let next = relative(importerDir, target).split(sep).join("/");
  if (extensionless) {
    next = next.replace(/\.(d\.ts|ts|tsx|vue|mjs|mts|js|json)$/, "");
    // Mirror the original style: `./tree` stays a directory specifier while
    // `./tree/index` keeps its explicit `index` segment.
    if (!explicitIndex && /^index\./.test(basename(target)) && next.endsWith("/index")) {
      next = next.slice(0, -"/index".length);
    }
  }
  if (next === "" || next === ".") return ".";
  if (!next.startsWith(".")) next = `./${next}`;
  return next;
}

/**
 * Rewrite the specifiers of one file.
 * `fromDir` is the directory the existing specifiers resolve against, `toDir`
 * the directory the rewritten specifiers must resolve against (they differ only
 * for the file being moved). `mapTarget` receives the absolute file a specifier
 * currently resolves to and returns the absolute file it must resolve to
 * afterwards, or null to keep the specifier as is.
 */
function rewrite(source, fromDir, toDir, mapTarget, resolveTarget) {
  const edits = [];
  const nextSource = source.replace(SPECIFIER, (match, prefix, quote, spec) => {
    const { clean, suffix } = splitSuffix(spec);
    const target = resolveTarget(fromDir, clean);
    if (!target) return match;
    const mapped = mapTarget(target);
    if (!mapped) return match;
    const next = `${specifierFor(toDir, mapped, clean)}${suffix}`;
    if (next === spec) return match;
    edits.push({ spec, next });
    return `${prefix}${quote}${next}${quote}`;
  });
  return { source: nextSource, edits };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) walk(path, out);
    else if (FRONTEND_GLOB.test(name)) out.push(path);
  }
  return out;
}

/** `git mv` leaves the old directory behind; drop it when nothing else is in it. */
function pruneEmptyDirs(dir, stopAt) {
  let current = dir;
  while (current !== stopAt && inside(current, stopAt) && existsSync(current)) {
    if (readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

function isGitTracked(root, relativePath) {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", relativePath], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function moveFile(root, from, to) {
  const relativeFrom = rel(root, from);
  const relativeTo = rel(root, to);
  if (isGitTracked(root, relativeFrom)) {
    execFileSync("git", ["-C", root, "mv", relativeFrom, relativeTo], { stdio: "inherit" });
  } else {
    // Same-filesystem rename; fixture tests and untracked scratch files take
    // this path.
    renameSync(from, to);
  }
}

function parseArgs(argv) {
  let dryRun = false;
  let root = DEFAULT_ROOT;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) fail(EXIT.USAGE, "--root requires a directory");
      root = resolve(process.cwd(), value);
      i += 1;
    } else if (arg.startsWith("--root=")) {
      root = resolve(process.cwd(), arg.slice("--root=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/refactor/move-file.mjs [--dry-run] [--root <dir>] <from> <to>",
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      fail(EXIT.USAGE, `unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    fail(EXIT.USAGE, "usage: node scripts/refactor/move-file.mjs [--dry-run] [--root <dir>] <from> <to>");
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(EXIT.OUTSIDE_ROOT, `root is not a directory: ${root}`);
  }
  return { dryRun, root, fromArg: positional[0], toArg: positional[1] };
}

/** Validate the requested move and return the absolute endpoints. */
function resolveEndpoints(root, fromArg, toArg) {
  const frontendSrc = join(root, "frontend", "src");
  const backendSrc = join(root, "backend", "src");
  const from = resolve(root, fromArg);
  const to = resolve(root, toArg);

  for (const path of [from, to]) {
    if (inside(path, backendSrc)) {
      fail(
        EXIT.UNSUPPORTED,
        `backend/src is not supported: Rust module paths (mod/#[path]/super::) cannot be rewritten safely. ` +
          `Keep backend/src/ssh.rs as the module root and add ssh/*.rs children instead (see docs/IMPL_PLAN_SSH_SPLIT.zh-CN.md).`,
      );
    }
    if (!inside(path, frontendSrc)) {
      fail(EXIT.OUTSIDE_ROOT, `path must be inside frontend/src: ${path}`);
    }
  }
  if (!FRONTEND_GLOB.test(from)) {
    fail(EXIT.UNSUPPORTED, `only .ts/.tsx/.vue/.js/.mjs/.mts files are supported: ${from}`);
  }
  if (same(from, to)) fail(EXIT.INVALID_MOVE, "source and target are the same path");
  if (existsSync(from)) {
    const info = lstatSync(from);
    if (info.isSymbolicLink()) fail(EXIT.INVALID_MOVE, `refusing to move a symlink: ${from}`);
    if (!info.isFile()) fail(EXIT.INVALID_MOVE, `source is not a file: ${from}`);
  }
  if (existsSync(to) && !statSync(to).isFile()) {
    fail(EXIT.INVALID_MOVE, `target exists and is not a file: ${to}`);
  }
  return { frontendSrc, from, to };
}

/** Collect the moved file's own re-based imports. */
function planMovedFile(from, to) {
  return rewrite(
    readFileSync(from, "utf8"),
    dirname(from),
    dirname(to),
    (target) => (same(target, from) ? to : target),
    (importerDir, clean) => {
      const lexical = resolve(importerDir, clean);
      if (same(lexical, from)) return from;
      return resolveOnDisk(importerDir, clean) ?? lexical;
    },
  );
}

/** Collect importer rewrites before the move (old paths still resolve). */
function planImporters(frontendSrc, from, to) {
  const importers = [];
  for (const file of walk(frontendSrc)) {
    if (same(file, from)) continue;
    const before = readFileSync(file, "utf8");
    const after = rewrite(
      before,
      dirname(file),
      dirname(file),
      (target) => (same(target, from) ? to : null),
      resolveOnDisk,
    );
    if (after.source !== before) importers.push({ path: file, source: after.source, edits: after.edits });
  }
  return importers;
}

/**
 * Repair a previous partial run: source gone, target present. The moved file's
 * own specifiers are already final (it was written right after the rename), so
 * only importers still spelling the old path need fixing; re-basing the moved
 * file again here would shift its relative imports twice.
 */
function planRerun(frontendSrc, from, to) {
  const importers = [];
  for (const file of walk(frontendSrc)) {
    if (same(file, to)) continue;
    const before = readFileSync(file, "utf8");
    const after = rewrite(
      before,
      dirname(file),
      dirname(file),
      (target) => (same(target, from) ? to : null),
      (importerDir, clean) => (lexicallyTargets(from, importerDir, clean) ? from : null),
    );
    if (after.source !== before) importers.push({ path: file, source: after.source, edits: after.edits });
  }
  return importers;
}

function printPlan(root, from, to, moved, importers, prefix) {
  console.log(`${prefix} MOVE ${rel(root, from)} -> ${rel(root, to)}`);
  for (const edit of moved.edits) {
    console.log(`${prefix} REWRITE ${rel(root, to)}: "${edit.spec}" -> "${edit.next}"`);
  }
  for (const importer of importers) {
    for (const edit of importer.edits) {
      console.log(`${prefix} REWRITE ${rel(root, importer.path)}: "${edit.spec}" -> "${edit.next}"`);
    }
  }
}

/** After the move no relative specifier may still resolve at the old path. */
function verify(frontendSrc, from, to) {
  if (!existsSync(to) || !statSync(to).isFile()) {
    fail(EXIT.VERIFY, `moved file is missing after move: ${to}`);
  }
  if (existsSync(from)) {
    fail(EXIT.VERIFY, `old path still exists after move: ${from}`);
  }
  for (const file of walk(frontendSrc)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(new RegExp(SPECIFIER.source, "gm"))) {
      const { clean } = splitSuffix(match[3]);
      if (lexicallyTargets(from, dirname(file), clean)) {
        fail(EXIT.VERIFY, `stale import of ${from} left in ${file}`);
      }
    }
  }
}

function main() {
  const { dryRun, root, fromArg, toArg } = parseArgs(process.argv.slice(2));
  const { frontendSrc, from, to } = resolveEndpoints(root, fromArg, toArg);
  const sourceExists = existsSync(from);
  const targetExists = existsSync(to);

  if (!sourceExists && targetExists) {
    if (!statSync(to).isFile()) fail(EXIT.INVALID_MOVE, `target is not a file: ${to}`);
    const importers = planRerun(frontendSrc, from, to);
    const specifiers = importers.reduce((sum, file) => sum + file.edits.length, 0);
    if (dryRun) {
      printPlan(root, from, to, { edits: [] }, importers, "DRY-RUN");
      console.log(
        `DRY-RUN: already moved; ${specifiers} stale specifier(s) in ${importers.length} file(s) would be repaired; nothing written`,
      );
      return;
    }
    for (const importer of importers) writeFileSync(importer.path, importer.source);
    verify(frontendSrc, from, to);
    console.log(
      `already moved: ${rel(root, from)} -> ${rel(root, to)}; repaired ${specifiers} specifier(s) in ${importers.length} file(s)`,
    );
    return;
  }

  if (!sourceExists) fail(EXIT.INVALID_MOVE, `missing file: ${from}`);
  if (targetExists) fail(EXIT.INVALID_MOVE, `target already exists: ${to}`);

  const moved = planMovedFile(from, to);
  const importers = planImporters(frontendSrc, from, to);
  const specifiers = moved.edits.length + importers.reduce((sum, file) => sum + file.edits.length, 0);
  const changedFiles = importers.length + (moved.edits.length > 0 ? 1 : 0);

  if (dryRun) {
    printPlan(root, from, to, moved, importers, "DRY-RUN");
    console.log(
      `DRY-RUN: ${specifiers} specifier(s) in ${changedFiles} file(s) would change; nothing written`,
    );
    return;
  }

  mkdirSync(dirname(to), { recursive: true });
  moveFile(root, from, to);
  if (moved.edits.length > 0) writeFileSync(to, moved.source);
  for (const importer of importers) writeFileSync(importer.path, importer.source);
  pruneEmptyDirs(dirname(from), frontendSrc);
  verify(frontendSrc, from, to);
  printPlan(root, from, to, moved, importers, "");
  console.log(
    `moved ${rel(root, from)} -> ${rel(root, to)}; rewrote ${specifiers} specifier(s) in ${changedFiles} file(s)`,
  );
}

try {
  main();
} catch (error) {
  const code = Number.isInteger(error.exitCode) ? error.exitCode : EXIT.UNEXPECTED;
  console.error(`move-file: ${error.message}`);
  process.exit(code);
}
