# FIG 协调者裁决日志

> 逐条记录 lane 报告偏差的裁决结果；冻结文件与契约的变更以此为准。

## 2026-09-28 批次 1

### 1. A′：冻结文件注释性改动（追认）

`core/tokenize.ts` / `tokenize.spec.ts` 头注释原含 `lib/completions/spec.ts` 字面量，
与 A′ 的退役 grep 门禁冲突；A′ 仅改注释、零代码语义。**追认**，冻结语义不变。

### 2. A′：新增 `lib/completion/testing/fakeFigSource.ts`（追认并补录归属）

授权来源为 LANE_A 细则 §2.1（"本 lane 提供 Fake source（测试用）"）；契约 §4 文件
清单补录该路径至 A′ 归属。dev 构建（`import.meta.env.DEV`）注入 Fake 支撑手动清单、
生产为 pass-through source 的分层设计**批准**；C′ 真实 source 在集成分支于 App.vue
构造点一处替换。

### 3. A′：键入路径时序与退役键断言写法（知悉，无异议）

常规键入路径以 `request("typing")` 同步冲刷防抖（保历史建议/ghost 基线时序，冻结
source 为同步接口）；spec 内退役键字面量以字符串拼接书写满足 grep 门禁。均为实现
细节裁量，符合红线。

### 4. B：基线漂移说明（无需动作）

B 分支基于 `5b63b0b8`（早于最终架构提交 `448e92d8`）。与基线的文件差异均为单侧
改动（冻结文件/文档仅 base 侧变更），三方合并自动解决；B 对 `backend/src/ssh.rs`
的改动属 LANE_B 细则预批的最小只读查询例外，集成时核对。

### 5. C′：现场观察（在途）

C′ 已成功 clone 双上游（网络可用）：`/tmp/fig-sync-probe` 内 amazon-q（已 pin）与
fig-autocomplete 全量语料，并在组装语料共享模块的编译产物；尚未向 worktree 落盘。
继续等待其提交与报告。（后记：C′ 按时交付，报告偏差已在集成阶段全部落办。）

## 2026-09-28 批次 2

### 6. P1 尖兵结论（采纳）

`?worker&inline` 在 vite@8.3.0（内置 rolldown）可用：data-URL + encodeURIComponent
内联、零额外 chunk、单文件断言全过、vite/client 类型现成。第四棒按此实施。
spike 分支 `codex/ssh/fig-spike-worker-inline` 保留现场、永不合并。

### 7. P2 归属补录与设计追认

归属补录：`lib/completion/host/hostClient.ts(+spec)`、`lib/completion/fig/generatorRunner.ts(+spec)`。
设计追认：①非零 exitCode 不判失败（对齐 Fig 语义）；②客户端前置畸形校验与传输
失败同语义返回 null。

### 8. D（批次 2-1）实现取态追认

①App 构造点切换真实 figCompletionSource（DEV Fake 退役）；②CompletionMenu/i18n
越界授权（占位行与七语必须落此）；③figCompletionSource 导出类型放宽为实现类
（collectGenerators 第二通道），冻结接缝不变；④"零静态候选纯 loading"时 Tab/Enter
放行 shell（契约 §2.2 的实现化）；⑤缓存 key 追加 script/splitOn 槽位身份；⑥icon
无通道仅接受不透传（已文档化）。

### 9. E（批次 2-2）归属、接线与同步/异步裁决

归属：`lib/completion/worker/{engineRunner,engine.worker}.ts(+spec)`、`build.mjs`
（inlineDynamicImports→codeSplitting: false 迁移）。裁决：①worker 模式 resolve
返回 Promise——controller 已有 thenable 防御分支（"Worker 化留位"），零改动采纳；
②最终接线由协调者执行（b2b3d56e）：构造点换 runner、**collect 通道直引单例**
（runner 只代理冻结 resolve）；③per-request 超时（worker 假死防悬挂）列 follow-up。

### 10. 体积裁决（发布前硬门禁）

批次 2 完成态 `ui/index.html` = **11.76 MB**（语料在主 bundle 与 worker 载荷双份）。
**未落批次 2-3 裁剪前不得发布**。裁决方向：默认 allowlist 收敛到
MOST_USED_SPECS（C′ 确定性规则优先级 1）重跑 fig:sync，同步约束两份载荷；
Top-N 定版数值由用户在体积/覆盖间拍板。
