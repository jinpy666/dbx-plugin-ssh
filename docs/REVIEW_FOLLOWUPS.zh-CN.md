# 代码审查跟进清单（2026-09-30）

本轮 review+fix 会话的完整产出。基线 `9acd6a2d`；七路并行审查（backend 核心 /
SFTP 传输链路 / 前端 UI-UX / 架构 / MCP 与分发 / 会话车道 / 前端组件），共 40+
条经逐行核实的发现。**已修 30 项**（首轮 16 + 二轮 6 + 三轮 3 + 四批 5，见
下），其余按优先级登记在此，供后续批次认领。

> 注：会话期间另有 agent 提交了 `codex/ssh/review-fix-batch1` 批次（14 文件，
> 文件夹上传数据错位、EOF 语义、session id 白名单、tar 成员逃逸、raw sftp
> poisoned 等），本清单不重复其已修项。两批改动已在同一工作区共存并通过全套
> 测试（cargo 1165 / vitest 1600 / vue-tsc）。

## 二轮已修（6 项，均为 HIGH）

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| backend/src/mcp.rs | stdio 行读取无预检上限——`read_until` 先全额缓冲对端无换行流再检查 | `read_bounded_line`：`take(max_line+1)` 封顶 + 残余吞弃 + EOF 尾行/满行边界语义，4 个单测 |
| backend/src/sudo_fs.rs | `sudo/readFile` length=0 全量 `cat \| base64` 无上限（≈4× 文件大小 RSS，大 root 文件 OOM） | 钳 `MAX_READ_BYTES`（8 MiB）+ truncated 语义保持；前端调用均显式传 length，无契约破坏 |
| backend/src/exec.rs + ssh.rs | `cancel_exec` 用 `task.abort()` 丢弃 russh Channel——远端进程残留、sudo timestamp 锁死 | cancellable 变体（watch 信号）：dial/env-exec/run 三阶段 select，取消经既有 Err 路径走 `abort_exec_channel` 优雅关闭；旧签名薄包装零调用点改动；`wait_cancelled` 语义 2 测试 |
| backend/src/ssh.rs | 会话自发断开（网络丢失）不清 `cleanup_session_transfers`——上传表项/.part/spool/metrics 缓存泄漏到 sidecar 退出 | `open_session` 改 `self: &Arc<Self>`，克隆运行时句柄进读循环任务，断开收尾调用同一清理函数 |
| backend/src/ssh.rs | `sftp()` 缓存无失效路径——死通道被原样复用，该会话 SFTP 永久报错 | `invalidate_sftp_cache` + `is_channel_level_sftp_error`（保守判定，误判仅多一次握手）；download_chunk 错误分支 + 树下载通道死亡中止整批（不再烧完队列逐文件登记失败）；判定函数单测 |
| backend/src/ssh.rs（树下载） | 通道死亡时逐文件登记 failure 烧完整树 | 见上条：通道级错误失效缓存、写回树状态并中止本批 |

## 四批已修（5 项：覆盖保护 + 并发损坏 + 僵尸会话 + 退避复位）

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| backend/src/sftp_ext.rs | `rename_unique` 的 latin-1/高层两条车道把**任何** lstat 错误当"目标不存在"——链路抖动下 999 次探测必命中一次瞬时错误，返回原名 → 上传走 CREAT\|TRUNC 静默覆盖既有文件 | 两条车道改用既有 `raw_exists_decision`/`high_level_exists_decision`（NO_SUCH_FILE-only 契约，已有测试钉住）；sudo 车道本就传播错误 |
| backend/src/sftp_copy.rs | overwrite=false 的占用预检：裸包车道 lstat 出错按"未占用"放行；shell 探针失败继续逐项执行——后续 `cp -a` 会静默覆盖既有目标 | 裸包车道探测错误按占用拦下该项；shell 探针失败整批拒绝（全 failed outcome，fail-closed），调用方在可确认状态下重试 |
| backend/src/sudo_fs.rs + sftp_ext.rs | sudo 写暂存名确定性 `<path>.dbx-part`、归档暂存名确定性 `{target}.tmp`——并发同路径交错写/互相清理产出损坏文件 | 两处暂存名掺 uuid（对齐 SFTP 车道既有惯例）；失败清理只可能删到自己的那份 |
| backend/src/ssh.rs | `close_session` 向容量 256 的终端队列发 Close 无超时——读循环阻塞在死 transport 且队列被灌满时 send 无限挂起，而 disconnect_connection 逐会话串行，一个僵尸会话拖死整个断开 RPC | 投递限时 2s，超时放弃（读循环因 transport 死亡自行退出，spontaneous 路径有完整收尾） |
| backend/src/vnc_session.rs | 自动重连 attempt 贯穿 worker 生命周期、成功代际不复位——长会话经历几次偶发断线后梯子耗尽被永久关闭 | `GenerationEnd::Failed` 加 `was_active`（完成过握手进入泵循环的失败），活跃代际失败后梯子复位重计（语义对齐 rdp `ReconnectBudget.on_active_generation`） |

