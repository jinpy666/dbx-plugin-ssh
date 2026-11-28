#!/usr/bin/env node
// 结构守卫白名单刷新工具（backend/src/structure_tests.rs 与 frontend/src/structure.spec.ts）。
//
// 背景：两个守卫各自维护一份「冻结白名单」，条目值 = 该文件当前行数。手工改数字
// 已经出错两次（合并后忘了收紧、删条目删错行），所以把「扫描真实文件树 → 生成
// 条目」这一步脚本化。默认 `--check` 只比对不改文件，`--write` 才落盘。
//
// 语义必须与守卫逐字一致（否则脚本会把守卫弄红）：
//
//   Rust 守卫（backend/src）
//     - 递归收集 `backend/src` 下所有扩展名为 `rs` 的文件（跟随目录符号链接）。
//     - 行数 = `str::lines().count()`：按 `\n` 切分、去掉结尾空段；空文件 0 行。
//     - 测试文件：basename 为 tests.rs / test.rs / test_support.rs，或
//       `*_tests.rs` / `*_test.rs`，或相对路径以 `tests/` 开头 / 含 `/tests/`。
//     - 路径相对 `backend/src`，`/` 分隔，无 `./` 前缀。
//     - 预算：生产 600、测试 1200（从守卫文件读取，本工具从不改写预算）。
//     - 条目格式：`("path", 1234),`，4 空格缩进。
//
//   TS 守卫（frontend/src）
//     - 等价于 `import.meta.glob("./**/*.{ts,vue}", { eager: true })`：
//       * 只收 `.ts` 与 `.vue`（大小写敏感，`.d.ts` 也算 `.ts`）；
//       * 默认 `dot: false` → 以 `.` 开头的文件和目录不参与匹配；
//       * Vite 固定 ignore `**/node_modules/**`；
//       * Vite 会把「发起 glob 的模块自身」从结果里过滤掉（`file !== id`），
//         即 structure.spec.ts 不计入自己的扫描结果。
//     - 行数 = `text.replace(/\n$/, "").split("\n").length`（空文件 1 行）。
//     - 规格文件：`*.spec.ts`、`*.test.ts`、路径含 `/testing/`。
//     - 键相对 `frontend/src`，`./` 前缀，`/` 分隔。
//     - 预算：生产 600、规格 1200（从守卫读取）。
//     - 条目格式：`"./path": 1234,`，2 空格缩进。
//     - DIRECTION_ALLOWLIST 不在本工具职责内：只报告，从不改写。
//
// 两份守卫的语义差异（脚本必须分别处理，不能共用一套规则）：
//   1. 空文件行数不同（Rust 0 / TS 1）；两者都远低于预算，实际不影响条目。
//   2. 文件筛选不同：Rust 收全部 `.rs`（含点文件、node_modules）；TS 排除点文件、
//      node_modules，并排除守卫自身。
//   3. 测试文件判定不同：Rust 认 `test.rs`/`test_support.rs`/`*_test.rs` 等文件名，
//      TS 只认 `.spec.ts`/`.test.ts` 后缀与 `/testing/` 目录。
//   4. 键格式不同：Rust 无前缀，TS 有 `./` 前缀；缩进 4 vs 2。
//
// 安全边界：
//   - 只写上述两个守卫文件，且只替换 LINE_ALLOWLIST 块内部的条目行；
//   - 不新增依赖（仅 node: 内置模块）；
//   - 从不改写 600/1200 预算；条目值只取「当前真实行数」，绝不留余量；
//   - 仍超预算的文件条目绝不删除；块内非条目注释随所属条目保留，无处可挂时
//     移动到块尾而不是删除。
//
// 用法：
//   node scripts/refresh_structure_allowlist.mjs            # 默认 --check
//   node scripts/refresh_structure_allowlist.mjs --check    # 漂移则 exit 1 并打印 diff
//   node scripts/refresh_structure_allowlist.mjs --write    # 原地刷新两个白名单块
//   node scripts/refresh_structure_allowlist.mjs --root DIR # 扫描指定仓库根（自测用）
//
// 退出码：0 = 已一致/写入成功；1 = --check 发现漂移；2 = 工具或文件错误。
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/* 行数语义：与守卫逐字对齐                                             */
/* ------------------------------------------------------------------ */

