#!/usr/bin/env node
// fig spec snapshot 同步（Lane C，docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md §6）。
//
// 本脚本是整条 fig 管线的【唯一联网点】（roadmap 决策 D5）：clone/fetch
// withfig/autocomplete → node ≥22.18 原生 type-stripping import 上游
// `src/<name>.ts` → 共用 normalize.ts 归一化 → emit 纯数据模块到
// frontend/vendor/fig-specs/。除此之外仓库任何脚本/测试都不得联网。
//
// 幂等性：同 pin 二次运行产出逐字节相同（write-if-changed；snapshot.json 的
// generatedAt 在 pin 未变时沿用旧值），`git diff` 为空即通过。
//
// 用法（在 frontend/ 下）：
//   pnpm fig:sync                      # 用 snapshot.json 已记录 pin（首次为 main）
//   FIG_AUTOCOMPLETE_REF=<ref|sha> pnpm fig:sync   # 换 pin
//
// 上游个别 spec import 失败（非纯对象 / 带不可解析 import）→ 记入
// snapshot.json 的 skipped[] 并警告，不中断其余。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const vendorDir = path.resolve(repoRoot, "frontend/vendor/fig-specs");
const buildDir = path.join(vendorDir, "build");
const snapshotPath = path.join(vendorDir, "snapshot.json");
const tmpDir = path.resolve(repoRoot, ".tmp/fig-autocomplete");

const UPSTREAM_REPO = "https://github.com/withfig/autocomplete.git";
const UPSTREAM_SOURCE = "withfig/autocomplete";
const DEFAULT_REF = "master"; // withfig/autocomplete 的默认分支（HEAD symref 实测）
/** wave 1 allowlist（方案 §36 M3），顺序即 manifest 顺序，改动需走 lane 报告。 */
const ALLOWLIST = ["git", "docker", "kubectl", "helm", "npm", "pnpm", "yarn", "ssh", "aws", "cargo", "systemctl"];
const FORMAT_VERSION = 1;
/**
 * 上游 spec 依赖的 build-time npm 包（仅用于在 sync 时求值 generator 工厂，
 * 产物不 vendor 该包代码——所有 custom/模板 generator 都被归一化丢弃）。
 * key = 包名；tarball URL 由「上游 package.json 依赖版本」拼出。
 */
const VENDOR_DEP = "@fig/autocomplete-generators";

// ---------------------------------------------------------------------------
// node 版本门禁：type-stripping import 上游 .ts 需要 ≥22.18（不满足硬失败，
// 不静默降级——契约要求）
// ---------------------------------------------------------------------------

function requireNode22_18() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    console.error(`fig:sync 需要 node >= 22.18（原生 type-stripping import .ts），当前 ${process.versions.node}。`);
    console.error("请切换 node（本仓库开发环境经 nvm 固定 v22.21.0）。");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 纯数据断言（§6.6）：树中无函数值；序列化不含 "function"（带引号字面量，
// 避免把 description 里出现的英文单词 function 误杀）。
// ---------------------------------------------------------------------------

function assertPureData(name, value, serialized) {
  const walk = (v) => {
    if (typeof v === "function") return false;
    if (Array.isArray(v)) return v.every(walk);
    if (v && typeof v === "object") return Object.values(v).every(walk);
    return true;
  };
  if (!walk(value)) {
    throw new Error(`spec "${name}" 归一化后仍含函数值（normalize 泄漏），拒绝写盘`);
  }
  if (serialized.includes('"function"')) {
    throw new Error(`spec "${name}" 序列化结果含 "function" 字面量，拒绝写盘`);
  }
}

