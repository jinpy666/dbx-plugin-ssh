# 串口会话增强设计稿（sidecar 协议升级，仅设计不实现）

> 状态：设计稿片段（非合同文档）。对应 PROGRESS-P-SSH「M4 遗留」第 3 条串口 MVP 已知限制中
> 涉及 sidecar 协议的部分：JSON 写通道、无 replay/resize。
> 协议变更是人工评审项（见 `.github/agent-flow.yml` security 节），本稿仅供评审，未落实现。
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

新增 `serial/terminal/in/{id}` 二进制事件通道，复用现有 `TerminalFrame` 编码
（`sequence` 单调递增、`stream` 固定 `Stdin`、`data` 为原始键序字节），与输出通道对称。

- 优点：
  - 消除 base64 编解码开销与体积膨胀（+33%），按键路径零拷贝直达写线程；
  - 与输出帧同一结构，前端解码代码可复用，sequence 还能做写序去重；
  - 为后续粘贴大块文本/文件上传到串口（X/Y/ZModem 预备路径）留出高吞吐通道。
- 缺点：
  - 协议新增通道，需前端配合（新通道订阅 + 发送路径改造）；
  - 二进制事件在宿主桥上的流量控制行为需要实测（大块写入时背压未知）。

### 方案 B2：维持 JSON，仅扩展批量写

`serial/write` 保持形状，追加可选参数 `batch: [dataBase64, ...]` 顺序写。

- 优点：无新通道、无前端解码改造，改动最小。
- 缺点：base64 开销仍在；批量语义（部分失败的中断点）需要额外定义，长期价值低于 B1。

### 兼容策略

JSON `serial/write` 长期保留为兼容路径；二进制通道上线后前端按能力探测切换，
老前端不受影响。`BackspaceMode` 的 DEL→BS 改写在两个通道上语义一致（sidecar 内统一执行）。

## 3. replay（输出回放）

串口读线程在会话生命周期内维护一个有界环形缓冲（建议 128 KiB，可配），新增
`serial/replay` JSON 请求返回最近 N 字节（`{ sessionId, maxBytes }` → `{ data: base64, dropped: bool }`）。

- 用途：webview 重载/断线重连后恢复滚动区上下文，与本地终端 replay 语义对齐。
- 权衡：环形缓冲常驻内存（每会话 128 KiB 上限可接受）；二进制响应与 JSON-RPC 返回值
  的形状冲突——首版用 base64 字符串装进 JSON 返回（小流量、低频），若实测过大再评估
  独立二进制响应通道。
- `dropped: true` 表示缓冲已绕回、回放不完整，前端可显示截断提示。

## 4. resize：明确不实现

RS-232 无窗口尺寸概念，PTY 式 `resize` 对串口会话语义不成立。若未来为拨号 BBS 场景
需要「终端尺寸」，那属于终端模拟器本地状态，不进入 sidecar 协议。PROGRESS 中的
「无 resize」限制以此结论关闭。

## 5. 验收建议（评审通过后的实施项）

- B1：契约测试覆盖帧编码/解码对称性；写序与 `serial/write` JSON 路径并发时的顺序性；
  大块（64 KiB）写入吞吐对比基线。
- replay：重连回放字节与缓冲内容逐字节一致；环形绕回 `dropped` 标记正确；会话关闭后
  replay 返回会话不存在错误。
- 两者均需前端（SerialConnectDialog/App.vue 接线）与 `docs/PROTOCOL.zh-CN.md` 契约同步，
  按 agent-flow 归 integrator/review 流程人工评审。