/** Rust `str::lines().count()`。空文件 0 行。 */
function countLinesRust(text) {
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** TS `text.replace(/\n$/, "").split("\n").length`。空文件 1 行。 */
function countLinesTs(text) {
  return text.replace(/\n$/, "").split("\n").length;
}

/* ------------------------------------------------------------------ */
/* 测试文件判定：与守卫逐字对齐                                         */
/* ------------------------------------------------------------------ */

/** 对齐 Rust `is_test_file`：文件名后缀或 `tests/` 目录。 */
function rustIsTestFile(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return (
    base === "tests.rs" ||
    base.endsWith("_tests.rs") ||
    base === "test.rs" ||
    base.endsWith("_test.rs") ||
    base === "test_support.rs" ||
    rel.startsWith("tests/") ||
    rel.includes("/tests/")
  );
}

/** 对齐 TS `isSpec`。 */
function tsIsSpec(key) {
  return (
    key.endsWith(".spec.ts") ||
    key.endsWith(".test.ts") ||
    key.includes("/testing/")
  );
}

/* ------------------------------------------------------------------ */
/* 目录扫描                                                            */
/* ------------------------------------------------------------------ */

function relativePosix(from, to) {
  return to.slice(from.length + 1).split(/[\\/]/).join("/");
}

/** Rust `collect_rs`：递归、跟随目录符号链接、扩展名严格为 `rs`。 */
function scanRust(srcDir) {
  const sources = new Map();
  const visited = new Set(); // 符号链接环保护（Rust 侧会无限递归）
  const walk = (dir) => {
    const real = realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path); // 跟随符号链接，对齐 `Path::is_dir`
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      // Rust `Path::extension`：`.rs` 这种点文件没有扩展名（点号不能在首位）。
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot + 1) : "";
      if (ext === "rs") {
        sources.set(relativePosix(srcDir, path), readFileSync(path, "utf8"));
      }
    }
  };
  walk(srcDir);
  return sources;
}

/** TS `import.meta.glob("./**\/*.{ts,vue}", { eager: true })` 的等价扫描。 */
function scanTs(srcDir, { guardAbs }) {
  const sources = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue; // Vite glob 默认 dot: false
      if (name === "node_modules") continue; // Vite 固定 ignore **/node_modules/**
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts") && !path.endsWith(".vue")) continue;
      if (resolve(path) === guardAbs) continue; // Vite 过滤发起 glob 的模块自身
      sources.set("./" + relativePosix(srcDir, path), readFileSync(path, "utf8"));
    }
  };
  walk(srcDir);
  return sources;
}

/* ------------------------------------------------------------------ */
/* 守卫描述                                                            */
/* ------------------------------------------------------------------ */

function escapeRustPath(path) {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const GUARDS = [
  {
    name: "rust",
    guardPath: "backend/src/structure_tests.rs",
    srcDir: "backend/src",
    sourceBudgetName: "MAX_SOURCE_LINES",
    testBudgetName: "MAX_TEST_LINES",
    defaultIndent: "    ",
    open: "const LINE_ALLOWLIST: &[(&str, usize)] = &[\n",
    close: "];",
    parseEntry(line) {
      const match = /^(\s*)\("((?:[^"\\]|\\.)*)",\s*(\d+)\),\s*$/.exec(line);
      return match ? { indent: match[1], path: match[2], lines: Number(match[3]) } : null;
    },
    formatEntry(indent, path, lines) {
      return `${indent}("${escapeRustPath(path)}", ${lines}),`;
    },
    countLines: countLinesRust,
    isTestFile: rustIsTestFile,
    scan: (srcDir) => scanRust(srcDir),
  },
  {
    name: "ts",
    guardPath: "frontend/src/structure.spec.ts",
    srcDir: "frontend/src",
    sourceBudgetName: "MAX_SOURCE_LINES",
    testBudgetName: "MAX_SPEC_LINES",
    defaultIndent: "  ",
    open: "const LINE_ALLOWLIST: Record<string, number> = {\n",
    close: "};",
    parseEntry(line) {
      const match = /^(\s*)"((?:[^"\\]|\\.)*)":\s*(\d+),\s*$/.exec(line);
      return match ? { indent: match[1], path: match[2], lines: Number(match[3]) } : null;
    },
    formatEntry(indent, path, lines) {
      return `${indent}${JSON.stringify(path)}: ${lines},`;
    },
    countLines: countLinesTs,
    isTestFile: tsIsSpec,
    scan: (srcDir, context) => scanTs(srcDir, context),
  },
];

/* ------------------------------------------------------------------ */
/* 解析守卫文件                                                        */
/* ------------------------------------------------------------------ */

