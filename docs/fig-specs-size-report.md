# FIG 语料体积报告（Lane C'，批次 1 交付）

> 快照：specs `withfig/autocomplete@aef52acf` / parser
> `aws/amazon-q-developer-cli@5c621df6`（见
> `frontend/vendor/fig-specs/snapshot.json` 双 pin）。产物由
> `scripts/sync_fig_specs.mjs` 生成，全量数据以 snapshot.json 为准。

## 结论（供批次 2 决策 D2'）

- 全量语料编译产物 **86.76 MB / 1467 specs**，远超契约预算初值 5 MB；
  以当前单文件 UI 约束（D2'：spec bundled、不引入 chunk）**全量 bundled
  不可行**。
- 批次 1 交付按确定性 allowlist 入包：**724 specs / 4.99 MB**（≤ 5 MB 总量
  预算），覆盖全部 MOST_USED_SPECS（git/docker/ssh/kubectl/npm/aws…）。
- app 实测：`pnpm build` 单文件 `ui/index.html` = **4.2 MB**（语料 minify 后
  约 3 MB + 现有应用），构建/加载无异常。
- 非入包 spec 的编译产物不落库（build/ 只提交 allowlist 命中的文件），
  其体积记录在 snapshot.json `sizes`，需要时重跑 `fig:sync` 即可复现。

## 预算（snapshot.budget；verify/CLI 可覆写）

| 项 | 值 | 说明 |
|---|---|---|
| 语料总量 | 5 MB（契约初值，未调） | 入包 allowlist 实际 4.99 MB |
| 单 spec | **500 KB（由细则初值 300 KB 上调）** | 首测：git spec bundled 409 KB、aws 391 KB——300 KB 会把最常用命令裁掉；见 snapshot.json budget.source |

## 裁剪规则（确定性，同 pin 幂等）

1. 优先级 1：parser 常量 `MOST_USED_SPECS`（单一来源：vendored
   `packages/autocomplete-parser/src/constants.ts`）；
2. 优先级 2：其余 spec 按体积**升序**贪心填充（单位字节覆盖最多命令）；
3. 约束：单 spec ≤ 500 KB 且累计 ≤ 5 MB。

## 全量体积分布（编译产物，降序 Top 15；全表见 snapshot.sizes）

| spec | 体积 | 状态 |
|---|---|---|
| gcloud/compute | 4781 KB | 裁（超单 spec 上限） |
| az/2.53.0/network | 2126 KB | 裁 |
| aws/ec2 | 1616 KB | 裁 |
| aws/sagemaker | 889 KB | 裁 |
| az/2.53.0/storage | 856 KB | 裁 |
| aws/rds | 848 KB | 裁 |
| aws/connect | 666 KB | 裁 |
| az/2.53.0/iot | 659 KB | 裁 |
| aws/s3api | 643 KB | 裁 |
| gcloud/dataproc | 596 KB | 裁 |
| gcloud/container | 596 KB | 裁 |
| aws/iot | 565 KB | 裁 |
| mongocli | 525 KB | 裁 |
| az/2.53.0/sql | 511 KB | 裁 |
| aws/iam | 506 KB | 裁 |

- 超单 spec 上限（>500 KB）共 **16 个**，全部为 aws/gcloud/az 的深层子命令
  spec——即使单独放宽总量也拿不进 5 MB 预算，Top-N 决策可直接跳过；
- 这些 spec 的父命令（aws/gcloud/az 根 spec）已入包，根级子命令表仍可补全，
  仅"进入对应子命令后的下一级"降级 pass-through。

## 裁剪建议序（若批次 2 需进一步压缩，按体积降序剔除）

按 `snapshot.sizes` 降序逐个剔除直至回到目标预算，即 verify 输出的
`trimOrder`；首位依次为：git(409KB)→aws(391KB)→kubectl→az→gcloud→flutter→
docker→pnpm→curl→npx…（git/aws 体积大但属 MOST_USED，建议保留并优先压
budget 之外的按需通道，即批次 2 的按需 spec 分发，而非静态 bundled）。

## skipped（编译失败清单，共 6 个）

| spec | 原因 |
|---|---|
| copilot / pre-commit / serverless / sls | 外部依赖 `yaml` 未 vendored |
| deno / rush | 外部依赖 `strip-json-comments` 未 vendored |

均为数据转换类第三方库（spec 在模块顶层解析 YAML/JSON 字面量），与补全
语义无关；如批次 2 需要这 6 个 spec，再评估按 vendor 依赖闭包补入
（fig:sync 的 `NPM_PACKAGES` 列表），当前不引入。

## 其他

- vendor 产物 `fig:sync` 全目录（845 文件）同 pin 二次运行哈希一致（幂等）；
  snapshot `generatedAt` 取 parser pin 的提交时间而非运行时刻。
- 语料中 6 个 versioned spec（az/fig/heroku/shopify/infracost/@usermn/sdc）
  经 `@fig/autocomplete-helpers` 编译入包；其中 default export 为函数者
  （az/fig 等 6 个）由 `figCompletionSource.prewarm()` 异步解析，未完成前
  该命令名按 pass-through 降级。
