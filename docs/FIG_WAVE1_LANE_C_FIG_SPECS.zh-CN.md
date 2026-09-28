# Lane C 细则：Fig Spec 管线（fig-specs）

> 分支 `codex/ssh/fig-wave1-fig-specs`，基线 `codex/ssh/fig-wave1-base`。
> 先读：`FIG_WAVE1_CONTRACT.zh-CN.md`、`FIG_ROADMAP.zh-CN.md`（决策 D2/D5）、`FIG_VERIFICATION.zh-CN.md`。
> 冻结类型 `core/types.ts` 只 import 不改；**不碰 App.vue**（接线是 wave 2）。

## 1. 目标 / 非目标

目标：建立「上游 spec → 归一化 snapshot → 静态 adapter」的 build-time 管线，
产出 11 个命令的 spec bundle 与体积实测报告，为 wave 2 接线备料。

非目标：把 fig provider 接进 controller/设置、generator 执行（B lane + wave 2）、
custom JS generator、全量 corpus、修改 `lib/completions/` 下任何既有文件
（`figImport.ts` 保留原样，新代码放 `lib/completion/fig/`）。

## 2. 目录

```text
frontend/src/lib/completion/fig/
├── types.ts            # 归一化后的 fig 运行时类型（见 §3）
├── normalize.ts        # 上游原始 spec 对象 → 归一化（纯函数，sync 脚本与测试共用）
├── adapter.ts          # resolveFigLine：归一化 spec → CompletionItem[]（纯函数）
└── fixtures/git.fig.json   # 手工裁剪的稳定 git spec 快照（测试离线用）
frontend/vendor/fig-specs/
├── LICENSE / NOTICE.fig.txt
├── snapshot.json       # {source, commit, generatedAt, formatVersion:1, sizes}
├── build/<name>.ts     # 归一化 spec 数据模块（纯数据，import type 引类型）
└── spec-manifest.generated.ts   # 静态 import map（不做懒加载，决策 D2）
scripts/sync_fig_specs.mjs   # 唯一联网点（决策 D5）
scripts/verify_fig_specs.mjs  # 离线校验
```

已核实：`frontend/vendor/` 不受 `check_vendor_lockstep.py`（只管 backend/vendor
RDP 链）与 `validate_repo.py`（固定 standalone 路径清单）约束。

## 3. `types.ts`（归一化形态，非上游原始形态）

```ts
export interface FigGeneratorDecl { kind: "script"; script: string[]; splitOn?: string }  // wave1 只存声明不执行
export interface FigArg { name?: string; description?: string; isVariadic?: boolean; isOptional?: boolean; suggestions?: string[]; generators?: FigGeneratorDecl[] }
export interface FigOption { names: string[]; description?: string; args?: FigArg | null; isRepeatable?: boolean; isPersistent?: boolean; isRequired?: boolean }
export interface FigSubcommand { name: string; aliases?: string[]; description?: string; subcommands?: FigSubcommand[]; options?: FigOption[]; args?: FigArg[] }
export interface FigSpecRoot { name: string; aliases?: string[]; description?: string; subcommands?: FigSubcommand[]; options?: FigOption[]; args?: FigArg[] }
```

设计要点：`Option.name: string | string[]` 归一为 `names: string[]`（含长/短
名原样，`--` 前缀保留）；`isPersistent` 保留并在 adapter 里沿子命令树下传；
函数型 generator 只留 `{kind:"script", script}` 声明，`postProcess` 等 JS 函数
**丢弃**（wave 2 用 B 的 RPC + 前端 postProcess 兜底，snapshot 不存代码）。

## 4. `normalize.ts`

输入：node 直接 import 上游 `src/<name>.ts` 得到的默认导出（多数是纯对象；
个别含函数/模板——函数字段按 §3 规则丢弃或降级）。输出：`FigSpecRoot`。
规则：别名数组保留；`args` 取首个 required 之外的可选链（`isOptional` 标记）；
子命令树不截深度（legacy 的两层限制不适用于 fig 路线）；`loadSpec`/
`generateSpec` 指令 → 记录为该子命令 `generators: []` + 保留原节点（wave 3 处理）。

