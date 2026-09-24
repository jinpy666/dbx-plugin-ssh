# Spike：VNC 会话上游依赖尽调（对标差距项 2d，Task P2/VNC）

日期：2026-09-24　分支：`codex/ssh/parity-vnc`　结论：**Route A —— 上游 `vnc-rs 0.6` 可直接依赖，继续 Backend/Frontend MVP**。

## 1. 尽调对象

- crate：`vnc-rs`（crates.io 名称，lib 名 `vnc`），仓库 <https://github.com/HsuJv/vnc-rs>
- 版本：**0.6.0**，发布于 2026-09-21（三天前），License **MIT OR Apache-2.0**（crate 内含 `LICENSE-MIT`/`LICENSE-APACHE` 双文件；`src/client/security/des.rs` 为保留版权头的 tauri-rs MIT 移植代码）
- 对照基线：NyaTerm vendored fork `0.5.3 @ ab684d0`（`/Users/Jinpy/btroot/nyaterm/src-tauri/vendor/vnc-rs/VENDOR.md`）

## 2. API 面（0.6.0 实测，源码包逐文件核对）

```rust
VncConnector::new(tcp_stream)
    .set_auth_method(async move { Ok(password) })   // Result<String, VncError>，仅 VNC-Auth 时被消费
    .set_pixel_format(PixelFormat::rgba())          // RGBA8888（b,g,r,a → r 在低位字节序）
    .add_encoding(VncEncoding::Zrle)
    .add_encoding(VncEncoding::Raw)                 // RFB 强制兜底
    .allow_shared(true)
    .build()?                                       // → VncState
    .try_start().await?                             // 握手+认证（异步状态机）
    .finish()?                                      // → VncClient

VncClient::poll_event() -> Result<Option<VncEvent>>  // 非阻塞；输出通道容量仅 2
VncClient::input(X11Event)                           // Refresh / FullRefresh / KeyEvent / PointerEvent / CopyText
VncClient::close()
```

- **事件**：`SetResolution(Screen)`、`RawImage(Rect, Vec<u8>)`、`Copy`、`JpegImage`（仅 Tight）、`SetCursor`、`Bell`、`Text(String)`（剪贴板，Latin-1）、`Error(String)`、`DesktopUpdate`（0.6 新增）、`SetPixelFormat`。
- **输入**：`ClientKeyEvent { keycode: u32(keysym), down: bool }`、`ClientMouseEvent { position_x: u16, position_y: u16, bottons: u8 }`、`X11Event::CopyText(String)`。
- **版本协商**：RFB 3.3/3.7/3.8（`set_version` 可显式指定；未知版本按 RFC 回退 3.3 解释）。
- **帧更新驱动**：引擎只自动发首个全量请求；后续增量请求由应用按节拍发 `X11Event::Refresh`（NyaTerm 用 8ms 事件轮询 + 16ms 刷新间隔，本插件沿用）。
- **编码声明**：Raw / CopyRect / Tight / Trle / ZRLE + DesktopSize/LastRect/ExtendedDesktopSize/Cursor 伪编码。本插件只声明 **ZRLE + Raw**（+ DesktopSizePseudo）；不声明 Tight，服务端据此不应回 JPEG；若仍收到 `JpegImage`/`Copy`/`SetCursor` 事件按可读错误断开（NyaTerm 同款处理）。

## 3. 认证

- 支持 **None(1)** 与 **VNC-Auth(2)**（classic DES challenge，`security/des.rs`）；其余类型（RA2/TLS/VeNCrypt/SASL…）报 `Security type apart from Vnc Auth has not been implemented`——与本插件 MVP 范围一致。
- 密码 ≤8 字节是协议事实（AuthHelper 取前 8 字节做 DES key 位反转）；插件在 `vnc/start` 时校验超长即拒并提示。
- DES challenge 已知向量测试：上游未内置具体向量单测（其测试为握手失败/安全类型协商回归）。本插件在 backend 单测中用自实现同一 DES 算法不可取——改为对“密码→DES key 位反转”这一确定性行为做已知值校验（`"password"` 前 8 字节位反转结果），DES 加密本体信任上游。

## 4. 安全审查（对照 NyaTerm VENDOR.md 改了什么 → 0.6 是否已吸收）

