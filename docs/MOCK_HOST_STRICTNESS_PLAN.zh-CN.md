# mockDbxHost 严格化专项方案：静默成功改显式报错 + 白名单
（review 第三轮产出，待单独成轮实施）

> 来源：2026-09 架构评审（WATCH，评审线一致认定为唯一会让「测试绿」与真实
> 宿主行为系统性背离的点）。现状：`frontend/src/mockDbxHost.ts:1607` 默认
> 分支 `result = { success: true }`——约 62 个未实现方法（completion/execute、
> serial/*、telnet/*、vnc/* 大部、import/preview/*、mcp/*、local/open|reveal|
> saveFile 等）的调用被吞成成功，调用侧方法名/参数回归在 GUI 走查与截图冒烟
> 里不可见。`mockDbxHost.spec.ts` 钉的是 mock 自身行为，没有与后端注册表的
> 自动比对。

## 目标

1. mock 未实现的方法**显式 throw**（错误信息含方法名与「fixture 未实现」），
   让漂移在测试期显形，而不是静默成功。
2. 确有调用方依赖默认成功语义的方法，进**显式白名单**，白名单必须逐条有
   注释说明为什么允许。
3. 建立与后端注册表的**机械比对**：脚本从 `backend/src/main.rs` 的 match 分派
   表提取方法全集（或从 `docs/PROTOCOL.zh-CN.md` 方法总表提取），与 mock 的
   实现/白名单并集比对，缺口在 CI 报错（允许以 SKIP 声明「宿主侧才有」的
   方法，但必须显式列出）。

## 方案

### 1. 默认分支改 throw（小改）

```ts
} else {
  throw new Error(`[mockDbxHost] unimplemented method: ${method}`);
}
```

### 2. 白名单收敛（工作量主体）

逐方法决策三选一：实现桩（返回形状正确的假数据）/ 白名单默认成功（注释理
由）/ 显式 SKIP 清单（真实宿主能力，GUI 走查不触达）。经验上：
- `local/open|reveal|saveFile`：走查会点 → 需要桩（happy-dom 下可 no-op
  成功）。
- `serial/*`、`telnet/*`、`vnc/*`：走查主链路未覆盖 → SKIP 清单。
- `import/preview/*`、`mcp/*`：按冒烟脚本实际触达决定实现桩或 SKIP。
- 纯通知/幂等类（如 `sftp/transfer/history/clear`）：白名单默认成功。

### 3. 注册表比对脚本（防再漂移）

`scripts/mock_host_registry_check.mjs`：
- 从 `backend/src/main.rs` 抽 `"域/动作" =>` 模式得后端方法全集；
- 从 `mockDbxHost.ts` 抽已实现方法集合（switch case 模式）+ 白名单 + SKIP；
- 差集非空时 exit 1，输出缺口清单。加入 agent-flow local validation。

## 实施步骤（单独一轮）

1. 写比对脚本，先跑出缺口全景（预期 ~62 项）。
2. 按决策表逐项处理：默认分支 throw；实现桩/白名单/SKIP 逐条落注释。
3. `mockDbxHost.spec.ts` 增加「未实现方法必须 throw」与白名单边界用例。
4. 比对脚本进 local validation 列表（`.github/agent-flow.yml` validation.local）。

## 风险与对策

- **冒烟脚本依赖静默成功**：第一轮已见 `smoke_ui_mock.mjs` 对确认流的假设
  敏感。对策：改默认分支后立即全量跑双冒烟，失败项按决策表补桩，禁止为过
  冒烟把桩加成万能成功。
- **桩数据形状错误误导走查**：桩返回值尽量复用现有 fixture 常量并加注释；
  无法给形状的一律进 SKIP 而不是瞎编。
- **宿主新增方法后 mock 缺口**：比对脚本会在 CI 直接报错，提示补桩/SKIP——
  这是有意为之的摩擦。

## 验收门禁

全套门禁 + 比对脚本对当前仓库 zero-diff（mock 实现集 ∪ 白名单 ∪ SKIP ⊇
后端方法全集），并把结果计数写入本文件附录。

## 实施结果（review-fix-5 轮，2026-09-29）

- 默认分支已改 throw（`frontend/src/mockDbxHost.ts` 分发链末分支），错误
  信息带方法名并指向 `scripts/mock_host_registry_check.mjs`。
- 比对脚本 `scripts/mock_host_registry_check.mjs` 已落库并加入
  `.github/agent-flow.yml` validation.local（connection-forms 之后）。
- 缺口全景实测：后端分派表 153 个方法，mock 已实现 90；改 throw 后跑
  smoke_ui_mock / smoke_ui_settings 与前端全量单测，**39 个缺口方法零触达**
  ——全部进 SKIP（`SKIP_PREFIXES` 6 个域 + `SKIP_EXACT` 39 条，逐条注释
  触达判定依据），ALLOWLIST 暂空（未发现必须保留默认成功语义的幂等方法），
  未补任何凭空形状的桩。
- spec 新增用例：未实现方法 reject 且错误信息带方法名；已实现方法
  （docker/list）不受影响。
- 比对结果：`backend 153 methods, mock 90 implemented, allowlist 0, skip 45`，
  zero-diff PASS。