## 5. `adapter.ts`

```ts
export interface FigResolveResult { items: CompletionItem[]; context: CompletionContext }
export function resolveFigLine(line: string, specs: readonly FigSpecRoot[]): FigResolveResult | null
```

- 复用 `lib/completions/spec.ts` 的 `splitCommandLine`（只读 import）。
- 能力必须超出 legacy：别名命中（`git co` → checkout）、persistent options 沿树下传、
  variadic args（多个位置 token 持续补）、repeatable option 不因已出现而消失、
  子命令树无深度限制、`--` 终结、`--flag=value` 内联值层。
- `edit` 用与 legacy adapter 相同的行尾 token 边界语义（replaceStart/replaceEnd）；
  `source: "fig-spec"`；无命中 → null（调用方回落 legacy → 历史）。
- 测试全走 `fixtures/git.fig.json`（离线）：alias、persistent、variadic、`--`、
  inline `=`、深度子命令 ≥8 个用例；另加一个「fig 与 legacy 对 git 同行输入
  候选对比」的信息性用例（允许 fig 更丰富，断言 fig ⊇ legacy 的静态部分）。

## 6. `scripts/sync_fig_specs.mjs`（唯一联网点）

1. `FIG_AUTOCOMPLETE_REF`（缺省用 snapshot.json 已记录 pin；首次为当前默认 pin，
   落盘新 pin）clone/fetch `withfig/autocomplete` 到 `.tmp/`（脚本自清）。
2. allowlist（wave 1，方案 §36 M3）：git, docker, kubectl, helm, npm, pnpm,
   yarn, ssh, aws, cargo, systemctl。
3. node ≥22.18 原生 type-stripping `import()` 每个上游 `src/<name>.ts`
   （版本不满足直接报错，不静默降级）；`normalize` 后 emit
   `frontend/vendor/fig-specs/build/<name>.ts`（`import type { FigSpecRoot } from "../../../src/lib/completion/fig/types"` + `export const spec: FigSpecRoot = {...}`）。
4. 生成 `spec-manifest.generated.ts`（静态 `import` + `Record<string, FigSpecRoot>`）
   与 `snapshot.json`；拷贝上游 LICENSE → `vendor/fig-specs/LICENSE`，写 NOTICE
   （含方案 §48 的 attribution 文案）。
5. 打印每 spec 归一化后 KB 与总量；对上游 spec 若 import 失败（非纯对象），
   记入 snapshot.json 的 `skipped[]` 并警告，不中断其余。
6. **emit 的模块必须纯数据**：写入前断言序列化结果不含 `"function"`。

`scripts/verify_fig_specs.mjs`（离线，CI 可用）：manifest↔文件一致、snapshot
pin 存在、LICENSE/NOTICE 存在、纯数据断言、体积预算（单 spec >150KB 或总量
>600KB → 非零退出；首测后可调阈值，调整写进报告）。

`frontend/package.json` scripts 增加：`fig:sync` / `fig:verify` / `fig:test`
（= `vitest run src/lib/completion`）。**不新增运行时依赖**；build-time 依赖
同样目标为零（type-stripping 足够）；若确需 devDependency，报告中论证并给出
替代方案，未获批前不写入。

## 7. 体积实测报告 `docs/fig-specs-size-report.md`

- 表：每 spec（raw KB / 归一化 KB）；总量。
- bundle 影响：`pnpm build` 前后 `ui/index.html` 字节数（manifest 引入 vs
  临时注释掉 manifest 导出做对照）。
- 结论建议：wave 2 默认集（若超预算给出裁剪序：aws → kubectl → helm …）。

## 8. 验收

1. `pnpm fig:sync` 幂等可重跑（同 pin 二次运行 diff 为空）。
2. `pnpm fig:verify` 通过。
3. `pnpm --dir frontend typecheck && test && build` 全绿（vendor 数据模块参与
   typecheck/build 不报错）。
4. 体积报告成文，含明确「wave 2 默认集」建议。
5. 全程除 `pnpm fig:sync` 外无网络行为；测试零联网。
