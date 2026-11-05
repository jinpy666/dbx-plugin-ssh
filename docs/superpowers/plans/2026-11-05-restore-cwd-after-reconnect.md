# #270 自动重连后恢复终端工作目录 — 实现计划

> 状态：**待人工评审**。本方案涉及"向远端 shell 注入命令"的新行为，按
> `.github/agent-flow.yml` 安全红线（`command_execution_changes: human_review_required`），
> 评审通过后才进入实现。
> 关联：issue #270；顺带修复重连提示读错路径来源的相邻缺陷。

## 一、根因（调查结论，2026-11-05）

- 断开即销毁：sidecar 读循环退出后移除会话（`backend/src/ssh.rs:2923-2945`），
  PTY 与远端 shell 一起消失。
- 重连 = 全新会话：`ssh/session/open`（`ssh.rs:2340-2440`）每次 spawn 新 PTY shell，
  从远端 home 启动；前端 `openSession` 也生成全新 sessionId。**没有任何 cwd 恢复。**
- cwd 唯一权威来源在前端：`terminalCwd`（`frontend/src/App.vue:790`），由
  OSC 7（:2342/:3841）、OSC 633（:3799）、OSC 1337 SetUserVar（优先通道，:1319）
  三通道上报，**跨重连存活**（:3703 注释确认新会话继承）。
- 相邻缺陷：重连提示读了 SFTP 面板路径而非终端 cwd（`App.vue:4645` 传
  `currentPath.value` 给 `describeReconnectRestoredNotice`）——重连后提示的
  "当前目录"可能是另一个无关目录。

## 二、方案选型

**方案 A（采纳）：前端注入恢复命令。**
重连成功后（`afterSessionConnected` 的 `reconnectWasPending` 分支），把
`cd '<escaped path>'` 经既有终端输入队列写入新 PTY stdin。

- 不动协议/manifest/mock 注册表（183 方法零变更），不进契约阶段。
- cwd 数据本来只在前端；方案 B（`ssh/session/open` 加 `restoreCwd` 字段）最终
  也是前端传值给 sidecar 再写 PTY stdin——同样的数据流，多一整层协议面，否决。
- 注入的命令行对用户可见：与重连提示条互相印证，是"诚实"的知情设计。
- 写入走与用户键入完全相同的通道（`terminalInputQueue.enqueue`），PTY 字节
  缓冲保证 shell 未就绪时不丢字。

**降级路径**：`terminalCwd` 为空（裸 sh 无 OSC 7 钩子）或含控制字符 → 不注入，
行为与现状完全一致（提示条回落 plain 文案）。

## 三、文件结构（改动面）

| 文件 | 职责 |
|---|---|
| `frontend/src/lib/terminalReconnect.ts` | 新增纯函数 `buildRestoreCwdCommand(path: string): string \| null` |
| `frontend/src/lib/terminalReconnect.spec.ts` | Task 1 的 TDD 用例 |
| `frontend/src/App.vue` | 重连分支接线注入 + 修 4645 路径来源 |
| `frontend/src/lib/i18n.ts` | 七语 `reconnectRestored.cwd` 文案微调 |

协议文档 `docs/PROTOCOL.zh-CN.md`、`manifest.json` 均不涉及。

## 四、任务分解（TDD，每任务独立 commit）

### Task 1：`buildRestoreCwdCommand` 纯函数

**RED** — `terminalReconnect.spec.ts` 新增用例：

- `/root/app/service` → `` cd '/root/app/service'\r ``（尾部 `\r` = 回车）
- 含单引号 `/root/it's` → `` cd '/root/it'\''s'\r ``（单引号转义，安全红线口径）
- 以 `-` 开头的路径 `-data` → `` cd './-data'\r ``（防被解析为选项；不引入
  `--`，兼容 fish/PowerShell/csh）
- 含换行或其他 <0x20 控制字符 → `null`（放弃注入）
- 空串 / 长度 > 4096 → `null`

**GREEN** — 在 `terminalReconnect.ts` 实现（单引号包裹 + `'\''` 转义 + 控制字符
守卫），并导出。

