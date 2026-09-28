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
继续等待其提交与报告。
