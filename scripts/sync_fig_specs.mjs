#!/usr/bin/env node
// FIG 语料/parser 快照同步（Lane C'）。**本仓库唯一联网点**：
//   1. clone/fetch 并 pin 两个上游：
//      - withfig/autocomplete          —— spec 语料（全量 src/，~1500 文件）
//      - aws/amazon-q-developer-cli    —— autocomplete TypeScript parser 子树
//   2. parser 子树 vendored 到 frontend/vendor/amazon-q-autocomplete/packages/，
//      配合 frontend/vendor/amazon-q-autocomplete/facades/（手工隔离层，本脚本
//      不覆盖）经 vite JS API（rolldown，零新增依赖）打出
//      frontend/vendor/autocomplete-engine/parser.js（单文件 browser-safe ESM）。
//   3. 语料逐 spec 编译为 ESM（允许含函数：generator 声明/自定义代码保留），
//      依预算（默认总量 5MB / 单 spec 500KB，env 可覆写）生成确定性 allowlist，
//      写 frontend/vendor/fig-specs/{build/,spec-manifest.generated.ts,snapshot.json}。
//   4. 打印全量体积表（降序）与 skipped 清单。
//
// 幂等：同 pin 二次运行 diff 为空（generatedAt 取 parser pin 的提交时间，
// 非运行时刻）。上游 pin 变更 = 新快照，须人工评审 vendored diff。
//
// 用法：pnpm --dir frontend fig:sync   （或 node scripts/sync_fig_specs.mjs）

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// pins（快照契约；变更即新快照，走人工评审）
// ---------------------------------------------------------------------------

const SPEC_REPO = "https://github.com/withfig/autocomplete.git";
const SPEC_COMMIT = "aef52acff84c45edde61ae610cc2c964802b9a38"; // 2025-05-05, src/ 布局, MIT
const SPEC_SRC_DIR = "src";

const PARSER_REPO = "https://github.com/aws/amazon-q-developer-cli.git";
// 上游 09aa3cbad570f8fa89ce72c617721557fba4243e（"chore: remove autocomplete
// #2224", 2025-07-03）删除了整个 TS 引擎；此 pin 为删除前最后一个包含子树的
// commit，即引擎最终状态。
const PARSER_COMMIT = "5c621df6fd3112eb44da02132cde06cad25cb418";
const PARSER_REMOVED_IN = "09aa3cbad570f8fa89ce72c617721557fba4243e";
const PARSER_PACKAGES = ["autocomplete-parser", "shell-parser", "shared"];

// vendored npm 依赖（parser/语料编译闭包，MIT；parser 包 package.json 约束版本）
const NPM_PACKAGES = [
  { name: "@fig/autocomplete-shared", version: "1.1.2", keepDirs: ["dist"], entry: "dist/esm/index.js" },
  { name: "@fig/autocomplete-generators", version: "2.4.0", keepDirs: ["lib"], entry: "lib/index.js" },
  { name: "@fig/autocomplete-helpers", version: "2.0.0", keepDirs: ["dist"], entry: "dist/index.js" },
  { name: "semver", version: "7.7.2", keepDirs: ["classes", "functions", "internal", "ranges"], entry: "index.js", keepRootFiles: ["index.js", "package.json"] },
];

// 体积预算（默认值；可用环境变量覆写）。5MB 为契约初值，单 spec 上限按首测
// 调整为 500KB（git spec bundled ~400KB，300KB 会把最常用命令裁掉——写进
// docs/fig-specs-size-report.md）。
const DEFAULT_TOTAL_BUDGET_BYTES = 5 * 1024 * 1024;
const DEFAULT_SINGLE_BUDGET_BYTES = 500 * 1024;
const TOTAL_BUDGET_BYTES = Number(process.env.FIG_SPEC_BUDGET_TOTAL_BYTES ?? DEFAULT_TOTAL_BUDGET_BYTES);
const SINGLE_BUDGET_BYTES = Number(process.env.FIG_SPEC_BUDGET_SINGLE_BYTES ?? DEFAULT_SINGLE_BUDGET_BYTES);

