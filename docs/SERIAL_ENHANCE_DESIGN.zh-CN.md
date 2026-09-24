# 串口会话增强设计稿（sidecar 协议升级，仅设计不实现）

> 状态：设计稿片段（非合同文档）。对应 PROGRESS-P-SSH「M4 遗留」第 3 条串口 MVP 已知限制中
> 涉及 sidecar 协议的部分：JSON 写通道、无 replay/resize。
> 协议变更是人工评审项（见 `.github/agent-flow.yml` security 节），本稿仅供评审，未落实现。
>
> 对标基线：NyaTerm serial 无 replay、无 resize（`core/terminal_session/serial/` 全目录
> 核实），写路径为进程内互斥锁直写，无写线程、无独立写通道。本文档的二进制写通道、
> 写序列化与 replay 方案均**无 NyaTerm 先例，属自研设计**，实施前需按协议变更流程
> 人工评审。
>
> ports 列表 USB 后缀剥离与串口参数严格校验已在 backend 增量中落地（`backend/src/serial_session.rs`），
> 不属于本稿范围。

## 1. 现状

| 通道 | 方向 | 形状 |
| --- | --- | --- |
| `serial/start` / `serial/close` / `serial/list` / `serial/ports/list` | JSON-RPC（请求/响应） | 参数与结果均为 JSON |
| `serial/write` | JSON-RPC（请求） | `dataBase64` 字符串，sidecar base64 解码后写入端口 |
| `serial/terminal/out/{id}` | 二进制事件 | `TerminalFrame { sequence, stream, data }` 编码帧 |

输出方向已是二进制帧；输入方向（键盘写入）走 JSON + base64。

## 2. 写通道升级为二进制

### 方案 B1：对称二进制写帧（推荐）

新增 `serial/terminal/in/{id}` 二进制事件通道，沿用现有 `TerminalFrame` 帧结构
（首字节流标签 + 大端 `u64` 单调序号 + 数据，见 `docs/PROTOCOL.zh-CN.md`「二进制通道」节），
`data` 为原始键序字节，与输出通道对称。

流标签需**新增取值**：现有 `TerminalStream` 只有 `Stdout = 0` / `Stderr = 1` /
`State = 2`（`backend/src/model.rs`），**没有 `Stdin` 变体**，且 `State = 2` 已被
local 终端用作带内状态帧，新值必须避开。B1 取 `Stdin = 3` 并写入契约；解码端
（宿主桥/前端/sidecar）遇到未知流标签一律静默丢弃该帧并计数，不得断连或 panic；
sidecar 对 `serial/terminal/in` 上标签非 `Stdin` 的入站帧返回参数错误。

- 优点：
  - 消除 base64 编解码开销与体积膨胀（+33%）；
  - 帧结构与输出帧同构，编解码代码可在新标签上扩展复用；
  - `sequence` 用于写序审计与排查。桥可能重复投递也可能丢帧，只有去重没有重传
    是半个机制；写序正确性由下文写队列串行化保证，去重/重传不在首版范围。
- 缺点：
  - 协议新增通道与新增流标签，需前端配合（标签映射 + 新通道订阅 + 发送路径改造）；
  - 二进制事件在宿主桥上的流量控制行为需要实测（背压结构见下节草案）。

### 方案 B2：维持 JSON，仅扩展批量写

`serial/write` 保持形状，追加可选参数 `batch: [dataBase64, ...]` 顺序写。

- 优点：无新通道、无前端解码改造，改动最小。
- 缺点：base64 开销仍在；批量语义（部分失败的中断点）需要额外定义，长期价值低于 B1。

### 写序列化与回压（设计草案，实施前需评审）

现状没有写线程：键入与批量写都在异步任务上持端口互斥锁
（`serial_session.rs` 的 `write: Arc<Mutex<SerialPort>>`）直接 `write_all + flush`
（`write_raw`）；NyaTerm 同为进程内互斥锁直写，其 X/Y/ZMODEM 引擎写亦为块级小写。
64 KiB 大块写在两个代码库都无先例；@9600 波特约持锁 66 秒，期间键入与上传引擎
（共享同一把锁）全部饿死。B1 引入粘贴/批量级大块写场景，故配套以下结构，与既有
互斥锁结构一致：

- **分帧**：大块写入按小块（如 1–4 KiB，实施时按波特率定稿）切分入队，单块持锁
  时间有上界；
- **有界写队列 + 专用写线程**：每会话一条写线程独占端口锁，异步侧（键入、批量、
  上传引擎输出）只入队不碰锁；队列按字节预算有界（如 256 KiB），满时入队方等待
  或报错而非无界堆积（策略实施时定稿）；