function extractBlock(text, guard) {
  const start = text.indexOf(guard.open);
  if (start < 0) {
    throw new Error(`${guard.guardPath}: 找不到 LINE_ALLOWLIST 块起始标记`);
  }
  const bodyStart = start + guard.open.length;
  // 结束标记按「行首 token」定位：空白名单块（`&[\n];`）也能解析。
  let closeStart = text.indexOf(`\n${guard.close}`, bodyStart);
  closeStart = closeStart < 0 ? -1 : closeStart + 1;
  if (closeStart < 0 && text.startsWith(guard.close, bodyStart)) {
    closeStart = bodyStart;
  }
  if (closeStart < 0) {
    throw new Error(`${guard.guardPath}: 找不到 LINE_ALLOWLIST 块结束标记`);
  }
  return {
    prefix: text.slice(0, bodyStart),
    body: text.slice(bodyStart, closeStart),
    suffix: text.slice(closeStart),
  };
}

function parseBudget(text, name) {
  const match = new RegExp(`const\\s+${name}\\b[^=]*=\\s*([0-9_]+)\\s*;`).exec(text);
  if (!match) throw new Error(`守卫文件缺少预算常量 ${name}`);
  return Number(match[1].replace(/_/g, ""));
}

function parseBody(body, guard) {
  const items = [];
  const trailing = [];
  let pending = [];
  for (const line of body.split("\n")) {
    const entry = guard.parseEntry(line);
    if (entry) {
      items.push({ ...entry, comments: pending });
      pending = [];
    } else {
      pending.push(line);
    }
  }
  trailing.push(...pending);

  // 与 BTreeMap / Record 一致：同路径重复条目后者生效（并会被报告）。
  const byPath = new Map();
  for (const item of items) byPath.set(item.path, item);
  return { items, byPath, trailing };
}

/** 解析 TS 守卫的 DIRECTION_ALLOWLIST（只读，用于报告）。 */
function parseDirection(text) {
  const match = /const DIRECTION_ALLOWLIST: string\[\] = \[([\s\S]*?)\];/.exec(text);
  if (!match) return null;
  const entries = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return { body: match[1], entries };
}

/* ------------------------------------------------------------------ */
/* 生成期望条目                                                        */
/* ------------------------------------------------------------------ */

/**
 * `<dir>/tests.rs`、`<dir>/test.rs` 与 `<dir>.rs` 视为一组：文件与其测试子模块
 * 相邻排列（现有约定：ssh.rs 后紧跟 ssh/tests.rs）。仅当兄弟条目同时存在时分组。
 */
function testSiblingParent(rel) {
  for (const suffix of ["/tests.rs", "/test.rs"]) {
    if (rel.endsWith(suffix)) return rel.slice(0, -suffix.length) + ".rs";
  }
  return null;
}

