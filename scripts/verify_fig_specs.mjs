#!/usr/bin/env node
// fig spec snapshot 离线校验（Lane C，docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md §6）。
//
// CI 可用、零网络：manifest ↔ build 文件 ↔ snapshot 三方一致、pin 存在、
// LICENSE/NOTICE 存在、纯数据断言、体积预算（单 spec >150KB 或总量 >600KB
// 非零退出——阈值首测后可调，调整需写进 lane 报告）。
//
// 在 frontend/ 下：pnpm fig:verify

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const vendorDir = path.resolve(repoRoot, "frontend/vendor/fig-specs");
const buildDir = path.join(vendorDir, "build");
const snapshotPath = path.join(vendorDir, "snapshot.json");

const SINGLE_SPEC_BUDGET_BYTES = 150 * 1024;
const TOTAL_BUDGET_BYTES = 600 * 1024;

function requireNode22_18() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    console.error(`fig:verify 需要 node >= 22.18（type-stripping import .ts 数据模块），当前 ${process.versions.node}。`);
    process.exit(1);
  }
}

const failures = [];
const check = (ok, message) => {
  if (ok) console.log(`  ok  ${message}`);
  else {
    console.error(`  FAIL ${message}`);
    failures.push(message);
  }
};

function assertPureData(name, value, serialized) {
  const walk = (v) => {
    if (typeof v === "function") return false;
    if (Array.isArray(v)) return v.every(walk);
    if (v && typeof v === "object") return Object.values(v).every(walk);
    return true;
  };
  return walk(value) && !serialized.includes('"function"');
}

async function main() {
  requireNode22_18();
  console.log("fig:verify（离线）");

  // ---- snapshot / LICENSE / NOTICE 存在性与基本形状 ----
  check(fs.existsSync(snapshotPath), "snapshot.json 存在");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  check(snapshot.formatVersion === 1, "snapshot.formatVersion === 1");
  check(typeof snapshot.commit === "string" && /^[0-9a-f]{40}$/.test(snapshot.commit), `snapshot pin 存在（${snapshot.commit?.slice(0, 12) ?? "?"}）`);
  check(typeof snapshot.source === "string" && snapshot.source.length > 0, "snapshot.source 存在");
  check(snapshot.sizes && typeof snapshot.sizes.specs === "object", "snapshot.sizes 存在");

  check(fs.existsSync(path.join(vendorDir, "LICENSE")), "LICENSE 存在");
  check(fs.statSync(path.join(vendorDir, "LICENSE")).size > 0, "LICENSE 非空");
  check(fs.existsSync(path.join(vendorDir, "NOTICE.fig.txt")), "NOTICE.fig.txt 存在");
  check(fs.statSync(path.join(vendorDir, "NOTICE.fig.txt")).size > 0, "NOTICE.fig.txt 非空");

  // ---- manifest ↔ build 文件 ↔ allowlist 三方一致 ----
  const manifestPath = path.join(vendorDir, "spec-manifest.generated.ts");
  check(fs.existsSync(manifestPath), "spec-manifest.generated.ts 存在");
  const { FIG_SPECS } = await import(pathToFileURL(manifestPath).href);

  const files = fs.existsSync(buildDir)
    ? fs.readdirSync(buildDir).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort()
    : [];
  const manifestKeys = Object.keys(FIG_SPECS).sort();
  const allowlist = [...(snapshot.allowlist ?? [])].sort();
  check(JSON.stringify(manifestKeys) === JSON.stringify(files), `manifest 键集 === build 文件集（${files.length} 个）`);
  check(JSON.stringify(manifestKeys) === JSON.stringify(allowlist), `manifest 键集 === snapshot allowlist`);
  check((snapshot.skipped ?? []).every((s) => !files.includes(s.name)), "skipped 项未混入 build 产物");

  // ---- 每个 spec：模块可 import、导出即 spec、纯数据、体积在预算内 ----
  let total = 0;
  for (const name of manifestKeys) {
    const spec = FIG_SPECS[name];
    const serialized = JSON.stringify(spec);
    const bytes = Buffer.byteLength(serialized, "utf8");
    total += bytes;

    check(typeof spec?.name === "string" && spec.name.length > 0, `${name}: 数据模块导出有效 spec`);
    check(assertPureData(name, spec, serialized), `${name}: 纯数据（无函数值 / 无 "function" 字面量）`);

    const recorded = snapshot.sizes?.specs?.[name]?.normalizedBytes;
    check(recorded === bytes, `${name}: 体积与 snapshot 记录一致（${(bytes / 1024).toFixed(1)} KB）`);

    if (bytes > SINGLE_SPEC_BUDGET_BYTES) {
      oversized = true;
      console.error(`  FAIL ${name}: ${(bytes / 1024).toFixed(1)} KB 超单 spec 预算 ${SINGLE_SPEC_BUDGET_BYTES / 1024} KB`);
      failures.push(`${name} 超单 spec 体积预算`);
    }
  }
  const recordedTotal = snapshot.sizes?.totalNormalizedBytes;
  check(recordedTotal === total, `总量与 snapshot 记录一致（${(total / 1024).toFixed(1)} KB）`);
  if (total > TOTAL_BUDGET_BYTES) {
    console.error(`  FAIL 归一化总量 ${(total / 1024).toFixed(1)} KB 超预算 ${TOTAL_BUDGET_BYTES / 1024} KB`);
    failures.push("总量超体积预算");
  }

  if (failures.length) {
    console.error(`\nfig:verify 失败（${failures.length} 项）`);
    process.exit(1);
  }
  console.log(`\nfig:verify 通过：${manifestKeys.length} 个 spec，归一化总量 ${(total / 1024).toFixed(1)} KB（预算 ${TOTAL_BUDGET_BYTES / 1024} KB）。`);
}

main().catch((error) => {
  console.error(`fig:verify 失败：${error?.stack ?? error}`);
  process.exit(1);
});