- **来源策略**：键入小块设上限，超限丢弃并向前端回报丢弃事件；上传引擎输出保持
  块级小写，不受切分影响；
- **可取消**：上传取消或会话关闭时清空队列并放弃在途写入。

本节为设计草案、非已评审结论；写线程引入的关闭时序（close 与在途写竞争）需在
实施评审中一并定稿。

### 与已合入上传引擎的互斥

X/Y/ZMODEM 文件上传已合入（`serial/upload/start|data|cancel` +
`backend/src/serial_xmodem.rs`，JSON 64 KiB 分块已验证可行，见
`docs/PROTOCOL.zh-CN.md`「串口文件上传」节），本通道**不是**其“预备路径”。
两者共存语义定义为互斥：

- 仲裁现状：同一会话至多一个上传（并发 `start` 报错）；上传期间的键入由前端闸门
  拦下；两路径最终都经端口互斥锁串行化；
- B1 明确化：上传活动期间（upload job 存在），二进制写帧与键入走同一前端闸门、
  一律不发；sidecar 对上传期间的二进制写帧直接报错拒绝，作为单一前端闸门的后盾；
- 引擎取消/完成释放闸门后，二进制写通道恢复可用。写入收敛到写队列后，仲裁由
  「互斥开关 + 单写线程」共同承担。

### 兼容策略

JSON `serial/write` 保留为兼容路径。注意其契约目前**未收录**进
`docs/PROTOCOL.zh-CN.md`（该文档仅含 `serial/upload/*`），B1 定稿同步契约时应把
serial 会话方法一并回补（见 §5）。能力探测：`serial/start` 响应新增能力字段
（如 `binaryInput`），未声明该能力的 sidecar 走 JSON 路径；前端对未知通道/方法
报错一律降级 JSON，老前端不受影响。`BackspaceMode` 的 DEL→BS 改写在两个通道上
语义一致（sidecar 内统一执行）。

## 3. replay（输出回放）

与 telnet/local 终端的既有 replay 先例对齐，采用**序号制**（`after_sequence →
frames + complete`，`telnet_session.rs` / `local_terminal.rs` 同构）：串口输出帧本就
带单调序号（读循环逐读递增），读线程在会话生命周期内维护按帧保存的有界环形缓冲
（按字节预算截断，建议 128 KiB，可配），新增 JSON 请求
`serial/replay { sessionId, afterSequence }` → 在 `serial/terminal/out/{id}` 上重发
其后的帧，并返回摘要 `{ frameCount, firstAvailableSequence, tailSequence, complete }`。

- 用途：webview 重载/断线重连后恢复滚动区上下文；与 telnet/local 完全同构，
  前端既有 gap 检测/drain 机制（`drainTerminalFrames` 体系）可直接复用，无需
  新写一套恢复逻辑；
- 权衡：帧粒度缓冲常驻内存（每会话 128 KiB 上限可接受）；摘要走 JSON、帧走既有
  二进制通道，无 base64 形状冲突；
- `complete: false` 表示缓冲已绕回、回放不完整，前端可显示截断提示。

## 4. resize：明确不实现

RS-232 无窗口尺寸概念，PTY 式 `resize` 对串口会话语义不成立（NyaTerm serial 亦无
resize 先例）。若未来为拨号 BBS 场景需要「终端尺寸」，那属于终端模拟器本地状态，
不进入 sidecar 协议。PROGRESS 中「无 resize」限制的关闭以本结论为依据，在评审
接受本稿后落账，不由本设计稿自宣。

## 5. 验收建议（评审通过后的实施项）

- B1：契约测试覆盖帧编码/解码对称性（含 `Stdin = 3` 标签与未知标签丢弃）；
  写序与 `serial/write` JSON 路径并发时的顺序性；大块（64 KiB）写入吞吐对比基线；
  上传活动期间二进制写帧被拒、闸门释放后恢复。
- 写序列化：慢速口（9600 波特）并发用例——注入 64 KiB 大块写的同时键入，键入延迟
  有上界、上传引擎 ACK 不被饿死；写队列满时的降级行为符合定义；会话关闭清空队列。
- replay：重连回放帧与缓冲内容逐帧一致、序号连续；环形绕回 `complete: false` 标记
  正确；会话关闭后 replay 返回会话不存在错误。
- 两者均需前端（SerialConnectDialog/App.vue 接线）与 `docs/PROTOCOL.zh-CN.md` 契约同步
  （含回补 serial 会话 MVP 方法与 `Stdin` 流标签），按 agent-flow 归 integrator/review
  流程人工评审。