const SPEC_COMPILE_CONCURRENCY = 6;

const NOTICE_TEXT = `NOTICE — Fig / Amazon Q autocomplete engine & specifications
=============================================================

This product incorporates, in vendored form:

1. The Fig autocomplete specification corpus ("specs")
   from https://github.com/withfig/autocomplete
   (commit ${SPEC_COMMIT}), licensed under the MIT License
   (Copyright (c) 2021 Hercules Labs Inc. (Fig)). See frontend/vendor/fig-specs/LICENSE.

2. The Fig autocomplete TypeScript parser engine
   from https://github.com/aws/amazon-q-developer-cli
   (packages/autocomplete-parser, packages/shell-parser, packages/shared at
   commit ${PARSER_COMMIT}; the subtree was removed upstream in
   ${PARSER_REMOVED_IN}), licensed under MIT OR Apache-2.0.
   See frontend/vendor/amazon-q-autocomplete/LICENSE-MIT and LICENSE-APACHE.

3. npm packages "@fig/autocomplete-shared" 1.1.2,
   "@fig/autocomplete-generators" 2.4.0, "@fig/autocomplete-helpers" 2.0.0
   and "semver" 7.7.2, vendored under frontend/vendor/fig-npm/ (MIT).

Completion specifications are derived from the public Fig/Amazon Q
autocomplete ecosystem and are not part of the dbx-plugin-ssh original
specification set.

Vendoring-time modifications (semantics preserved, mechanical only):
- packages/autocomplete-parser/src/parseArguments.ts: added the "export"
  keyword to the existing module-local functions updateState and
  getInitialState so the synchronous driver in
  frontend/src/lib/completion/fig/figCompletionSource.ts can drive the
  upstream state machine without the async filesystem/CDN spec loader that
  upstream's parseArguments() entry point requires.
- All other upstream files are byte-identical to the pinned commits.

Host-coupled surfaces (fs/CDN spec loading, desktop settings, shell
execution) are replaced by isolation facades in
frontend/vendor/amazon-q-autocomplete/facades/ — see that directory's
README for the full mapping. Generator execution is disabled in wave 1
(declared generator positions resolve to null / pass-through);
wave 2 routes them through the sidecar RPC completion/execute.
`;

// ---------------------------------------------------------------------------
// 环境与路径
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(repoRoot, "frontend");
const vendorDir = path.join(frontendDir, "vendor");
const parserVendorDir = path.join(vendorDir, "amazon-q-autocomplete");
const engineDir = path.join(vendorDir, "autocomplete-engine");
const npmVendorDir = path.join(vendorDir, "fig-npm");
const specsVendorDir = path.join(vendorDir, "fig-specs");
const tmpRoot = path.join(os.tmpdir(), "dbx-fig-sync");

const die = (msg) => {
  console.error(`fig:sync: ${msg}`);
  process.exit(1);
};

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  die(`Node >= 22.18 required (native type-stripping / 上游 TS 直接可用)，当前 ${process.versions.node}`);
}

const run = async (cmd, args, cwd) => {
  const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

/** clone（filter=blob:none）到 pin 专属缓存目录，幂等复用。 */
const ensureClone = async (repo, commit, name) => {
  const dir = path.join(tmpRoot, `${name}-${commit.slice(0, 12)}`);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    console.log(`fig:sync: clone ${repo} @ ${commit.slice(0, 12)} …`);
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", repo, dir]);
  }
  const head = (await run("git", ["rev-parse", "HEAD"], dir)).trim();
  if (head !== commit) {
    await run("git", ["fetch", "--filter=blob:none", "origin", commit], dir);
    await run("git", ["checkout", "--force", commit], dir);
  } else if (fs.readdirSync(dir).filter((e) => e !== ".git").length === 0) {
    await run("git", ["checkout", "--force", commit], dir);
  }
  return dir;
};

const rmrf = async (p) => {
  await fsp.rm(p, { recursive: true, force: true });
};

const copyDir = async (src, dest) => {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fsp.copyFile(s, d);
  }
};

const listTsFiles = async (root) => {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
    }
  };
  await walk(root);
  return out.sort();
};