function writeIfChanged(file, content) {
  const existed = fs.existsSync(file);
  if (existed && fs.readFileSync(file, "utf8") === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return true;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ---------------------------------------------------------------------------
// 上游模块解析（仅 sync 进程内生效）：
// 1. `@fig/autocomplete-generators` → 本地解包 tarball 的 ESM wrapper
//    （包为 CJS；wrapper 显具名导出，避免 cjs-module-lexer 具名探测差异）；
// 2. 上游 spec 之间的扩展名省略相对导入（`./npm`）→ 补 `.ts`
//    （node ESM 不做扩展名推测，type-stripping 只处理已解析文件）。
// wrapper 的具名导出来自 allowlist 文件的 import 语句扫描——上游 spec 只在
// build-time 求值这些 generator 工厂（返回 custom/模板 generator，归一化
// 全部丢弃），不把包代码带进产物。
// ---------------------------------------------------------------------------

let vendorDepVersion = null;
let vendorDepNames = [];

function collectVendorDepUsage() {
  const names = new Set();
  for (const name of ALLOWLIST) {
    const file = path.join(tmpDir, "src", `${name}.ts`);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const re = /import\s*\{([^}]*)\}\s*from\s*["@'](@fig\/autocomplete-generators)["@']/g;
    let match;
    while ((match = re.exec(source))) {
      match[1].split(",").forEach((raw) => {
        const ident = raw.trim().split(/\s+as\s+/)[0].trim();
        if (ident) names.add(ident);
      });
    }
  }
  return [...names].sort();
}

async function prepareVendorDep() {
  const upstreamPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf8"));
  const range = upstreamPkg.dependencies?.[VENDOR_DEP];
  if (!range) throw new Error(`上游 package.json 未声明 ${VENDOR_DEP} 依赖`);
  vendorDepVersion = range.replace(/^[^\d]*/, "");
  vendorDepNames = collectVendorDepUsage();
  if (!vendorDepNames.length) return;

  const tarballUrl = `https://registry.npmjs.org/${VENDOR_DEP}/-/autocomplete-generators-${vendorDepVersion}.tgz`;
  const depDir = path.join(path.dirname(tmpDir), "fig-generators");
  fs.rmSync(depDir, { recursive: true, force: true });
  fs.mkdirSync(depDir, { recursive: true });
  const tgz = path.join(depDir, "pkg.tgz");
  const response = await fetch(tarballUrl);
  if (!response.ok) throw new Error(`下载 ${tarballUrl} 失败：HTTP ${response.status}`);
  fs.writeFileSync(tgz, Buffer.from(await response.arrayBuffer()));
  execFileSync("tar", ["-xzf", tgz, "-C", depDir], { stdio: "ignore" });
  const pkgDir = path.join(depDir, "package");
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const entry = path.join(pkgDir, pkgJson.main || "lib/index.js");
  if (!fs.existsSync(entry)) throw new Error(`依赖包入口不存在：${entry}`);

  const reexports = vendorDepNames.map((name) => `export const ${name} = pkg[${JSON.stringify(name)}];`).join("\n");
  const wrapper = [
    `// 由 scripts/sync_fig_specs.mjs 生成的临时 wrapper（CJS → ESM 具名导出）。`,
    `import cjsDefault, * as cjsNs from ${JSON.stringify(pathToFileURL(entry).href)};`,
    `const pkg = cjsDefault && cjsDefault.${vendorDepNames[0]} !== undefined ? cjsDefault : cjsNs;`,
    reexports,
    `export default pkg;`,
    "",
  ].join("\n");
  const wrapperPath = path.join(depDir, "wrapper.mjs");
  fs.writeFileSync(wrapperPath, wrapper, "utf8");

  const wrapperUrl = pathToFileURL(wrapperPath).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === VENDOR_DEP) return { url: wrapperUrl, shortCircuit: true };
      const isRelative = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
      if (isRelative && !path.extname(specifier)) {
        const tsUrl = new URL(`${specifier}.ts`, context.parentURL);
        if (fs.existsSync(fileURLToPath(tsUrl))) return { url: tsUrl.href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

async function main() {
  requireNode22_18();

  // ---- pin 解析：env FIG_AUTOCOMPLETE_REF > snapshot.json 已记录 pin > main ----
  const existingSnapshot = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")) : null;
  const ref = process.env.FIG_AUTOCOMPLETE_REF || existingSnapshot?.commit || DEFAULT_REF;
  console.log(`fig:sync → ${UPSTREAM_SOURCE} @ ${ref}`);

  // ---- clone/fetch 到 .tmp/（脚本自清：开始清一次，结束再清）----
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    git(tmpDir, "init", "--quiet");
    git(tmpDir, "remote", "add", "origin", UPSTREAM_REPO);
    // depth 1：分支名与完整 SHA 都可 fetch（GitHub 允许 reachable SHA fetch）
    git(tmpDir, "fetch", "--quiet", "--depth", "1", "origin", ref);
    git(tmpDir, "checkout", "--quiet", "FETCH_HEAD");
    const commit = git(tmpDir, "rev-parse", "FETCH_HEAD");
    console.log(`resolved pin: ${commit}`);

    // 上游 spec 的 build-time 依赖（@fig/autocomplete-generators）本地解包 +
    // 注册 resolve hook（扩展名省略相对导入也在此处理）
    await prepareVendorDep();
    if (vendorDepVersion) console.log(`${VENDOR_DEP}@${vendorDepVersion}（${vendorDepNames.join(", ")}）`);

    // ---- 归一化（共用前端纯函数；type-stripping import）----
    const { normalizeFigSpec } = await import(
      pathToFileURL(path.resolve(repoRoot, "frontend/src/lib/completion/fig/normalize.ts")).href
    );

    const sizes = {};
    const skipped = [];
    const emitted = [];

    for (const name of ALLOWLIST) {
      const upstreamFile = path.join(tmpDir, "src", `${name}.ts`);
      if (!fs.existsSync(upstreamFile)) {
        skipped.push({ name, reason: `上游无 src/${name}.ts` });
        console.warn(`! ${name}: 上游无 src/${name}.ts，记入 skipped`);
        continue;
      }
      const rawBytes = fs.statSync(upstreamFile).size;
      let mod;
      try {
        mod = await import(pathToFileURL(upstreamFile).href);
      } catch (error) {
        skipped.push({ name, reason: `import 失败：${error?.message?.split("\n")[0] ?? String(error)}` });
        console.warn(`! ${name}: import 失败（记入 skipped，继续）— ${error?.message?.split("\n")[0]}`);
        continue;
      }
      const raw = mod.default ?? mod.completion ?? mod.spec;
      const spec = normalizeFigSpec(raw);
      if (!spec) {
        skipped.push({ name, reason: "默认导出非可归一化的纯对象（无有效 name）" });
        console.warn(`! ${name}: 默认导出不可归一化，记入 skipped`);
        continue;
      }

      const serialized = JSON.stringify(spec, null, 2);
      assertPureData(name, spec, serialized);

      const moduleBody = [
        `// 由 scripts/sync_fig_specs.mjs 生成（${UPSTREAM_SOURCE} @ ${commit}）——纯数据，勿手改。`,
        `// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync`,
        `import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";`,
        "",
        `export const spec: FigSpecRoot = ${serialized};`,
        "",
      ].join("\n");
      const changed = writeIfChanged(path.join(buildDir, `${name}.ts`), moduleBody);
      emitted.push(name);
      sizes[name] = { rawBytes, normalizedBytes: Buffer.byteLength(serialized, "utf8") };
      console.log(
        `  ${name.padEnd(10)} raw ${(rawBytes / 1024).toFixed(1).padStart(8)} KB   normalized ${(sizes[name].normalizedBytes / 1024).toFixed(1).padStart(8)} KB${changed ? "" : "   (unchanged)"}`,
      );
    }

    // ---- 清掉 allowlist 之外的陈旧 build 模块（换 allowlist 后不留孤儿）----
    if (fs.existsSync(buildDir)) {
      for (const file of fs.readdirSync(buildDir)) {
        if (file.endsWith(".ts") && !ALLOWLIST.includes(file.replace(/\.ts$/, ""))) {
          fs.rmSync(path.join(buildDir, file));
          console.log(`  清理陈旧模块: ${file}`);
        }
      }
    }

    // ---- spec-manifest.generated.ts（静态 import map，不做懒加载——决策 D2）----
    const imports = emitted.map((name) => `import { spec as ${name} } from "./build/${name}";`).join("\n");
    const entries = emitted.map((name) => `  ${name},`).join("\n");
    const manifest = [
      `// 由 scripts/sync_fig_specs.mjs 生成（${UPSTREAM_SOURCE} @ ${commit}）——勿手改。`,
      `// 静态 import map（全量进 bundle，决策 D2）；懒加载留待 wave 2 按体积报告裁决。`,
      `import type { FigSpecRoot } from "../../src/lib/completion/fig/types";`,
      ...emitted.map((name) => `import { spec as ${name} } from "./build/${name}";`),
      "",
      `export const FIG_SPECS: Record<string, FigSpecRoot> = {`,
      entries,
      `};`,
      "",
    ].join("\n");
    writeIfChanged(path.join(vendorDir, "spec-manifest.generated.ts"), manifest);

    // ---- snapshot.json：同 pin 沿用旧 generatedAt（幂等前提）----
    const totalNormalizedBytes = Object.values(sizes).reduce((sum, s) => sum + s.normalizedBytes, 0);
    const totalRawBytes = Object.values(sizes).reduce((sum, s) => sum + s.rawBytes, 0);
    const snapshot = {
      source: UPSTREAM_SOURCE,
      repo: UPSTREAM_REPO,
      commit,
      requestedRef: ref,
      generatedAt:
        existingSnapshot?.commit === commit && existingSnapshot?.formatVersion === FORMAT_VERSION
          ? existingSnapshot.generatedAt
          : new Date().toISOString(),
      formatVersion: FORMAT_VERSION,
      allowlist: ALLOWLIST,
      vendorDeps: vendorDepVersion ? { [VENDOR_DEP]: vendorDepVersion } : {},
      sizes: {
        specs: sizes,
        totalRawBytes,
        totalNormalizedBytes,
      },
      skipped,
    };
    writeIfChanged(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    // ---- LICENSE / NOTICE（上游 license 原样拷贝；attribution 见方案 §48）----
    const licenseFile = fs
      .readdirSync(tmpDir)
      .find((f) => /^licen[cs]e/i.test(f) && !f.includes("."));
    if (!licenseFile) throw new Error("上游仓库根目录找不到 LICENSE 文件");
    writeIfChanged(path.join(vendorDir, "LICENSE"), fs.readFileSync(path.join(tmpDir, licenseFile)));

    const notice = [
      "Fig completion specification snapshot",
      "=====================================",
      "",
      `Source: ${UPSTREAM_REPO}`,
      `Pinned commit: ${commit} (see snapshot.json)`,
      "Synced by: scripts/sync_fig_specs.mjs (pnpm fig:sync)",
      "",
      "The completion specifications vendored under frontend/vendor/fig-specs/build/",
      "are derived from the public Fig/Amazon Q autocomplete ecosystem and are not",
      "part of the dbx-plugin-ssh original specification set. They are normalized to",
      "a static, code-free data form (function generators and postProcess hooks are",
      "dropped); see frontend/src/lib/completion/fig/types.ts for the normalized shape.",
      "The upstream license is reproduced verbatim in the LICENSE file beside this",
      "notice.",
      "",
    ].join("\n");
    writeIfChanged(path.join(vendorDir, "NOTICE.fig.txt"), notice);

    const kb = (bytes) => (bytes / 1024).toFixed(1);
    console.log(
      `\n共 ${emitted.length}/${ALLOWLIST.length} 个 spec 落盘；raw 总量 ${kb(totalRawBytes)} KB，归一化总量 ${kb(totalNormalizedBytes)} KB。`,
    );
    if (skipped.length) console.warn(`skipped: ${skipped.map((s) => s.name).join(", ")}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(tmpDir), "fig-generators"), { recursive: true, force: true });
  }
}

main().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(tmpDir), "fig-generators"), { recursive: true, force: true });
  console.error(`fig:sync 失败：${error?.stack ?? error}`);
  process.exit(1);
});