| NyaTerm fork 加固点（0.5.3 基线） | 上游 0.6.0 状态 |
| --- | --- |
| 禁 unsafe | ✅ **已吸收**：全库 `grep unsafe` 为 0（0.5.3 有 6 处：tight.rs 3 处切片 transmute、auth.rs 2 处枚举 transmute、codec/mod.rs 1 处） |
| 网络可控 panic/UB → typed error | ✅ 已吸收：codec/auth 全部返回 `VncError`；网络路径无 `unwrap/panic/expect`（仅测试内） |
| 有界协议限制 | ✅ 已吸收：新增 `src/limits.rs`（crate 内部）——MAX_PIXELS=8,294,400（恰为 3840×2160）、MAX_DIMENSION=8192、MAX_COMPRESSED=64MiB、MAX_TEXT=1MiB（剪贴板）、MAX_NAME=4096；`limits::string` 在失败原因/桌面名等所有字符串读取处强制上限 |
| 显式安全类型选择策略（fail-closed `VncSecurityPolicy`） | ⚠️ **未吸收**：0.6 的选择逻辑固定为“服务端列表含 None 即选 None，否则 VncAuth，都无则报错”，没有强制 VncAuthOnly 的策略开关。影响：带密码连接一个同时广告 None+VncAuth 的服务端时不会发送密码（走 None 明文放行）。MVP 缓解：UI 常驻警示“仅支持经典认证，建议仅可信网络”；不构成阻断（NyaTerm 的策略枚举是 fork 私有 API） |
| 缩小队列容量 | ⚠️ 未吸收（上游 NETWORK/INPUT 通道 4096、OUTPUT=2）。影响可控：OUTPUT=2 意味着泵必须高频 poll（8ms tick），恰好对齐 NyaTerm 节奏；INPUT 4096 仅在恶意高频输入下积压，有界不放大 |
| 未知/未广告编码拒绝 | ✅ 已吸收：`from_wire` 未知编码返回 `InvalidImageData`（`From<u32>` 兜底 Raw 仅用于非 wire 场景，读 rect 用 `from_wire` 直接报错） |
| 确定性握手/解析回归测试 | ✅ 已吸收：`tests/authentication.rs`（duplex 模拟三版本×有无密码×失败状态）、`negotiation_tests`（未知安全类型跳过、失败原因限长）、`validation_tests`（像素格式掩码/位移校验）——命名与 NyaTerm fork 的回归测试一一对应，即 fork 的加固已上游化 |

**0.5.3 → 0.6.0 其他差异**：新增 `desktop.rs`（ExtendedDesktopSize 布局/协商 resize）、`client/resize.rs`（`resize_desktop`）、`codec/tests.rs`、`limits.rs`、`tests/` 目录；`PixelFormat` 增加严格校验（非零 max、位移重叠、true-color 掩码闭合）；认证失败不再等待对端 EOF（RFB3.8 失败原因限长读取）。

## 5. 依赖成本

- 直接依赖：`flate2`、`tracing`、`async_io_stream`、`futures`、`tokio-util 0.7(compat)`、`tokio-stream`、`tokio 1(full)`（非 wasm target）。全部为常见 crate，tokio 1/tracing/flate2 已在本仓库依赖树内或为事实标准。
- 与仓库现有 `zeroize` 配合：密码经 `Zeroizing<String>` 持有。

## 6. 插件层自补的加固点（Route A 的安全清单）

1. 帧缓冲上限收紧为 **3840×2160**（上游允许 8192²/8.3MP；插件 `VncFramebuffer::new` 拒绝超限，`SetResolution` 超限断开会话）。
2. 单 update rect payload 天然有界：RGBA 下单 patch ≤ 33,177,600 B < 64MB；patch 头 `payload_len: u32` + 校验 `stride == width*4`、矩形在帧缓冲内（复用 NyaTerm `encode_frame_patch` 的全部校验规则）。
3. 密码 ≤8 字节在 start 即拒（错误文案进七语）。
4. generation 计数防重连串话（帧/状态事件携带 sessionId，重连递增 generation，旧泵让位）。
5. 上游无 VncAuthOnly 强制策略（见 §4 ⚠️ 行）——文档与 UI 警示，作为遗留风险记录。

## 7. 结论

**Route A**：上游 0.6.0 已包含 NyaTerm fork 的全部结构性加固（零 unsafe、typed error、有界 limits、回归测试），不需要 fork 补丁。以常规依赖 `vnc-rs = "0.6"` 引入，插件层按 §6 补齐与任务契约一致的有界保护。