## 三轮已修（3 项：门禁 + 吞吐 + 传输内存）

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| scripts/mock_host_registry_check.mjs + ci.yml + test.sh | 方法名隐形契约（173 个字符串方法）靠 agent 纪律同步 4-6 处，唯一校验脚本不在 CI | 升级四路比对（backend 分派 ↔ mock 桩 ↔ 前端 invoke ↔ PROTOCOL 文档）；顺带修掉两个脚本盲区：**连字符方法名**（`ssh/host-key/resolve` 等被旧正则静默漏检）与**别名臂**（`"a" \| "b" =>` 整行漏检）；暴露的 10 个缺口逐一处置（rename-unique 补 mock 桩、9 个走查不触达进 SKIP 带注释）；前端 78 个 invoke 调用点纳入硬门禁；docs 滞后 report-only 可见；接入 ci.yml validate job 与 test.sh |
| backend/src/ssh.rs | 下载分片逐片 OPEN+SEEK+READ+CLOSE——每片多付 2 个 RTT，高延迟链路吞吐被界死（50ms RTT ≈ 1.3MB/s） | DownloadState 加 `read_handle` 槽（File 的 Drop 发 close_nowait，置 None 即关闭）；首片 open 缓存、后续片 seek+read；读/seek 失败弃句柄惰性重建 + 通道级错误连带失效 SFTP 客户端缓存；latin-1 raw 车道逐片重建通道问题登记待修（用户面极窄） |
| backend/src/mcp.rs | MCP sftp_upload 阻塞全量读（`std::fs::read` 卡 tokio worker、超限文件读完才拒）；sftp_download 全量驻内存 + 同步写 | upload：tokio::fs + metadata 大小预检（超限不再读入）+ 读后二次防御；download 主分支真流式落盘（256KiB 分块边读边写，take 硬上限保持，失败/超限清半成品）；latin-1 分支本地写改 tokio |

## 首轮已修（16 项）

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| frontend/src/lib/transferQueue.ts | 派发调度 O(n³)（数千文件批次冻结主线程） | nextRunnable 单遍数槽；runTransfers 增量账本 + 按方向取件指针，摊还 O(1) |
| frontend/src/composables/useRecording.ts | openReplay 慢加载顶替新回放；倍速变更播放头跳变；搜索竞态；防抖 timer 泄漏 + 重复 onBeforeUnmount | requestEpoch 守卫 ×2；播放中重锚 replayStartWall；timer 合并清理 |
| frontend/src/composables/useSftpListLayout.ts | 列宽拖拽无 pointercancel、无卸载清理（document 监听 + body class 泄漏）；ResizeObserver 不 disconnect | 补 pointercancel + onBeforeUnmount 成对清理 |
| frontend/src/composables/useSessionReconnect.ts | 重复 disconnected 事件叠加双 timer → openSession 并发双开 | 入口先 clearTimeout 再设新 timer |
| frontend/src/composables/useMetricsPanel.ts | 裸错误串直显指标卡 | metricsRefreshFailed 七语新 key + console.warn 细节 |
| frontend/src/components/OtpPanel.vue | 生成失败每秒重试 + 错误条闪烁 | 5s/10s/30s 退避阶梯，手动重试不受限 |
| frontend/src/lib/completion/worker/engineRunner.ts | inline worker 无回收路径（重挂载累积线程） | dispose()（结清在途 + terminate）+ useCommandSuggestions 卸载调用 |
| backend/src/local_fs.rs | MAX_ENTRIES 截断在排序前（大目录返回不确定子集） | 先排序再截断 + 回归测试 |
| backend/src/metrics.rs | 失败分支格式化恒空的 output | 改报退出码 |
| backend/src/otp_store.rs | 固定名 tmp 并发落盘互相损坏（OTP 条目静默丢失） | tmp 名掺 uuid |
| backend/src/docker.rs | run_local 注释谎称"到达序合并"（实为 stdout+stderr 拼接） | 注释改述实情 |
| backend/src/mcp.rs | join_all 实为串行（multi_exec parallel 模式 10×300s 串到 3000s） | 二分递归 + tokio::join!（Box::pin），并发/顺序双测试钉住 |
| backend/src/mcp.rs | connections 写锁横跨整个 SFTP 传输（一次 2GiB 传输堵死全部 MCP 工具调用） | 三函数（sftp_tool/upload/download）写锁只圈句柄准备，传输锁外 |
| backend/src/mcp.rs | confirm 弹窗人工改写后的命令不过任何安全闸（破坏性/白名单/只读绕过） | 提取 enforce_command_text_gates，改写后对新文本重跑 + 测试 |
| frontend/src/App.vue 内联 i18n | （并发批次已加 key）——本轮补 useMetricsPanel 消费 | metricsRefreshFailed 七语齐全（i18nKeyReferences 测试守护） |
| frontend/src/lib/transferQueue.spec.ts | tie/混合批次语义无测试 | 补 3 个测试钉住 tie 队列序、增量账本 FIFO、串行混合序 |