// ---------------------------------------------------------------------------
// vite JS API（复用 frontend devDep，零新增依赖）
// ---------------------------------------------------------------------------

const loadVite = async () => {
  const require = (await import("node:module")).createRequire(path.join(frontendDir, "package.json"));
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve("vite/package.json");
  } catch {
    die("frontend 未安装 vite（先 pnpm --dir frontend install --prefer-offline）");
  }
  const pkg = JSON.parse(await fsp.readFile(pkgJsonPath, "utf8"));
  const dotExport = pkg.exports?.["."];
  const entry = typeof dotExport === "string" ? dotExport : (dotExport?.import ?? dotExport?.default ?? pkg.module ?? pkg.main);
  if (!entry) die("无法解析 vite 的 ESM 入口");
  return import(pathToFileURL(path.resolve(path.dirname(pkgJsonPath), entry)).href);
};

const viteAliasForNpm = (npmVendorRoot) =>
  NPM_PACKAGES.map((p) => ({
    find: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    replacement: path.join(npmVendorRoot, p.name.startsWith("@") ? p.name.split("/")[1] : p.name, p.entry),
  }));

// 语料里的第三方 bare import（yaml/typescript/strip-json-comments/node:test…）
// 一律显式跳过该 spec，而不是碰 frontend/node_modules——保证跳过原因稳定、
// 产物与沙箱依赖无关。
const noForeignBareImports = (allowed) => ({
  name: "fig-sync-no-foreign-bare-imports",
  resolveId(spec) {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("\0")) return null;
    if (allowed.has(spec)) return null;
    const rootPkg = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
    if (allowed.has(rootPkg)) return null;
    throw new Error(`external dependency not vendored: ${spec}`);
  },
});