验证：`pnpm --dir frontend test -- --run src/lib/terminalReconnect.spec.ts`
commit：`fix(terminal): #270 重连恢复 cwd——纯函数与转义守卫`

### Task 2：App.vue 重连分支接线

位置：`afterSessionConnected`（`App.vue:4643-4648` 区域）：

```ts
if (reconnectWasPending.value) {
  reconnectWasPending.value = false;
  const restoredCwd = terminalCwd.value;
  if (restoredCwd) {
    const restoreCmd = buildRestoreCwdCommand(restoredCwd);
    if (restoreCmd) {
      const sessionId = session.value?.sessionId;
      if (sessionId) terminalInputQueue.enqueue(sessionId, new TextEncoder().encode(restoreCmd));
    }
  }
  const restored = describeReconnectRestoredNotice({ wasReconnecting: true, path: terminalCwd.value }); // 原 currentPath.value
  ...
}
```

要点：
- 注入发生在新会话 attach 之后、用户输入之前；经输入队列与用户键入同序。
- 仅 SSH 会话路径（`afterSessionConnected` 本身即 SSH 会话专用），local/telnet 不受影响。
- **顺带修复**：`path: currentPath.value` → `path: terminalCwd.value`（SFTP 面板
  路径 ≠ 终端 cwd，重连提示此前可能显示完全无关的目录）。

验证：`pnpm --dir frontend typecheck` + 全量测试 + `smoke_ui_mock`（mock 走查
重连流程不回归）。
commit：`fix(terminal): #270 重连成功后自动回到原工作目录`

### Task 3：i18n 七语文案

`reconnectRestored.cwd` 现文案（en: "Reconnected, current directory {path}"）
微调为明确"已恢复"口径，例：
- en: `Reconnected, restored working directory {path}`
- zh-CN: `已重连，已回到原目录 {path}`
- zh-TW / es / it / ja / pt 同义跟进（i18n.ts 内 7 处语言块）

验证：全量测试含 `i18nKeyReferences.spec.ts`（key 引用守卫）。
commit：`i18n: #270 重连恢复目录文案（七语）`

### Task 4：全量验证 + 宿主环境走查清单

契约本地验证清单（全绿后收口）：

```
pnpm --dir frontend typecheck && pnpm --dir frontend test && pnpm --dir frontend build
node scripts/smoke_ui_mock.mjs && node scripts/smoke_ui_settings.mjs
python3 scripts/validate_repo.py
```

**无法本地验证、需宿主环境手工走查**（无真实 SSH 凭据，红线禁止）：

1. 远端 `cd /root/app/service` → 断网触发自动重连 → 终端自动回到原目录，
   提示条目录一致。
2. 裸 sh / 无 OSC 7 远端 → 不注入命令行，提示为 plain 文案（现状行为）。
3. Windows PowerShell 远端 → `cd 'C:\Users\x'` 单引号语法正常执行。
4. 路径含单引号/空格/`-` 开头 → 转义正确，不产生选项误解析。
5. 重连时 SFTP 面板停在另一目录 → 提示条不再显示 SFTP 路径。

## 五、风险与评审点

- **命令注入面**：`cd` 为无副作用内建；路径经单引号转义 + 控制字符守卫 +
  长度上限，无命令拼接面。评审重点：转义函数正确性（Task 1 用例覆盖）。
- **时机竞态**：PTY stdin 缓冲保证 shell 就绪前不丢字节；与 bracketed paste
  （#260 修复，DECSET 2004）无交互——注入走输入队列、非粘贴路径，不被包裹。
- **误恢复**：`terminalCwd` 为最近一次上报值，极端情况下可能过期（目录已被
  删除）→ `cd` 失败，shell 打印错误后留在 home，现状行为不劣化。

## 六、不做的事（YAGNI）

- 不加设置开关（默认启用；用户有反馈再评估）。
- 不做方案 B（sidecar `restoreCwd` 协议字段）。
- 不动 SFTP 面板自身的目录恢复逻辑（SFTP 首拉已有独立回落链）。