## 登记待修（按优先级）

### HIGH

1. **latin-1 raw 下载车道逐片重建整条通道**——raw_read_chunk 每片新开
   channel+subsystem+INIT+OPEN/READ/CLOSE（6 RTT/片）；用户面极窄（转义名
   才走）。修法可参照三轮已落地的单文件句柄缓存同型做 RawSftpClient 缓存。

### MEDIUM

2. ssh.rs 终端热路径每 chunk 3-4 次全量拷贝（ReplayBuffer clone/encode/
   lossy/filter 无 marker 也复制）。修法：Arc 共享帧 + 条件构造文本。
3. local_terminal.rs shell integration 写固定共享临时目录——跟随符号
   链接、无 0700/属主校验，多用户 /tmp 下有 TOCTOU 注入窗口。修法：0700 +
   O_NOFOLLOW|O_EXCL 或每进程随机子目录（注意 Windows 无 O_NOFOLLOW）。
4. mcp.rs `connection()` 读锁检查与写锁插入 TOCTOU——并发首呼重复拨号
    （输家 handle 静默丢弃）。自愈性存在，非正确性破坏。
5. mcp.rs latin-1 `raw_sftp()` 不缓存——每次调用付出 channel+subsystem
    握手；高层失败回退时还双开。
6. **sftp 缓存失效挂点扩展**（二轮已建机制）：download/upload 车道已挂，
    list/stat/上传 start-finish 等短操作的通道级错误也可同型铺设
    `is_channel_level_sftp_error` + `invalidate_sftp_cache`。

### LOW

7. mcp.rs 桥转发路径 `timeoutSecs` 解析错误静默吞（本地路径同参报错）。
8. mcp.rs 一次 ssh_exec 重复解析注册表 5 次并克隆
    含凭据的 StoredConnection 多份。
9. serial_session.rs 持续 Ok(0)（EOF 形态驱动）以 50-100Hz 无限轮询、
    会话永不 retire。
10. local_terminal.rs / telnet_session.rs 读线程→泵 unbounded_channel
    无背压（终端跑 `yes` + 宿主桥背压时内存无上界）。
11. file_watch.rs mtime 相等短路跳过 sha256 对比（粗粒度 mtime 文件系统
    同 tick 改写漏报）。修法：长度相等时始终比对指纹。
12. frontend/src/composables/usePluginEvents.ts RDP 分片剪贴板空串哨兵
    （合法空分片导致拼接永挂）+ 会话关闭不清理条目。
13. frontend/src/components/ImportWizard.vue ack 先于 sendBinary 创建——
    后者抛错时 30s 后 unhandled rejection。
14. frontend/src/components/PortForwardDialog.vue 以错误文案嗅探
    "Connection is not active" 决定重连重试（sidecar 措辞变更即静默失效）。
    根修依赖结构化错误码（见 22）。
15. 错误契约：后端全链 `Result<_, String>` 英文散文，前端正则猜措辞
    （sftpErrors.ts、sudo 换道引导）。最小改法：统一 `[E:PERM]` 类前缀协议，
    前端匹配前缀、散文留给人类。
16. MCP sftp_upload 完全流式：limit 内文件仍全量驻内存（默认 16MiB、可调
    至 2GiB 上限）——边读边写需 raw 直写分支同步改造，登记后续。
17. frontend/src/components/TerminalHistoryPanel.vue 空转 watchEffect
    （死代码，直接删）。
18. frontend/src/composables/useTrzsz.ts 下载 sidecar 落盘车道整文件
    驻内存（≈2.3× 文件大小）；根修需宿主桥支持分片 append。
19. useRecording 的 20000 事件回放拉取、metrics 轮询等已有守卫；App.vue
    状态下放为域 store（session/sftp/appearance）是 architect 建议的中期
    方向，门禁已落地（三轮），余下是第 19 条的 App.vue 域状态下放。

## 验证口径

- `node scripts/mock_host_registry_check.mjs`：PASS——backend 173 方法（含
  别名臂）/ mock 96 实现 / 前端 invoke 78 验证 / docs 15 滞后 report-only。
- `cargo test`：1165 passed（三轮累计新增 8 个：local_fs 截断、join_all 并发/
  顺序、command_text_gates、read_bounded_line 边界、wait_cancelled 语义 ×2、
  通道级错误判定；其余为并发批次与其前基线）。
- `pnpm typecheck && pnpm test`：152 文件 / 1600 测试全过（新增 transferQueue
  3 个；二轮未动前端）。
- 与并发批次的文件交叉：ssh.rs/exec.rs/sudo_fs.rs/mcp.rs 双方都有改动（不同
  函数区域），全套测试通过确认无语义冲突。
