// FIG 语料离线门禁（Lane C'，零联网）：
//   1. snapshot 双 pin 存在（specs + parser）；
//   2. LICENSE / NOTICE 齐全；
//   3. spec-manifest.generated.ts ↔ build/*.js ↔ snapshot.allowlist 三方一致；
//   4. manifest 全量可 import（离线加载每个 allowlisted spec 模块）；
//   5. vendored parser 产物 import 冒烟（嵌套子命令 / 选项 / `--` 状态机）；
//   6. 体积预算：manifest 总量与单 spec 上限；超限非零退出并按体积降序打印
//      裁剪建议序（决策 D2'：裁 allowlist，不引入 chunk）。
//
// 预算默认取 snapshot.budget（sync 按契约写入；单 spec 上限按首测调整为
// 500KB，见 docs/fig-specs-size-report.md），可用 CLI 覆写：
//   node scripts/verify_fig_specs.mjs [--max-total-bytes N] [--max-spec-bytes N]
//
// 本文件同时作为可导入模块暴露纯检查函数（frontend/src/lib/completion/fig/
// figCompletionSource.spec.ts 不直接覆盖本脚本；verify.spec.ts 走 --self-test
// 数据面单测）。

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const frontendDir = path.join(repoRoot, "frontend");
const specsVendorDir = path.join(frontendDir, "vendor", "fig-specs");
const engineFile = path.join(frontendDir, "vendor", "autocomplete-engine", "parser.js");
const parserVendorDir = path.join(frontendDir, "vendor", "amazon-q-autocomplete");
const npmVendorDir = path.join(frontendDir, "vendor", "fig-npm");

export const DEFAULT_TOTAL_BUDGET_BYTES = 5 * 1024 * 1024;
export const DEFAULT_SINGLE_BUDGET_BYTES = 500 * 1024;

const readJson = async (file) => JSON.parse(await fsp.readFile(file, "utf8"));

/** 递归列出 build/ 下全部相对路径（POSIX 分隔）。 */
export async function listBuildFiles(buildDir) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) out.push(path.relative(buildDir, p).split(path.sep).join("/"));
    }
  };
  await walk(buildDir);
  return out.sort();
}

