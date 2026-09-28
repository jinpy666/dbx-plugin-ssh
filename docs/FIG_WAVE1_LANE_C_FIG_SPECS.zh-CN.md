# Lane C 细则（最终架构版）：vendored parser + 全量语料 + source 实现

> 分支 `codex/ssh/fig-wave1-fig-specs`，基线 `codex/ssh/fig-wave1-base`。
> 冻结接口：`fig/source.ts`（**实现它**）、`core/tokenize.ts`（复用）。
> 旧版细则（手写 normalize / 纯数据断言 / 11 命令 allowlist）**作废**。
> 先读：契约（最终架构版）、ROADMAP（D2'/D5/D8）、FIG_VERIFICATION。

## 1. 快照管线（`scripts/sync_fig_specs.mjs`，唯一联网点）

1. clone/fetch 并 pin 两个上游（commit 落盘 snapshot.json）：
   - `withfig/autocomplete` —— spec 语料，**全量**（不再 allowlist）。
   - `aws/amazon-q-developer-cli` —— autocomplete TypeScript parser 子树（包内路径以快照实际为准：先探查仓库结构，找到 fig 兼容 parser/类型所在包再 vendor）。
2. parser 子树 → `frontend/vendor/amazon-q-autocomplete/`（src + 必要本地依赖 + LICENSE-MIT + LICENSE-APACHE + NOTICE，含方案 §48 attribution 文案）。
3. 语料 → `frontend/vendor/fig-specs/`：
   - `build/<name>.js`：经 bundler 编译的 ESM spec 模块（默认导出 spec 对象；**允许含函数**——generator 声明/自定义代码保留，运行受批次 2 安全策略约束）。
   - `spec-manifest.generated.ts`：静态 import map `Record<name, FigSpec>`（bundled，决策 D2'）。
   - `snapshot.json`：`{specs:{repo,commit}, parser:{repo,commit,path}, generatedAt, sizes, skipped[]}`。
   - `LICENSE` / `NOTICE.fig.txt`。
4. 编译器：优先复用 vite JS API（已是 devDep，零新增依赖）；确需 esbuild 等 devDep → 报告论证，未获批不写入。
5. Node ≥22.18 原生 type-stripping 直接 import 上游 TS；版本不足硬失败。
6. 逐 spec 编译，失败的记 `skipped[]` 继续；打印体积表。
7. **幂等**：同 pin 二次运行 diff 为空。

## 2. parser 编译产物

- `frontend/vendor/autocomplete-engine/parser.js`：单 ESM、browser-safe。
- Node API（fs/process/path…）依赖剥离或封装为可注入 facade：不可注入时抛 `unsupported` → 上层降级（§43），引擎不得崩溃。
- `loadSpec` / `generateSpec` 类文件系统语义 → 由 manifest 替代或禁用，处理清单写进报告。

## 3. source 实现（`frontend/src/lib/completion/fig/figCompletionSource.ts`）

- 实现冻结接口 `FigCompletionSource`：
  - tokenize 用 `core/tokenize.ts`（不自研）。
  - 语义全走 vendored parser（别名/persistent/variadic/嵌套/`--`/`--flag=value`）。
  - 产出 `CompletionResponse`：items 带 `CompletionEdit`（行尾 token 边界 replaceStart/replaceEnd）、`source:"fig-spec"`、kind 映射（subcommand/option/argument/hint…）。
  - generator 声明位置批次 1 → 返回 null（pass-through；批次 2 经 `completion/execute` 接入）。
  - 任何异常吞掉返 null，绝不上抛。
- parser.js 无类型：本文件内最小 `declare` + 防御性收敛，不污染全局命名空间。

## 4. verify 与预算（`scripts/verify_fig_specs.mjs`，离线）

- manifest ↔ build 文件一致；双 pin 存在；LICENSE/NOTICE 齐全；parser 产物 import 冒烟通过。
- 体积预算：语料总量默认上限 5MB、单 spec 300KB（首测后可调，调整写报告）；超限非零退出并按体积降序列裁剪建议序。
- `spec-manifest.generated.ts` 与 build 模块参与 typecheck/build 必须通过。

## 5. 测试（全离线）

- parser 冒烟：bundled parser + git spec 解析（别名 / 嵌套子命令 / `--`）。
- `figCompletionSource`：fixture manifest → CompletionResponse 断言（含 edit 边界、pass-through 分支、异常吞掉、generator 位置返 null）。
- 旧 normalize / 纯数据断言测试删除。

## 6. package.json / 杂项

- scripts：`fig:sync` / `fig:verify` / `fig:test`（vitest run src/lib/completion）。
- 删除 `scripts/import-fig-specs.mjs`（`figImport.ts` 本体属 Lane A' 的 `lib/completions/` 清理）。
- `tsconfig.json` 调整（vendor 排除/包含）允许，报告说明。

## 7. 验收

1. `fig:sync` 幂等 + `fig:verify` 通过。
2. `pnpm --dir frontend typecheck / test / build` 全绿。
3. `docs/fig-specs-size-report.md`：全量体积表 + 「全量 vs Top-N」批次 2 建议 + skipped 清单。
4. 除 `fig:sync` 外零联网；测试零联网。
5. sandbox 无外网时：sync 无法执行即 **blocker 如实上报**；脚本与测试仍须交付并以 fixture 验证。