/** 行数降序；同组内父文件在前；同分按路径升序（当前守卫的既有约定）。 */
function sortEntries(items) {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const rank = new Map();
  for (const item of items) {
    const parent = testSiblingParent(item.path);
    const grouped = parent !== null && parent !== item.path && byPath.has(parent);
    const key = grouped ? parent : item.path;
    rank.set(item.path, {
      keyLines: byPath.get(key).lines,
      key,
      member: grouped,
    });
  }
  return items.slice().sort((left, right) => {
    const a = rank.get(left.path);
    const b = rank.get(right.path);
    if (a.keyLines !== b.keyLines) return b.keyLines - a.keyLines;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.member !== b.member) return a.member ? 1 : -1;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ */
/* 计划：扫描 + 生成新块 + 与现状比对                                   */
/* ------------------------------------------------------------------ */

function planGuard(guard, root) {
  const guardAbs = join(root, guard.guardPath);
  let text;
  try {
    text = readFileSync(guardAbs, "utf8");
  } catch {
    throw new Error(`无法读取守卫文件 ${guard.guardPath}`);
  }
  const { prefix, body, suffix } = extractBlock(text, guard);
  const budgets = {
    source: parseBudget(text, guard.sourceBudgetName),
    test: parseBudget(text, guard.testBudgetName),
  };
  const parsed = parseBody(body, guard);
  const sources = guard.scan(join(root, guard.srcDir), { guardAbs });

  const expected = [];
  for (const [path, source] of sources) {
    const budget = guard.isTestFile(path) ? budgets.test : budgets.source;
    const lines = guard.countLines(source);
    if (lines > budget) expected.push({ path, lines });
  }

  const stale = [];
  const dead = [];
  const invalid = [];
  const seenStale = new Set();
  for (const item of parsed.items) {
    const budget = guard.isTestFile(item.path) ? budgets.test : budgets.source;
    if (item.lines <= budget && !invalid.some((entry) => entry.path === item.path)) {
      invalid.push({ path: item.path, allowed: item.lines, budget });
    }
    const source = sources.get(item.path);
    if (source === undefined) {
      if (!dead.includes(item.path)) dead.push(item.path);
      continue;
    }
    const lines = guard.countLines(source);
    if (lines <= budget && !seenStale.has(item.path)) {
      seenStale.add(item.path);
      stale.push({ path: item.path, lines, budget, allowed: item.lines });
    }
  }
  const duplicates = parsed.items.length - parsed.byPath.size;

  const ordered = sortEntries(expected);
  const keep = new Set(expected.map((item) => item.path));
  const renderedLines = [];
  for (const item of ordered) {
    const previous = parsed.byPath.get(item.path);
    const comments = previous ? previous.comments : [];
    const indent = previous && previous.indent ? previous.indent : guard.defaultIndent;
    renderedLines.push(...comments);
    renderedLines.push(guard.formatEntry(indent, item.path, item.lines));
  }

  // 被删除条目上方的注释不能丢：移动到块尾（并报告）。
  const orphanedComments = [];
  for (const item of parsed.items) {
    if (!keep.has(item.path) && item.comments.length > 0) {
      orphanedComments.push({ path: item.path, comments: item.comments });
    }
  }
  for (const orphan of orphanedComments) renderedLines.push(...orphan.comments);
  // 块内尾部注释/空行原样保留（包括空白名单块 split 出的那个空串）。
  renderedLines.push(...parsed.trailing);

  const expectedMap = new Map(expected.map((item) => [item.path, item.lines]));
  const updated = [];
  for (const [path, lines] of expectedMap) {
    const previous = parsed.byPath.get(path);
    if (previous && previous.lines !== lines) {
      updated.push({ path, from: previous.lines, to: lines });
    }
  }
  const added = [...expectedMap.keys()].filter((path) => !parsed.byPath.has(path));

  const newBody = renderedLines.join("\n");
  return {
    guard,
    guardAbs,
    prefix,
    body,
    suffix,
    newBody,
    budgets,
    sources,
    entries: expected.length,
    stale,
    dead,
    invalid,
    duplicates,
    added,
    updated,
    orphanedComments,
    dirty: newBody !== body || duplicates > 0,
  };
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function diffLines(before, after) {
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push(`  ${before[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${before[i]}`);
      i += 1;
    } else {
      out.push(`+ ${after[j]}`);
      j += 1;
    }
  }
  while (i < n) out.push(`- ${before[i++]}`);
  while (j < m) out.push(`+ ${after[j++]}`);
  return out;
}

/** 折叠连续未变化行：保留改动点前后各 2 行上下文。 */
function compactDiff(lines, context = 2) {
  const out = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith("  ")) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    let end = index;
    while (end < lines.length && lines[end].startsWith("  ")) end += 1;
    const run = end - start;
    const head = start === 0 ? 0 : context;
    const tail = end === lines.length ? 0 : context;
    if (run <= head + tail + 1) {
      out.push(...lines.slice(start, end));
    } else {
      out.push(...lines.slice(start, start + head));
      out.push(`  ... ${run - head - tail} unchanged line(s) omitted ...`);
      out.push(...lines.slice(end - tail, end));
    }
    index = end;
  }
  return out;
}

function reportReasons(plan) {
  const lines = [];
  for (const entry of plan.stale) {
    lines.push(`  stale (文件已回到预算内，删除条目): ${entry.path} ${entry.lines} <= ${entry.budget}（允许 ${entry.allowed}）`);
  }
  for (const path of plan.dead) {
    lines.push(`  dead (文件不存在，删除条目): ${path}`);
  }
  for (const entry of plan.invalid) {
    lines.push(`  invalid (白名单值必须大于预算): ${entry.path} ${entry.allowed} <= ${entry.budget}`);
  }
  if (plan.duplicates > 0) {
    lines.push(`  duplicate entry lines: ${plan.duplicates}`);
  }
  for (const change of plan.updated) {
    lines.push(`  updated: ${change.path} ${change.from} -> ${change.to}`);
  }
  for (const path of plan.added) {
    lines.push(`  added: ${path}`);
  }
  for (const orphan of plan.orphanedComments) {
    lines.push(`  comments above dropped entry preserved at end of block: ${orphan.path}`);
  }
  return lines;
}