const buildWithVite = async (vite, { entry, outDir, fileName, alias, plugins, minify = false }) => {
  await rmrf(outDir);
  await vite.build({
    configFile: false,
    logLevel: "error",
    root: repoRoot,
    resolve: { alias },
    plugins,
    build: {
      outDir,
      emptyOutDir: true,
      write: true,
      minify,
      target: "es2022",
      lib: { entry, formats: ["es"], fileName: () => fileName },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  return path.join(outDir, fileName);
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const main = async () => {
  const t0 = Date.now();
  const vite = await loadVite();
  await fsp.mkdir(tmpRoot, { recursive: true });

  // ---- 1. 双上游 pin -------------------------------------------------------
  const specCheckout = await ensureClone(SPEC_REPO, SPEC_COMMIT, "fig-autocomplete");
  const parserCheckout = await ensureClone(PARSER_REPO, PARSER_COMMIT, "amazon-q");
  const parserCommitDate = (await run("git", ["log", "-1", "--format=%cI", PARSER_COMMIT], parserCheckout)).trim();

  // ---- 2. parser 子树 vendored --------------------------------------------
  console.log("fig:sync: vendor parser subtree …");
  const packagesDest = path.join(parserVendorDir, "packages");
  await rmrf(packagesDest);
  for (const pkg of PARSER_PACKAGES) {
    const src = path.join(parserCheckout, "packages", pkg, "src");
    await copyDir(src, path.join(packagesDest, pkg, "src"));
  }
  // 对上游的两处机械修改：私有状态机入口改 export（语义零改动，NOTICE 已声明）。
  const parseArgumentsPath = path.join(packagesDest, "autocomplete-parser", "src", "parseArguments.ts");
  let parseArguments = await fsp.readFile(parseArgumentsPath, "utf8");
  for (const fnName of ["updateState", "getInitialState"]) {
    const re = new RegExp(`^(function ${fnName}\\(|const ${fnName} =)`, "m");
    if (!new RegExp(`^export (function ${fnName}\\(|const ${fnName} =)`, "m").test(parseArguments)) {
      if (!re.test(parseArguments)) die(`上游快照缺少预期符号 ${fnName}，vendored 补丁失效，须人工核对`);
      parseArguments = parseArguments.replace(re, `export $1`);
    }
  }
  await fsp.writeFile(parseArgumentsPath, parseArguments);

  await fsp.copyFile(path.join(parserCheckout, "LICENSE.MIT"), path.join(parserVendorDir, "LICENSE-MIT"));
  await fsp.copyFile(path.join(parserCheckout, "LICENSE.APACHE"), path.join(parserVendorDir, "LICENSE-APACHE"));
  await fsp.writeFile(path.join(specsVendorDir, "NOTICE.fig.txt"), NOTICE_TEXT);
  await fsp.copyFile(path.join(specsVendorDir, "NOTICE.fig.txt"), path.join(parserVendorDir, "NOTICE.fig.txt"));

  // ---- 3. npm 闭包 vendored ------------------------------------------------
  console.log("fig:sync: vendor npm closure …");
  await rmrf(npmVendorDir);
  for (const p of NPM_PACKAGES) {
    const dirName = p.name.startsWith("@") ? p.name.split("/")[1] : p.name;
    const dest = path.join(npmVendorDir, dirName);
    const tgz = path.join(tmpRoot, `${dirName}-${p.version}.tgz`);
    if (!fs.existsSync(tgz)) {
      const url = `https://registry.npmjs.org/${p.name.replace("/", "%2F")}/-/${dirName}-${p.version}.tgz`;
      const res = await fetch(url);
      if (!res.ok) die(`下载 ${p.name}@${p.version} 失败：HTTP ${res.status}`);
      await fsp.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
    }
    const extract = path.join(tmpRoot, `npm-${dirName}-${p.version}`);
    await rmrf(extract);
    await fsp.mkdir(extract, { recursive: true });
    await run("tar", ["-xzf", tgz, "-C", extract]);
    const pkgDir = path.join(extract, "package");
    await fsp.mkdir(dest, { recursive: true });
    await fsp.copyFile(path.join(pkgDir, "package.json"), path.join(dest, "package.json"));
    for (const keep of p.keepDirs) await copyDir(path.join(pkgDir, keep), path.join(dest, keep));
    for (const f of p.keepRootFiles ?? []) await fsp.copyFile(path.join(pkgDir, f), path.join(dest, f));
    const license = path.join(pkgDir, "LICENSE");
    if (fs.existsSync(license)) await fsp.copyFile(license, path.join(dest, "LICENSE"));
    // sourcemap 不入库（体积噪声）
    const stripMaps = async (dir) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const p2 = path.join(dir, e.name);
        if (e.isDirectory()) await stripMaps(p2);
        else if (e.name.endsWith(".map")) await fsp.rm(p2);
      }
    };
    await stripMaps(dest);
  }

  // ---- 4. parser 产物（单 ESM browser-safe） --------------------------------
  console.log("fig:sync: bundle parser.js …");
  await fsp.mkdir(engineDir, { recursive: true });
  const parserAlias = [
    { find: /^loglevel$/, replacement: path.join(parserVendorDir, "facades", "loglevel.ts") },
    { find: /^@aws\/amazon-q-developer-cli-api-bindings$/, replacement: path.join(parserVendorDir, "facades", "apiBindings.ts") },
    { find: /^@aws\/amazon-q-developer-cli-api-bindings-wrappers$/, replacement: path.join(parserVendorDir, "facades", "apiBindingsWrappers.ts") },
    { find: "./loadSpec.js", replacement: path.join(parserVendorDir, "facades", "loadSpecStub.ts") },
    { find: /^@aws\/amazon-q-developer-cli-shared$/, replacement: path.join(packagesDest, "shared", "src", "index.ts") },
    { find: /^@aws\/amazon-q-developer-cli-shared\/internal$/, replacement: path.join(packagesDest, "shared", "src", "internal.ts") },
    { find: /^@aws\/amazon-q-developer-cli-shared\/utils$/, replacement: path.join(packagesDest, "shared", "src", "utils.ts") },
    { find: /^@aws\/amazon-q-developer-cli-shared\/errors$/, replacement: path.join(packagesDest, "shared", "src", "errors.ts") },
    { find: /^@aws\/amazon-q-developer-cli-shell-parser$/, replacement: path.join(packagesDest, "shell-parser", "src", "index.ts") },
    ...viteAliasForNpm(npmVendorDir),
  ];
  const parserOut = await buildWithVite(vite, {
    entry: path.join(parserVendorDir, "facades", "parserEntry.ts"),
    outDir: path.join(tmpRoot, "engine-build"),
    fileName: "parser.js",
    alias: parserAlias,
    plugins: [noForeignBareImports(new Set(["@fig/autocomplete-shared", "@fig/autocomplete-generators"]))],
  });
  await fsp.copyFile(parserOut, path.join(engineDir, "parser.js"));

  // ---- 5. 语料逐 spec 编译 ---------------------------------------------------
  console.log("fig:sync: compile corpus …");
  const corpusSrc = path.join(specCheckout, SPEC_SRC_DIR);
  const files = await listTsFiles(corpusSrc);
  const candidates = [];
  for (const file of files) {
    const rel = path.relative(corpusSrc, file).slice(0, -3); // 去 .ts
    const name = rel.split(path.sep).join("/");
    const source = await fsp.readFile(file, "utf8");
    if (!/^export\s+default\b/m.test(source)) continue; // 纯 helper 模块（被依赖方内联）
    candidates.push({ name, file });
  }

  const compiled = [];
  const skipped = [];
  const specBuildRoot = path.join(tmpRoot, "spec-build");
  await rmrf(specBuildRoot);
  const figAlias = viteAliasForNpm(npmVendorDir);
  const allowedBare = new Set(NPM_PACKAGES.map((p) => p.name));

  let done = 0;
  const queue = [...candidates];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const { name, file } = item;
      const outDir = path.join(specBuildRoot, name);
      try {
        const outFile = await buildWithVite(vite, {
          entry: file,
          outDir,
          fileName: "spec.js",
          alias: figAlias,
          plugins: [noForeignBareImports(allowedBare)],
        });
        const bytes = fs.statSync(outFile).size;
        const mod = await import(pathToFileURL(outFile).href);
        const def = mod.default;
        if (typeof def !== "object" && typeof def !== "function") {
          throw new Error(`default export is ${typeof def}`);
        }
        compiled.push({ name, file: outFile, bytes });
      } catch (err) {
        const reason = String(err?.message ?? err)
          .replace(/\x1b\[[0-9;]*m/g, "")
          .split("\n")
          .slice(0, 3)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        skipped.push({ name, reason: reason || "unknown error" });
      }
      done += 1;
      if (done % 100 === 0) console.log(`fig:sync: ${done}/${candidates.length} specs compiled`);
    }
  };
  await Promise.all(Array.from({ length: SPEC_COMPILE_CONCURRENCY }, worker));

  // ---- 6. 预算 allowlist（确定性） ------------------------------------------
  // 优先级 1：parser 常量 MOST_USED_SPECS（从 vendored constants.ts 提取，保持
  // 单一来源）；优先级 2：体积升序贪心填充。均受预算/单 spec 上限约束。
  const constantsText = await fsp.readFile(
    path.join(packagesDest, "autocomplete-parser", "src", "constants.ts"),
    "utf8",
  );
  const constArrays = {};
  for (const m of constantsText.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]/g)) {
    constArrays[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }
  const mostUsedSpread = constantsText.match(/MOST_USED_SPECS\s*=\s*\[([^\]]*)\]/s)?.[1] ?? "";
  const mostUsed = [...mostUsedSpread.matchAll(/\.\.\.(\w+)/g)]
    .flatMap((m) => constArrays[m[1]] ?? []);

  const byName = new Map(compiled.map((c) => [c.name, c]));
  const allow = [];
  let total = 0;
  const consider = (c) => {
    if (!c || allow.includes(c)) return;
    if (c.bytes > SINGLE_BUDGET_BYTES) return;
    if (total + c.bytes > TOTAL_BUDGET_BYTES) return;
    allow.push(c);
    total += c.bytes;
  };
  for (const name of mostUsed) consider(byName.get(name));
  const rest = compiled
    .filter((c) => c.bytes <= SINGLE_BUDGET_BYTES)
    .sort((a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name));
  for (const c of rest) consider(c);
  const allowlist = allow.map((c) => c.name).sort((a, b) => a.localeCompare(b));

  // ---- 7. 落盘 vendor/fig-specs --------------------------------------------
  console.log(`fig:sync: allowlist ${allowlist.length}/${compiled.length} specs, ${(total / 1024 / 1024).toFixed(2)} MB …`);
  const buildDir = path.join(specsVendorDir, "build");
  await rmrf(buildDir);
  for (const name of allowlist) {
    const src = path.join(specBuildRoot, name, "spec.js");
    const dest = path.join(buildDir, `${name}.js`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
  await fsp.copyFile(path.join(specCheckout, "LICENSE"), path.join(specsVendorDir, "LICENSE"));

  const manifestBody = [
    "// @ts-nocheck — 由 scripts/sync_fig_specs.mjs 生成，勿手改（@ts-nocheck：build/*.js 无类型）。",
    "// 冻结形态：Readonly<Record<string, FigSpecRaw>> 静态 import map（fig/source.ts，决策 D2'）。",
    "// allowlist 语义见 snapshot.json（预算裁剪；全量体积表见 docs/fig-specs-size-report.md）。",
    "",
    ...allowlist.map((name) => {
      const id = "spec_" + name.replace(/[^A-Za-z0-9]+/g, "_");
      return `import ${id} from "./build/${name}.js";`;
    }),
    "",
    "export const manifest = {",
    ...allowlist.map((name) => {
      const id = "spec_" + name.replace(/[^A-Za-z0-9]+/g, "_");
      return `  ${JSON.stringify(name)}: ${id},`;
    }),
    "} as const;",
    "",
    "export const specNames: readonly string[] = [",
    ...allowlist.map((name) => `  ${JSON.stringify(name)},`),
    "];",
    "",
    "export default manifest;",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(specsVendorDir, "spec-manifest.generated.ts"), manifestBody);

  const sizes = {};
  // 并发编译完成顺序不定；按 name 排序写入，保证同 pin 幂等。
  for (const c of [...compiled].sort((a, b) => a.name.localeCompare(b.name))) sizes[c.name] = c.bytes;
  const snapshot = {
    specs: { repo: SPEC_REPO, commit: SPEC_COMMIT, path: SPEC_SRC_DIR },
    parser: {
      repo: PARSER_REPO,
      commit: PARSER_COMMIT,
      path: "packages/{autocomplete-parser,shell-parser,shared}",
      removedUpstreamIn: PARSER_REMOVED_IN,
    },
    npm: NPM_PACKAGES.map((p) => ({ name: p.name, version: p.version })),
    generatedAt: parserCommitDate,
    budget: {
      totalBytes: TOTAL_BUDGET_BYTES,
      singleSpecBytes: SINGLE_BUDGET_BYTES,
      source: "契约初值；单 spec 上限按首测调整（git ~400KB），见 docs/fig-specs-size-report.md",
    },
    allowlist,
    sizes,
    skipped: skipped.sort((a, b) => a.name.localeCompare(b.name)),
  };
  await fsp.writeFile(path.join(specsVendorDir, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");

  // ---- 8. 体积表 -------------------------------------------------------------
  const rows = [...compiled].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const allowSet = new Set(allowlist);
  console.log("\n== 体积表（全量编译产物，降序；✓=已入 manifest allowlist）==");
  for (const c of rows) {
    console.log(`${allowSet.has(c.name) ? "✓" : " "} ${(c.bytes / 1024).toFixed(1).padStart(9)} KB  ${c.name}`);
  }
  const totalAll = compiled.reduce((s, c) => s + c.bytes, 0);
  console.log(`\n全量编译合计 ${(totalAll / 1024 / 1024).toFixed(2)} MB / ${compiled.length} specs；` +
    `allowlist ${(total / 1024 / 1024).toFixed(2)} MB / ${allowlist.length} specs；skipped ${skipped.length}`);
  if (skipped.length) {
    console.log("\n== skipped ==");
    for (const s of skipped) console.log(`  ${s.name}: ${s.reason}`);
  }
  console.log(`\nfig:sync 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
};

main().catch((err) => die(err?.stack ?? String(err)));