/** 从生成的 manifest 源码提取静态 import 的 spec 名集合。 */
export function parseManifestImports(manifestSource) {
  const names = [];
  for (const m of manifestSource.matchAll(/from\s+"\.\.\/build\/(.+)\.js"|from\s+"\.\/build\/(.+)\.js"/g)) {
    names.push(m[1] ?? m[2]);
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** 单条一致性检查：manifest ↔ build 文件 ↔ snapshot.allowlist。 */
export function checkManifestConsistency({ manifestNames, buildFiles, snapshotAllowlist }) {
  const errors = [];
  const buildSet = new Set(buildFiles);
  const allowSet = new Set(snapshotAllowlist);
  for (const name of manifestNames) {
    if (!buildSet.has(`${name}.js`)) errors.push(`manifest 引用缺失产物: build/${name}.js`);
    if (!allowSet.has(name)) errors.push(`manifest 含 snapshot.allowlist 之外的 spec: ${name}`);
  }
  for (const file of buildFiles) {
    const name = file.replace(/\.js$/, "");
    if (!manifestNames.includes(name)) errors.push(`build 存在 manifest 未引用的产物: ${file}`);
  }
  for (const name of snapshotAllowlist) {
    if (!manifestNames.includes(name)) errors.push(`snapshot.allowlist 含 manifest 之外的 spec: ${name}`);
  }
  return errors;
}

/** 体积预算检查；超限返回 {errors, trimOrder}（裁剪建议序：体积降序）。 */
export function checkBudgets({ sizes, manifestNames, maxTotalBytes, maxSpecBytes }) {
  const errors = [];
  const entries = manifestNames
    .map((name) => ({ name, bytes: sizes[name] ?? -1 }))
    .filter((e) => e.bytes >= 0)
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  for (const e of entries) {
    if (e.bytes > maxSpecBytes) {
      errors.push(`单 spec 超限: ${e.name} ${(e.bytes / 1024).toFixed(1)}KB > ${(maxSpecBytes / 1024).toFixed(0)}KB`);
    }
  }
  if (total > maxTotalBytes) {
    errors.push(
      `语料总量超限: ${(total / 1024 / 1024).toFixed(2)}MB > ${(maxTotalBytes / 1024 / 1024).toFixed(2)}MB`,
    );
  }
  // 裁剪建议序：从最大开始逐个剔除，直到回到预算内（建议性质，供批次 2 决策）。
  const trimOrder = [];
  let simulated = total;
  for (const e of entries) {
    if (simulated <= maxTotalBytes && e.bytes <= maxSpecBytes) break;
    if (e.bytes > maxSpecBytes || simulated > maxTotalBytes) {
      trimOrder.push(e);
      simulated -= e.bytes;
    }
  }
  return { errors, total, trimOrder };
}

/** parser.js 冒烟：window shim + 内嵌 fixture spec 驱动上游状态机。 */
export async function smokeParserEngine(engineFileUrl) {
  // vendored caches.ts 在模块顶层向 window 注册调试钩子；Node 侧以全局 shim 满足。
  globalThis.window ??= globalThis;
  const engine = await import(engineFileUrl);
  const problems = [];
  const fixture = {
    name: ["verify-smoke"],
    subcommands: {
      status: {
        name: ["status"],
        options: {},
        persistentOptions: {},
        parserDirectives: {},
        args: [],
      },
    },
    options: {
      "--force": { name: ["--force"], description: "force it" },
      "-f": { name: ["-f"] },
    },
    persistentOptions: {
      "--verbose": { name: ["--verbose"] },
    },
    parserDirectives: {},
    args: [],
  };
  let state = engine.getInitialState(fixture, "verify-smoke", { name: "verify-smoke", type: "global" });
  state = engine.updateState(state, "status"); // 嵌套子命令
  if (state.completionObj?.name?.[0] !== "status") {
    problems.push(`嵌套子命令解析失败: ${JSON.stringify(state.completionObj?.name)}`);
  }
  // 末 token（空）按上游语义只标注不消费；无可消费 arg 时抛错 → 追加 None 标注。
  const nested = (() => {
    try {
      return engine.getResultFromState(engine.updateState(state, "", true));
    } catch {
      return engine.getResultFromState({
        ...state,
        annotations: [...state.annotations, { type: engine.TokenType.None, text: "" }],
      });
    }
  })();
  if (!(nested.suggestionFlags & engine.SuggestionFlag.Options)) {
    problems.push("嵌套子命令后未给出 options 建议");
  }
  if (!state.completionObj.persistentOptions?.["--verbose"]) {
    problems.push("持久选项未继承到子命令");
  }
  const root = engine.getInitialState(fixture, "verify-smoke", { name: "verify-smoke", type: "global" });
  const final = (() => {
    try {
      return engine.updateState(root, "", true);
    } catch {
      return {
        ...root,
        annotations: [...root.annotations, { type: engine.TokenType.None, text: "" }],
      };
    }
  })();
  const result = engine.getResultFromState(final);
  const hasOptions = (result.suggestionFlags & engine.SuggestionFlag.Options) !== 0;
  const hasSubcommands = (result.suggestionFlags & engine.SuggestionFlag.Subcommands) !== 0;
  if (!hasOptions || !hasSubcommands) {
    problems.push(`根位置建议标志异常: ${result.suggestionFlags}`);
  }
  if (result.searchTerm !== "") problems.push(`searchTerm 非空: ${JSON.stringify(result.searchTerm)}`);
  return { engine, problems };
}

const fileExists = async (p) => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : undefined;
  };
  const errors = [];
  const warnings = [];

  // 1) snapshot 双 pin
  const snapshotFile = path.join(specsVendorDir, "snapshot.json");
  if (!(await fileExists(snapshotFile))) {
    console.error("fig:verify: snapshot.json 缺失（先跑 fig:sync）");
    process.exit(1);
  }
  const snapshot = await readJson(snapshotFile);
  if (typeof snapshot.specs?.commit !== "string" || snapshot.specs.commit.length < 40) {
    errors.push("snapshot.specs.commit 缺失/非法");
  }
  if (typeof snapshot.parser?.commit !== "string" || snapshot.parser.commit.length < 40) {
    errors.push("snapshot.parser.commit 缺失/非法");
  }

  // 2) LICENSE / NOTICE
  for (const required of [
    path.join(specsVendorDir, "LICENSE"),
    path.join(specsVendorDir, "NOTICE.fig.txt"),
    path.join(parserVendorDir, "LICENSE-MIT"),
    path.join(parserVendorDir, "LICENSE-APACHE"),
    path.join(parserVendorDir, "NOTICE.fig.txt"),
  ]) {
    if (!(await fileExists(required))) errors.push(`缺少许可/声明文件: ${path.relative(repoRoot, required)}`);
  }
  for (const p of NPM_DIR_NAMES) {
    if (!(await fileExists(path.join(npmVendorDir, p, "package.json")))) {
      errors.push(`缺少 vendored npm 包: vendor/fig-npm/${p}`);
    }
  }

  // 3) manifest ↔ build ↔ allowlist
  const manifestFile = path.join(specsVendorDir, "spec-manifest.generated.ts");
  const buildDir = path.join(specsVendorDir, "build");
  if (!(await fileExists(manifestFile)) || !(await fs.existsSync(buildDir))) {
    console.error("fig:verify: manifest/build 缺失（先跑 fig:sync）");
    process.exit(1);
  }
  const manifestSource = await fsp.readFile(manifestFile, "utf8");
  const manifestNames = parseManifestImports(manifestSource);
  const buildFiles = await listBuildFiles(buildDir);
  const consistencyErrors = checkManifestConsistency({
    manifestNames,
    buildFiles,
    snapshotAllowlist: snapshot.allowlist ?? [],
  });
  errors.push(...consistencyErrors);

  // 4) 离线全量 import manifest（Node 原生 type-stripping 读生成 TS）
  const manifestUrl = pathToFileURL(manifestFile).href;
  const manifestModule = await import(manifestUrl);
  const loaded = Object.keys(manifestModule.manifest ?? {}).length;
  if (loaded !== manifestNames.length) {
    errors.push(`manifest 运行时键数 ${loaded} ≠ 静态 import 数 ${manifestNames.length}`);
  }

  // 5) parser 冒烟
  if (!(await fileExists(engineFile))) {
    errors.push(`parser 产物缺失: ${path.relative(repoRoot, engineFile)}`);
  } else {
    const { problems } = await smokeParserEngine(pathToFileURL(engineFile).href);
    errors.push(...problems.map((p) => `parser 冒烟: ${p}`));
  }

  // 6) 体积预算
  const maxTotalBytes = flag("--max-total-bytes") ?? snapshot.budget?.totalBytes ?? DEFAULT_TOTAL_BUDGET_BYTES;
  const maxSpecBytes = flag("--max-spec-bytes") ?? snapshot.budget?.singleSpecBytes ?? DEFAULT_SINGLE_BUDGET_BYTES;
  const budget = checkBudgets({
    sizes: snapshot.sizes ?? {},
    manifestNames,
    maxTotalBytes,
    maxSpecBytes,
  });
  errors.push(...budget.errors);

  const totalKb = (budget.total / 1024).toFixed(1);
  console.log(`fig:verify: specs=${manifestNames.length} buildFiles=${buildFiles.length} total=${totalKb}KB ` +
    `budget=${(maxTotalBytes / 1024 / 1024).toFixed(2)}MB/${(maxSpecBytes / 1024).toFixed(0)}KB`);

  if (budget.trimOrder.length > 0) {
    console.error("\n裁剪建议序（体积降序，直至回到预算内）:");
    for (const e of budget.trimOrder) {
      console.error(`  - ${e.name} (${(e.bytes / 1024).toFixed(1)}KB)`);
    }
  }
  if (warnings.length) for (const w of warnings) console.warn(`fig:verify: warn: ${w}`);
  if (errors.length) {
    console.error(`\nfig:verify: FAILED (${errors.length})`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log("fig:verify: OK");
};

const NPM_DIR_NAMES = ["autocomplete-shared", "autocomplete-generators", "autocomplete-helpers", "semver"];

/** vendored parser 产物的 file:// URL（供 vitest 单测复用；import.meta.url 在
 * vitest 中非文件协议，不能现场解析）。 */
export const PARSER_ENGINE_URL = pathToFileURL(engineFile).href;

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(scriptPath).href;
if (isMain) {
  main().catch((err) => {
    console.error(`fig:verify: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