function reportDirection(root, beforeText) {
  const path = join(root, "frontend/src/structure.spec.ts");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const direction = parseDirection(text);
  if (!direction) return { missing: true };
  const before = beforeText === undefined ? null : parseDirection(beforeText);
  return {
    entries: direction.entries,
    unchanged: before === null ? undefined : before.body === direction.body,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function printHelp() {
  process.stdout.write(
    [
      "结构白名单刷新工具（不新增依赖，只依赖 node: 内置模块）。",
      "",
      "用法: node scripts/refresh_structure_allowlist.mjs [--check|--write] [--root DIR]",
      "",
      "  --check   默认模式：两个白名单与真实文件树一致则 exit 0，否则打印 diff 并 exit 1。",
      "  --write   原地重写两个 LINE_ALLOWLIST 块（保留条目顺序约定与块内注释）。",
      "  --root   指定仓库根目录（自测 fixture 用，默认脚本上一级目录）。",
      "  -h,--help 显示本帮助。",
      "",
      "语义与守卫一致：生产 600 行 / 测试与规格 1200 行；条目值 = 当前真实行数，",
      "不留余量；仍超预算的文件条目绝不删除；预算常量从不改写。",
      "DIRECTION_ALLOWLIST 只报告，不改写。",
      "",
      "退出码: 0 一致或写入成功；1 --check 发现漂移；2 工具/文件错误。",
      "",
    ].join("\n"),
  );
}

function main(argv) {
  let mode = "check";
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") mode = "check";
    else if (arg === "--write") mode = "write";
    else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root 需要目录参数");
      root = resolve(value);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      return 0;
    } else {
      process.stderr.write(`未知参数: ${arg}\n\n`);
      printHelp();
      return 2;
    }
  }

  const tsGuardAbs = join(root, "frontend/src/structure.spec.ts");
  let directionBefore = null;
  try {
    directionBefore = readFileSync(tsGuardAbs, "utf8");
  } catch {
    directionBefore = null;
  }

  const plans = [];
  for (const guard of GUARDS) {
    const plan = planGuard(guard, root);
    plans.push(plan);
    if (mode === "check") {
      if (plan.dirty) {
        process.stdout.write(`[${guard.name}] ${guard.guardPath}: DRIFT\n`);
        for (const line of reportReasons(plan)) process.stdout.write(`${line}\n`);
        process.stdout.write("  diff (old -> new):\n");
        const before = plan.body === "" ? [] : plan.body.split("\n");
        const after = plan.newBody === "" ? [] : plan.newBody.split("\n");
        for (const line of compactDiff(diffLines(before, after))) {
          process.stdout.write(`    ${line}\n`);
        }
      } else {
        process.stdout.write(
          `[${guard.name}] ${guard.guardPath}: ok（${plan.entries} 条，预算 ${plan.budgets.source}/${plan.budgets.test}）\n`,
        );
      }
    } else {
      const reasons = reportReasons(plan);
      if (plan.dirty) {
        writeFileSync(plan.guardAbs, plan.prefix + plan.newBody + plan.suffix, "utf8");
        process.stdout.write(`[${guard.name}] ${guard.guardPath}: updated（${plan.entries} 条）\n`);
        for (const line of reasons) process.stdout.write(`${line}\n`);
      } else {
        process.stdout.write(`[${guard.name}] ${guard.guardPath}: unchanged（${plan.entries} 条）\n`);
        for (const line of reasons) process.stdout.write(`${line}\n`);
      }
    }
  }

  const direction = reportDirection(root, mode === "write" ? directionBefore : undefined);
  if (direction) {
    if (direction.missing) {
      process.stdout.write("DIRECTION_ALLOWLIST: 未找到（未改动）\n");
    } else {
      const suffix =
        direction.unchanged === undefined
          ? ""
          : direction.unchanged
            ? "，未被本工具改动"
            : "，注意：内容发生变化";
      process.stdout.write(
        `DIRECTION_ALLOWLIST: ${direction.entries.length} 条${suffix}: ${direction.entries.join(", ")}\n`,
      );
    }
  }

  if (mode === "check") {
    const dirty = plans.filter((plan) => plan.dirty);
    if (dirty.length > 0) {
      process.stdout.write(
        `structure allowlist check: ${dirty.length} 个守卫需要刷新 -> 使用 --write\n`,
      );
      return 1;
    }
    process.stdout.write("structure allowlist check: 两个白名单均与文件树一致\n");
    return 0;
  }
  process.stdout.write("structure allowlist write: 完成\n");
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
