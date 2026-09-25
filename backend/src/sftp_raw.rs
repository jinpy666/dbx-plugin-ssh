//! 最小顺序式 SFTP v3 裸包客户端（M14-B）：为「非 UTF-8 文件名」保住原始字节。
//!
//! 上游 `russh-sftp` 在反序列化层对文件名/handle 做 `from_utf8_lossy`，合法
//! UTF-8 服务器下字节往返无损，但 latin-1 等旧编码的文件名在列表阶段就丢失
//! 原始字节。本模块只覆盖字节保真必需的最小操作面（INIT/OPENDIR/READDIR/
//! CLOSE/STAT/LSTAT/OPEN/READ/CLOSE + M15-B 的 REMOVE/MKDIR/RMDIR/RENAME +
//! M16 的 OPEN 写/WRITE/SETSTAT/READLINK/SYMLINK，覆盖上传族/直写/touch/
//! symlink 的写路径），全部请求严格串行（发一收一），不与高层
//! `SftpSession` 共享通道。文件名字节原样返回，编码解释交给 `sftp_name`。
//!
//! 已知边界：attrs 只按 v3 布局解析（INIT 显式请求版本 3，RFC 要求服务器
//! 回应版本不高于请求值）；本模块不发起任何 extended 请求（兼容模式友好）。
//!
//! 真机回归（CI ssh-smoke run 36146663371）：MKDIR 的 wire 布局必须携带
//! ATTRS 字段（draft-ietf-secsh-filexfer-02 §5.2）——OpenSSH sftp-server
//! 对缺失 attrs 的 MKDIR 直接 fatal 退出，客户端侧表现为通道 EOF
//! （"SFTP raw read failed: early eof"）。测试模块的严格一致性桩
//! （`test_support::validate_request`）把这一语义搬进了离线回归。

use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// 单个 SFTP 包上限（readdir 批量 NAME 包可能较大；OpenSSH 上限 256 KiB，
/// 这里放宽到 4 MiB 防御非标准服务器）。
const MAX_PACKET_LEN: usize = 4 * 1024 * 1024;
/// READDIR 批次条目上限（防御恶意/异常服务器撑爆内存）。
const MAX_READDIR_ENTRIES: usize = 100_000;
/// 每个请求的等待上限，与高层会话的 10s 语义一致。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

// 包类型常量（draft-ietf-secsh-filexfer-02 §3）。
const FXP_INIT: u8 = 1;
const FXP_VERSION: u8 = 2;
const FXP_OPEN: u8 = 3;
const FXP_CLOSE: u8 = 4;
const FXP_READ: u8 = 5;
const FXP_WRITE: u8 = 6;
const FXP_LSTAT: u8 = 7;
const FXP_SETSTAT: u8 = 9;
const FXP_OPENDIR: u8 = 11;
const FXP_REMOVE: u8 = 13;
const FXP_MKDIR: u8 = 14;
const FXP_RMDIR: u8 = 15;
const FXP_READDIR: u8 = 16;
const FXP_STAT: u8 = 17;
const FXP_RENAME: u8 = 18;
const FXP_READLINK: u8 = 19;
const FXP_SYMLINK: u8 = 20;
const FXP_STATUS: u8 = 101;
const FXP_HANDLE: u8 = 102;
const FXP_DATA: u8 = 103;
const FXP_NAME: u8 = 104;
const FXP_ATTRS: u8 = 105;

// STATUS 错误码。
const SSH_FX_EOF: u32 = 1;
/// SSH_FX_NO_SUCH_FILE（draft-ietf-secsh-filexfer-02 §7）：`sftp_exists`
/// 等「存在性」语义只认这个码，其余错误必须如实上抛。
pub const SSH_FX_NO_SUCH_FILE: u32 = 2;

// ATTRS 标志位（v3）。
const ATTR_SIZE: u32 = 0x1;
const ATTR_UIDGID: u32 = 0x2;
const ATTR_PERMISSIONS: u32 = 0x4;
const ATTR_ACMODTIME: u32 = 0x8;
const ATTR_EXTENDED: u32 = 0x10;

// OPEN pflags。
const PFLAGS_READ: u32 = 0x1;
const PFLAGS_WRITE: u32 = 0x2;
const PFLAGS_CREAT: u32 = 0x8;
const PFLAGS_TRUNC: u32 = 0x10;

/// WRITE 单包数据上限：SFTPv3 规范建议 ≤32768 以保证最大兼容（OpenSSH 的
/// 包上限是 256 KiB，但旧服务器可能更小），调用方按此切分数据。
pub const MAX_WRITE_CHUNK: usize = 32 * 1024;

/// READ 单请求建议长度：与写侧同取 v3 规范建议的 32 KiB（`read_file` 的
/// 分块粒度；workbench 下载逐 chunk 的 256 KiB 是高层客户端语义，这里按
/// 裸包最大兼容口径）。
const READ_CHUNK: usize = 32 * 1024;

/// v3 attrs 的传输子集（列表/下载/写侧 SETSTAT 所需）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawAttrs {
    pub size: Option<u64>,
    pub permissions: Option<u32>,
    pub atime: Option<u32>,
    pub mtime: Option<u32>,
}

/// READDIR 单条目：文件名原始字节 + attrs。
#[derive(Debug, Clone)]
pub struct RawEntry {
    pub name: Vec<u8>,
    pub attrs: RawAttrs,
}

// ---------------------------------------------------------------------------
// 纯编解码（单测覆盖；async 客户端只在真机上验证）
// ---------------------------------------------------------------------------

/// 装帧一个包：`u32 BE 长度 + payload`。
pub fn frame_packet(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// 构造 INIT 请求（显式版本 3 + 空扩展表）。
pub fn build_init() -> Vec<u8> {
    let mut payload = vec![FXP_INIT];
    payload.extend_from_slice(&3_u32.to_be_bytes());
    frame_packet(&payload)
}

/// 构造带 id 的简单请求：`type + id + 字符串参数`（OPEN/OPENDIR/STAT 用）。
pub fn build_string_request(kind: u8, id: u32, path: &[u8]) -> Vec<u8> {
    let mut payload = vec![kind];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&(path.len() as u32).to_be_bytes());
    payload.extend_from_slice(path);
    frame_packet(&payload)
}

/// 构造 READDIR 请求。
pub fn build_readdir(id: u32, handle: &[u8]) -> Vec<u8> {
    build_string_request(FXP_READDIR, id, handle)
}

/// 构造 MKDIR 请求：`type + id + 路径字符串 + ATTRS`。draft-ietf-secsh-filexfer-02
/// §5.2 规定 MKDIR 的最后一个字段是 ATTRS——不可省略（OpenSSH sftp-server
/// 的 `process_mkdir` 对缺失 attrs 走 `fatal`，进程退出即通道 EOF）。
pub fn build_mkdir(id: u32, path: &[u8], attrs: &RawAttrs) -> Vec<u8> {
    let mut payload = vec![FXP_MKDIR];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&(path.len() as u32).to_be_bytes());
    payload.extend_from_slice(path);
    payload.extend_from_slice(&encode_attrs(attrs));
    frame_packet(&payload)
}

/// 构造 CLOSE 请求。
pub fn build_close(id: u32, handle: &[u8]) -> Vec<u8> {
    build_string_request(FXP_CLOSE, id, handle)
}

/// 构造 READ 请求（v3 无 seek：offset 显式携带）。
pub fn build_read(id: u32, handle: &[u8], offset: u64, len: u32) -> Vec<u8> {
    let mut payload = vec![FXP_READ];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&(handle.len() as u32).to_be_bytes());
    payload.extend_from_slice(handle);
    payload.extend_from_slice(&offset.to_be_bytes());
    payload.extend_from_slice(&len.to_be_bytes());
    frame_packet(&payload)
}

/// 构造 RENAME 请求（v3：oldpath + newpath 两个字符串，无 posix-rename 语义）。
pub fn build_rename(id: u32, old_path: &[u8], new_path: &[u8]) -> Vec<u8> {
    let mut payload = vec![FXP_RENAME];
    payload.extend_from_slice(&id.to_be_bytes());
    for path in [old_path, new_path] {
        payload.extend_from_slice(&(path.len() as u32).to_be_bytes());
        payload.extend_from_slice(path);
    }
    frame_packet(&payload)
}

/// 构造 OPEN 请求（写侧用：pflags + attrs 全量字段，attrs 为空即 flags=0）。
pub fn build_open(id: u32, path: &[u8], pflags: u32, attrs: &RawAttrs) -> Vec<u8> {
    let mut payload = vec![FXP_OPEN];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&(path.len() as u32).to_be_bytes());
    payload.extend_from_slice(path);
    payload.extend_from_slice(&pflags.to_be_bytes());
    payload.extend_from_slice(&encode_attrs(attrs));
    frame_packet(&payload)
}

/// 构造 WRITE 请求：`handle + offset + data`（data 长度上限见
/// [`MAX_WRITE_CHUNK`]，由调用方切分）。
pub fn build_write(id: u32, handle: &[u8], offset: u64, data: &[u8]) -> Vec<u8> {
    let mut payload = vec![FXP_WRITE];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&(handle.len() as u32).to_be_bytes());
    payload.extend_from_slice(handle);
    payload.extend_from_slice(&offset.to_be_bytes());
    payload.extend_from_slice(&(data.len() as u32).to_be_bytes());
    payload.extend_from_slice(data);
    frame_packet(&payload)
}

/// 构造 SETSTAT 请求：路径 + attrs（touch 的时间刷新、上传暂存的权限保留）。
pub fn build_setstat(id: u32, path: &[u8], attrs: &RawAttrs) -> Vec<u8> {
    let mut payload = vec![FXP_SETSTAT];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&(path.len() as u32).to_be_bytes());
    payload.extend_from_slice(path);
    payload.extend_from_slice(&encode_attrs(attrs));
    frame_packet(&payload)
}

/// 构造 READLINK 请求。
pub fn build_readlink(id: u32, path: &[u8]) -> Vec<u8> {
    build_string_request(FXP_READLINK, id, path)
}

/// 构造 SYMLINK 请求。v3 wire 上两个字符串的次序在 draft 与 OpenSSH 之间
/// 历史性颠倒：OpenSSH 服务器按 `target, linkpath` 读取（russh-sftp 高层
/// 靠调用方交换参数对齐，见 `sftp_ext::symlink_create` 的考证注释）。裸包
/// 直接按 OpenSSH 次序装包：第一个字符串是链接指向，第二个是链接路径。
pub fn build_symlink(id: u32, target: &[u8], link_path: &[u8]) -> Vec<u8> {
    let mut payload = vec![FXP_SYMLINK];
    payload.extend_from_slice(&id.to_be_bytes());
    for path in [target, link_path] {
        payload.extend_from_slice(&(path.len() as u32).to_be_bytes());
        payload.extend_from_slice(path);
    }
    frame_packet(&payload)
}

/// v3 attrs 解析；返回 (attrs, 消费字节数)。EXTENDED 扩展按长度跳过。
pub fn parse_attrs(buf: &[u8]) -> Result<(RawAttrs, usize), String> {
    let mut cursor = 0;
    let flags = read_u32(buf, &mut cursor)?;
    let mut attrs = RawAttrs::default();
    if flags & ATTR_SIZE != 0 {
        attrs.size = Some(read_u64(buf, &mut cursor)?);
    }
    if flags & ATTR_UIDGID != 0 {
        // uid/gid 对列表与下载无用，跳过。
        read_u32(buf, &mut cursor)?;
        read_u32(buf, &mut cursor)?;
    }
    if flags & ATTR_PERMISSIONS != 0 {
        attrs.permissions = Some(read_u32(buf, &mut cursor)?);
    }
    if flags & ATTR_ACMODTIME != 0 {
        attrs.atime = Some(read_u32(buf, &mut cursor)?);
        attrs.mtime = Some(read_u32(buf, &mut cursor)?);
    }
    if flags & ATTR_EXTENDED != 0 {
        let count = read_u32(buf, &mut cursor)?;
        for _ in 0..count {
            skip_string(buf, &mut cursor)?;
            skip_string(buf, &mut cursor)?;
        }
    }
    Ok((attrs, cursor))
}

/// v3 attrs 编码（[`parse_attrs`] 的逆）：只编码 Some 的字段；时间字段按
/// v3 固定为 atime+mtime 成对出现（缺省一侧按 0 补位）。
pub fn encode_attrs(attrs: &RawAttrs) -> Vec<u8> {
    let mut flags = 0_u32;
    if attrs.size.is_some() {
        flags |= ATTR_SIZE;
    }
    if attrs.permissions.is_some() {
        flags |= ATTR_PERMISSIONS;
    }
    if attrs.atime.is_some() || attrs.mtime.is_some() {
        flags |= ATTR_ACMODTIME;
    }
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(&flags.to_be_bytes());
    if let Some(size) = attrs.size {
        out.extend_from_slice(&size.to_be_bytes());
    }
    if let Some(permissions) = attrs.permissions {
        out.extend_from_slice(&permissions.to_be_bytes());
    }
    if flags & ATTR_ACMODTIME != 0 {
        out.extend_from_slice(&attrs.atime.unwrap_or(0).to_be_bytes());
        out.extend_from_slice(&attrs.mtime.unwrap_or(0).to_be_bytes());
    }
    out
}

/// 解包一个已去帧的响应：返回 (type, id_or_none, body)。
pub fn parse_response_header(payload: &[u8]) -> Result<(u8, Option<u32>, &[u8]), String> {
    if payload.is_empty() {
        return Err("SFTP raw response is empty".to_string());
    }
    let kind = payload[0];
    if kind == FXP_VERSION {
        return Ok((kind, None, &payload[1..]));
    }
    if payload.len() < 5 {
        return Err("SFTP raw response is truncated".to_string());
    }
    let id = u32::from_be_bytes(payload[1..5].try_into().unwrap());
    Ok((kind, Some(id), &payload[5..]))
}

/// 解析 NAME 包体：`count + 条目(name bytes, longname bytes, attrs)`。
pub fn parse_name_entries(body: &[u8]) -> Result<Vec<RawEntry>, String> {
    let mut cursor = 0;
    let count = read_u32(body, &mut cursor)?;
    if count as usize > MAX_READDIR_ENTRIES {
        return Err(format!("SFTP raw readdir batch too large: {count}"));
    }
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let name = read_string_bytes(body, &mut cursor)?;
        skip_string(body, &mut cursor)?; // longname
        let (attrs, consumed) = parse_attrs(&body[cursor..])?;
        cursor += consumed;
        entries.push(RawEntry { name, attrs });
    }
    Ok(entries)
}

/// 解析 STATUS 包体：`code (+ lang/tag 字符串，容错缺省)`。
pub fn parse_status_code(body: &[u8]) -> Result<u32, String> {
    let mut cursor = 0;
    read_u32(body, &mut cursor)
}

/// 解析 HANDLE 包体：handle 原始字节。
pub fn parse_handle(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0;
    read_string_bytes(body, &mut cursor)
}

/// 解析 DATA 包体：数据字节。
pub fn parse_data(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0;
    read_string_bytes(body, &mut cursor)
}

/// 解析 ATTRS 包体。
pub fn parse_attrs_packet(body: &[u8]) -> Result<RawAttrs, String> {
    let (attrs, _) = parse_attrs(body)?;
    Ok(attrs)
}

/// 从裸包客户端的错误串里提取 STATUS 码（错误串形如
/// `"SFTP raw lstat failed with status 2"`）：调用方据此区分
/// [`SSH_FX_NO_SUCH_FILE`]（存在性语义）与其他失败。非错误串/无码返回 None。
pub fn error_status(error: &str) -> Option<u32> {
    error
        .rsplit_once("status ")
        .and_then(|(_, tail)| tail.trim().parse().ok())
}

fn read_u32(buf: &[u8], cursor: &mut usize) -> Result<u32, String> {
    if buf.len() < *cursor + 4 {
        return Err("SFTP raw packet is truncated".to_string());
    }
    let value = u32::from_be_bytes(buf[*cursor..*cursor + 4].try_into().unwrap());
    *cursor += 4;
    Ok(value)
}

fn read_u64(buf: &[u8], cursor: &mut usize) -> Result<u64, String> {
    if buf.len() < *cursor + 8 {
        return Err("SFTP raw packet is truncated".to_string());
    }
    let value = u64::from_be_bytes(buf[*cursor..*cursor + 8].try_into().unwrap());
    *cursor += 8;
    Ok(value)
}

fn read_string_bytes(buf: &[u8], cursor: &mut usize) -> Result<Vec<u8>, String> {
    let len = read_u32(buf, cursor)? as usize;
    if buf.len() < *cursor + len {
        return Err("SFTP raw packet is truncated".to_string());
    }
    let value = buf[*cursor..*cursor + len].to_vec();
    *cursor += len;
    Ok(value)
}

fn skip_string(buf: &[u8], cursor: &mut usize) -> Result<(), String> {
    read_string_bytes(buf, cursor).map(|_| ())
}

// ---------------------------------------------------------------------------
// 顺序式客户端
// ---------------------------------------------------------------------------

/// 顺序式裸包客户端：持有一条已请求 `sftp` 子系统的通道流。
pub struct RawSftp<S> {
    stream: S,
    next_id: u32,
}

impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin> RawSftp<S> {
    /// 握手：发送 INIT（版本 3）并校验 VERSION 回包。服务器版本高于 3 拒绝
    /// （v4+ attrs 布局不同，宁可拒绝也不静默解错）。
    pub async fn init(stream: S) -> Result<Self, String> {
        let mut client = Self { stream, next_id: 1 };
        client.send(&build_init()).await?;
        let payload = tokio::time::timeout(REQUEST_TIMEOUT, client.recv())
            .await
            .map_err(|_| "SFTP raw init timed out".to_string())??;
        let (kind, _, body) = parse_response_header(&payload)?;
        if kind != FXP_VERSION {
            return Err("SFTP raw handshake got a non-VERSION reply".to_string());
        }
        if body.len() < 4 {
            return Err("SFTP raw VERSION reply is truncated".to_string());
        }
        let version = u32::from_be_bytes(body[..4].try_into().unwrap());
        if version > 3 {
            return Err(format!(
                "SFTP raw client does not support server version {version}"
            ));
        }
        Ok(client)
    }

    /// 列目录：OPENDIR → READDIR 循环（STATUS EOF 收尾）→ CLOSE。
    /// 文件名以原始字节返回，解码交给调用方（sftp_name）。
    pub async fn readdir(&mut self, path: &[u8]) -> Result<Vec<RawEntry>, String> {
        let handle = self.opendir(path).await?;
        let mut entries = Vec::new();
        loop {
            let id = self.next_id();
            let reply = self.request(build_readdir(id, &handle), id).await?;
            let (kind, _, body) = parse_response_header(&reply)?;
            match kind {
                FXP_NAME => {
                    let batch = parse_name_entries(body)?;
                    let overflow = entries.len() + batch.len() > MAX_READDIR_ENTRIES;
                    entries.extend(batch);
                    if overflow {
                        let _ = self.close(&handle).await;
                        return Err(format!(
                            "SFTP raw readdir exceeded {MAX_READDIR_ENTRIES} entries"
                        ));
                    }
                }
                FXP_STATUS => {
                    let code = parse_status_code(body)?;
                    if code == SSH_FX_EOF {
                        break;
                    }
                    let _ = self.close(&handle).await;
                    return Err(format!("SFTP raw readdir failed with status {code}"));
                }
                _ => {
                    let _ = self.close(&handle).await;
                    return Err("SFTP raw readdir got an unexpected reply".to_string());
                }
            }
        }
        self.close(&handle).await?;
        Ok(entries)
    }

    /// STAT：单个路径的 attrs。
    pub async fn stat(&mut self, path: &[u8]) -> Result<RawAttrs, String> {
        let id = self.next_id();
        let reply = self
            .request(build_string_request(FXP_STAT, id, path), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_ATTRS => parse_attrs_packet(body),
            FXP_STATUS => Err(format!(
                "SFTP raw stat failed with status {}",
                parse_status_code(body)?
            )),
            _ => Err("SFTP raw stat got an unexpected reply".to_string()),
        }
    }

    /// 读一段数据：OPEN(READ) → READ(offset) → CLOSE。短读合法（调用方按
    /// 实际长度推进 offset）；EOF 返回空 Vec。
    pub async fn read_chunk(
        &mut self,
        path: &[u8],
        offset: u64,
        len: u32,
    ) -> Result<Vec<u8>, String> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let handle = self
            .open_handle(path, PFLAGS_READ, &RawAttrs::default())
            .await?;
        let result = async {
            let id = self.next_id();
            let reply = self
                .request(build_read(id, &handle, offset, len), id)
                .await?;
            let (kind, _, body) = parse_response_header(&reply)?;
            match kind {
                FXP_DATA => parse_data(body),
                FXP_STATUS => {
                    let code = parse_status_code(body)?;
                    if code == SSH_FX_EOF {
                        Ok(Vec::new())
                    } else {
                        Err(format!("SFTP raw read failed with status {code}"))
                    }
                }
                _ => Err("SFTP raw read got an unexpected reply".to_string()),
            }
        }
        .await;
        self.close(&handle).await?;
        result
    }

    /// 读整个文件（M18，MCP `sftp_read_file` 用）：OPEN(READ) 一次，READ 按
    /// [`READ_CHUNK`] 分块循环（offset 显式推进，STATUS EOF / 空 DATA 收尾），
    /// 最后 CLOSE。至多读 `cap` 字节（调用方用 `max_bytes + 1` 探测截断），
    /// `offset` 支持 TCP 式分页起点；offset 在/超过 EOF 时回空 Vec。
    pub async fn read_file(
        &mut self,
        path: &[u8],
        offset: u64,
        cap: u64,
    ) -> Result<Vec<u8>, String> {
        let handle = self
            .open_handle(path, PFLAGS_READ, &RawAttrs::default())
            .await?;
        let result = async {
            let mut data = Vec::new();
            let mut position = offset;
            while (data.len() as u64) < cap {
                let requested = (cap - data.len() as u64).min(READ_CHUNK as u64) as u32;
                let id = self.next_id();
                let reply = self
                    .request(build_read(id, &handle, position, requested), id)
                    .await?;
                let (kind, _, body) = parse_response_header(&reply)?;
                let chunk = match kind {
                    FXP_DATA => parse_data(body)?,
                    FXP_STATUS => {
                        let code = parse_status_code(body)?;
                        if code == SSH_FX_EOF {
                            break;
                        }
                        return Err(format!("SFTP raw read failed with status {code}"));
                    }
                    _ => return Err("SFTP raw read got an unexpected reply".to_string()),
                };
                if chunk.is_empty() {
                    break;
                }
                position += chunk.len() as u64;
                data.extend_from_slice(&chunk);
            }
            Ok(data)
        }
        .await;
        self.close(&handle).await?;
        result
    }

    /// LSTAT：单个路径的 attrs（不跟随符号链接，DELETE 预检语义与高层
    /// `symlink_metadata` 一致）。
    pub async fn lstat(&mut self, path: &[u8]) -> Result<RawAttrs, String> {
        let id = self.next_id();
        let reply = self
            .request(build_string_request(FXP_LSTAT, id, path), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_ATTRS => parse_attrs_packet(body),
            FXP_STATUS => Err(format!(
                "SFTP raw lstat failed with status {}",
                parse_status_code(body)?
            )),
            _ => Err("SFTP raw lstat got an unexpected reply".to_string()),
        }
    }

    /// REMOVE：删除一个文件（或符号链接）。
    pub async fn remove(&mut self, path: &[u8]) -> Result<(), String> {
        let id = self.next_id();
        let reply = self
            .request(build_string_request(FXP_REMOVE, id, path), id)
            .await?;
        self.expect_status_ok(&reply, "remove").await
    }

    /// 打开一个可写句柄：OPEN(CREAT|WRITE|TRUNC) → HANDLE。上传族/直写的
    /// 暂存文件与 touch 的新建分支都走这里；数据用 [`Self::write_chunk`]
    /// 写入，最后必须 [`Self::close`]。
    pub async fn open_write(&mut self, path: &[u8]) -> Result<Vec<u8>, String> {
        let pflags = PFLAGS_WRITE | PFLAGS_CREAT | PFLAGS_TRUNC;
        self.open_handle(path, pflags, &RawAttrs::default()).await
    }

    /// 写一段数据到句柄：WRITE(handle, offset, data) → STATUS 0。单段长度
    /// 不得超过 [`MAX_WRITE_CHUNK`]（由调用方切分）。
    pub async fn write_chunk(
        &mut self,
        handle: &[u8],
        offset: u64,
        data: &[u8],
    ) -> Result<(), String> {
        if data.len() > MAX_WRITE_CHUNK {
            return Err(format!(
                "SFTP raw write chunk too large: {} > {MAX_WRITE_CHUNK}",
                data.len()
            ));
        }
        let id = self.next_id();
        let reply = self
            .request(build_write(id, handle, offset, data), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_STATUS => {
                let code = parse_status_code(body)?;
                if code == 0 {
                    return Ok(());
                }
                Err(format!("SFTP raw write failed with status {code}"))
            }
            _ => Err("SFTP raw write got an unexpected reply".to_string()),
        }
    }

    /// SETSTAT：按 attrs 子集改写路径属性（touch 的 utime 语义、上传提交的
    /// 权限保留）。服务器拒绝/不支持时返回 Err，由调用方决定是否容忍。
    pub async fn setstat(&mut self, path: &[u8], attrs: &RawAttrs) -> Result<(), String> {
        let id = self.next_id();
        let reply = self.request(build_setstat(id, path, attrs), id).await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_STATUS => {
                let code = parse_status_code(body)?;
                if code == 0 {
                    return Ok(());
                }
                Err(format!("SFTP raw setstat failed with status {code}"))
            }
            _ => Err("SFTP raw setstat got an unexpected reply".to_string()),
        }
    }

    /// READLINK：返回链接指向的原始字节（NAME 包第一条目的文件名字段）。
    pub async fn readlink(&mut self, path: &[u8]) -> Result<Vec<u8>, String> {
        let id = self.next_id();
        let reply = self.request(build_readlink(id, path), id).await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_NAME => {
                let entries = parse_name_entries(body)?;
                entries
                    .into_iter()
                    .next()
                    .map(|entry| entry.name)
                    .ok_or_else(|| "SFTP raw readlink got an empty NAME reply".to_string())
            }
            FXP_STATUS => Err(format!(
                "SFTP raw readlink failed with status {}",
                parse_status_code(body)?
            )),
            _ => Err("SFTP raw readlink got an unexpected reply".to_string()),
        }
    }

    /// SYMLINK：创建 `link_path` → `target`。字符串按 OpenSSH 次序装包
    /// （见 [`build_symlink`]），与高层 `symlink(target, link_path)` 的
    /// 生产行为一致。
    pub async fn symlink(&mut self, target: &[u8], link_path: &[u8]) -> Result<(), String> {
        let id = self.next_id();
        let reply = self
            .request(build_symlink(id, target, link_path), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_STATUS => {
                let code = parse_status_code(body)?;
                if code == 0 {
                    return Ok(());
                }
                Err(format!("SFTP raw symlink failed with status {code}"))
            }
            _ => Err("SFTP raw symlink got an unexpected reply".to_string()),
        }
    }

    /// MKDIR：创建目录。v3 wire 上 MKDIR 必须携带 ATTRS 字段
    /// （draft-ietf-secsh-filexfer-02 §5.2）；缺该字段时 OpenSSH 的
    /// sftp-server 在 `decode_attrib` 处 fatal 退出（通道 EOF，CI smoke 的
    /// "SFTP raw read failed: early eof" 即此根因）。空 attrs（flags=0）时
    /// OpenSSH 按 0777 & umask 建目录，与高层客户端缺省行为一致。
    pub async fn mkdir(&mut self, path: &[u8]) -> Result<(), String> {
        let id = self.next_id();
        let reply = self
            .request(build_mkdir(id, path, &RawAttrs::default()), id)
            .await?;
        self.expect_status_ok(&reply, "mkdir").await
    }

    /// RMDIR：删除空目录。
    pub async fn rmdir(&mut self, path: &[u8]) -> Result<(), String> {
        let id = self.next_id();
        let reply = self
            .request(build_string_request(FXP_RMDIR, id, path), id)
            .await?;
        self.expect_status_ok(&reply, "rmdir").await
    }

    /// RENAME：单个路径重命名/移动（SFTPv3 不覆盖已存在目标）。
    pub async fn rename(&mut self, old_path: &[u8], new_path: &[u8]) -> Result<(), String> {
        let id = self.next_id();
        let reply = self
            .request(build_rename(id, old_path, new_path), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_STATUS => {
                let code = parse_status_code(body)?;
                if code == 0 {
                    return Ok(());
                }
                Err(format!("SFTP raw rename failed with status {code}"))
            }
            _ => Err("SFTP raw rename got an unexpected reply".to_string()),
        }
    }

    /// 「STATUS 回包 → 0 即成功」的公共骨架（REMOVE/MKDIR/RMDIR）。
    async fn expect_status_ok(&mut self, reply: &[u8], op: &str) -> Result<(), String> {
        let (reply_kind, _, body) = parse_response_header(reply)?;
        match reply_kind {
            FXP_STATUS => {
                let code = parse_status_code(body)?;
                if code == 0 {
                    return Ok(());
                }
                Err(format!("SFTP raw {op} failed with status {code}"))
            }
            _ => Err(format!("SFTP raw {op} got an unexpected reply")),
        }
    }

    async fn opendir(&mut self, path: &[u8]) -> Result<Vec<u8>, String> {
        let id = self.next_id();
        let reply = self
            .request(build_string_request(FXP_OPENDIR, id, path), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_HANDLE => parse_handle(body),
            FXP_STATUS => Err(format!(
                "SFTP raw opendir failed with status {}",
                parse_status_code(body)?
            )),
            _ => Err("SFTP raw opendir got an unexpected reply".to_string()),
        }
    }

    /// CLOSE：释放句柄（open_write/open 的收尾；STATUS 0 或 EOF 均视为成功）。
    pub async fn close(&mut self, handle: &[u8]) -> Result<(), String> {
        let id = self.next_id();
        let reply = self.request(build_close(id, handle), id).await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        if kind == FXP_STATUS {
            let code = parse_status_code(body)?;
            if code == 0 || code == SSH_FX_EOF {
                return Ok(());
            }
            return Err(format!("SFTP raw close failed with status {code}"));
        }
        Err("SFTP raw close got an unexpected reply".to_string())
    }

    /// OPEN 的公共骨架：任意 pflags + attrs → HANDLE。
    async fn open_handle(
        &mut self,
        path: &[u8],
        pflags: u32,
        attrs: &RawAttrs,
    ) -> Result<Vec<u8>, String> {
        let id = self.next_id();
        let reply = self
            .request(build_open(id, path, pflags, attrs), id)
            .await?;
        let (kind, _, body) = parse_response_header(&reply)?;
        match kind {
            FXP_HANDLE => parse_handle(body),
            FXP_STATUS => Err(format!(
                "SFTP raw open failed with status {}",
                parse_status_code(body)?
            )),
            _ => Err("SFTP raw open got an unexpected reply".to_string()),
        }
    }

    /// 发一收一：发送帧后读取响应帧，校验回包 id 匹配。
    async fn request(&mut self, frame: Vec<u8>, id: u32) -> Result<Vec<u8>, String> {
        self.send(&frame).await?;
        let payload = tokio::time::timeout(REQUEST_TIMEOUT, self.recv())
            .await
            .map_err(|_| "SFTP raw request timed out".to_string())??;
        let (_, reply_id, _) = parse_response_header(&payload)?;
        if reply_id != Some(id) {
            return Err("SFTP raw reply id mismatch".to_string());
        }
        Ok(payload)
    }

    fn next_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        id
    }

    async fn send(&mut self, frame: &[u8]) -> Result<(), String> {
        self.stream
            .write_all(frame)
            .await
            .map_err(|error| format!("SFTP raw write failed: {error}"))?;
        self.stream
            .flush()
            .await
            .map_err(|error| format!("SFTP raw flush failed: {error}"))
    }

    async fn recv(&mut self) -> Result<Vec<u8>, String> {
        let mut length = [0_u8; 4];
        self.stream
            .read_exact(&mut length)
            .await
            .map_err(|error| format!("SFTP raw read failed: {error}"))?;
        let len = u32::from_be_bytes(length) as usize;
        if len == 0 || len > MAX_PACKET_LEN {
            return Err(format!("SFTP raw packet length out of range: {len}"));
        }
        let mut payload = vec![0_u8; len];
        self.stream
            .read_exact(&mut payload)
            .await
            .map_err(|error| format!("SFTP raw read failed: {error}"))?;
        Ok(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_carry_big_endian_length() {
        assert_eq!(frame_packet(&[1, 2, 3]), vec![0, 0, 0, 3, 1, 2, 3]);
        assert_eq!(frame_packet(&[]), vec![0, 0, 0, 0]);
    }

    #[test]
    fn init_requests_version_three() {
        let frame = build_init();
        assert_eq!(&frame[..4], &[0, 0, 0, 5]);
        assert_eq!(&frame[4..], &[FXP_INIT, 0, 0, 0, 3]);
    }

    #[test]
    fn string_requests_carry_type_id_and_path_bytes() {
        let frame = build_string_request(FXP_STAT, 7, b"/tmp");
        // type + id + len + path
        assert_eq!(frame.len(), 4 + 1 + 4 + 4 + 4);
        assert_eq!(frame[4], FXP_STAT);
        assert_eq!(&frame[5..9], &7_u32.to_be_bytes());
        assert_eq!(&frame[9..13], &4_u32.to_be_bytes());
        assert_eq!(&frame[13..], b"/tmp");
        let frame = build_close(1, b"h");
        assert_eq!(frame[4], FXP_CLOSE);
        let frame = build_readdir(2, b"h");
        assert_eq!(frame[4], FXP_READDIR);
        let frame = build_read(3, b"h", 9, 100);
        assert_eq!(frame[4], FXP_READ);
        // type + id + handle len + handle 之后才是 offset/len。
        assert_eq!(&frame[14..22], &9_u64.to_be_bytes());
        assert_eq!(&frame[22..26], &100_u32.to_be_bytes());
    }

    #[test]
    fn response_header_splits_type_and_id() {
        let payload = [FXP_HANDLE, 0, 0, 0, 9, 1, b'h'];
        let (kind, id, body) = parse_response_header(&payload).unwrap();
        assert_eq!(kind, FXP_HANDLE);
        assert_eq!(id, Some(9));
        assert_eq!(body, &[1, b'h']);
        // VERSION 无 id。
        let payload = [FXP_VERSION, 0, 0, 0, 3];
        let (kind, id, body) = parse_response_header(&payload).unwrap();
        assert_eq!(kind, FXP_VERSION);
        assert_eq!(id, None);
        assert_eq!(body, &[0, 0, 0, 3]);
        assert!(parse_response_header(&[]).is_err());
        assert!(parse_response_header(&[FXP_STATUS, 0, 0]).is_err());
    }

    #[test]
    fn attrs_decode_v3_layouts() {
        // flags=0：空 attrs。
        let (attrs, used) = parse_attrs(&0_u32.to_be_bytes()).unwrap();
        assert_eq!(attrs, RawAttrs::default());
        assert_eq!(used, 4);
        // size + permissions + acmodtime + 扩展跳过。
        let mut buf = Vec::new();
        let flags = ATTR_SIZE | ATTR_PERMISSIONS | ATTR_ACMODTIME | ATTR_EXTENDED;
        buf.extend_from_slice(&flags.to_be_bytes());
        buf.extend_from_slice(&4096_u64.to_be_bytes());
        buf.extend_from_slice(&0o100644_u32.to_be_bytes());
        buf.extend_from_slice(&100_u32.to_be_bytes()); // atime
        buf.extend_from_slice(&200_u32.to_be_bytes()); // mtime
        buf.extend_from_slice(&1_u32.to_be_bytes()); // 扩展数
        buf.extend_from_slice(&2_u32.to_be_bytes());
        buf.extend_from_slice(b"ex");
        buf.extend_from_slice(&1_u32.to_be_bytes());
        buf.extend_from_slice(b"v");
        let (attrs, used) = parse_attrs(&buf).unwrap();
        assert_eq!(attrs.size, Some(4096));
        assert_eq!(attrs.permissions, Some(0o100644));
        assert_eq!(attrs.mtime, Some(200));
        assert_eq!(used, buf.len());
        // uid/gid 跳过不影响后续字段（v3 字段顺序固定：size 先于 uid/gid）。
        let mut buf = Vec::new();
        buf.extend_from_slice(&(ATTR_UIDGID | ATTR_SIZE).to_be_bytes());
        buf.extend_from_slice(&7_u64.to_be_bytes());
        buf.extend_from_slice(&1000_u32.to_be_bytes());
        buf.extend_from_slice(&1000_u32.to_be_bytes());
        let (attrs, _) = parse_attrs(&buf).unwrap();
        assert_eq!(attrs.size, Some(7));
        // 截断拒绝。
        assert!(parse_attrs(&(ATTR_SIZE | ATTR_UIDGID).to_be_bytes()).is_err());
    }

    #[test]
    fn name_entries_decode_raw_filename_bytes() {
        // 两个条目：latin-1 "caf\xe9" 与 UTF-8 "生产"。
        let mut body = Vec::new();
        body.extend_from_slice(&2_u32.to_be_bytes());
        body.extend_from_slice(&4_u32.to_be_bytes());
        body.extend_from_slice(b"caf\xe9");
        body.extend_from_slice(&0_u32.to_be_bytes()); // longname 空
        body.extend_from_slice(&ATTR_SIZE.to_be_bytes());
        body.extend_from_slice(&12_u64.to_be_bytes());
        body.extend_from_slice(&6_u32.to_be_bytes());
        body.extend_from_slice("生产".as_bytes());
        body.extend_from_slice(&0_u32.to_be_bytes());
        body.extend_from_slice(&ATTR_SIZE.to_be_bytes());
        body.extend_from_slice(&24_u64.to_be_bytes());
        let entries = parse_name_entries(&body).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, b"caf\xe9".to_vec());
        assert_eq!(entries[0].attrs.size, Some(12));
        assert_eq!(entries[1].name, "生产".as_bytes().to_vec());
        assert_eq!(entries[1].attrs.size, Some(24));
        // 截断拒绝。
        assert!(parse_name_entries(&2_u32.to_be_bytes()).is_err());
    }

    #[test]
    fn status_handle_data_packets_parse() {
        assert_eq!(
            parse_status_code(&SSH_FX_EOF.to_be_bytes()).unwrap(),
            SSH_FX_EOF
        );
        assert_eq!(parse_handle(&[0, 0, 0, 1, b'h']).unwrap(), b"h".to_vec());
        let mut data = 3_u32.to_be_bytes().to_vec();
        data.extend_from_slice(b"abc");
        assert_eq!(parse_data(&data).unwrap(), b"abc".to_vec());
    }

    #[test]
    fn rename_requests_carry_both_path_strings() {
        let frame = build_rename(9, b"/old\xE9", b"/new");
        // type + id + (len + path) * 2
        assert_eq!(frame.len(), 4 + 1 + 4 + 4 + 5 + 4 + 4);
        assert_eq!(frame[4], FXP_RENAME);
        assert_eq!(&frame[5..9], &9_u32.to_be_bytes());
        assert_eq!(&frame[9..13], &5_u32.to_be_bytes());
        assert_eq!(&frame[13..18], b"/old\xE9");
        assert_eq!(&frame[18..22], &4_u32.to_be_bytes());
        assert_eq!(&frame[22..], b"/new");
    }

    #[test]
    fn encode_attrs_round_trips_the_parsed_subset() {
        // 空 attrs。
        assert_eq!(encode_attrs(&RawAttrs::default()), 0_u32.to_be_bytes());
        // 权限保留（上传提交）：只编码 permissions。
        let attrs = RawAttrs {
            permissions: Some(0o644 & 0o7777),
            ..RawAttrs::default()
        };
        let mut expected = (ATTR_PERMISSIONS).to_be_bytes().to_vec();
        expected.extend_from_slice(&0o644_u32.to_be_bytes());
        assert_eq!(encode_attrs(&attrs), expected);
        // touch 的 utimes 语义：atime/mtime 成对编码。
        let attrs = RawAttrs {
            atime: Some(100),
            mtime: Some(200),
            ..RawAttrs::default()
        };
        let mut expected = ATTR_ACMODTIME.to_be_bytes().to_vec();
        expected.extend_from_slice(&100_u32.to_be_bytes());
        expected.extend_from_slice(&200_u32.to_be_bytes());
        assert_eq!(encode_attrs(&attrs), expected);
        // 解析↔编码在全部字段上闭环。
        let mut buf = Vec::new();
        let flags = ATTR_SIZE | ATTR_PERMISSIONS | ATTR_ACMODTIME;
        buf.extend_from_slice(&flags.to_be_bytes());
        buf.extend_from_slice(&9_u64.to_be_bytes());
        buf.extend_from_slice(&0o100755_u32.to_be_bytes());
        buf.extend_from_slice(&11_u32.to_be_bytes());
        buf.extend_from_slice(&22_u32.to_be_bytes());
        let (attrs, _) = parse_attrs(&buf).unwrap();
        assert_eq!(attrs.size, Some(9));
        assert_eq!(attrs.permissions, Some(0o100755));
        assert_eq!(attrs.atime, Some(11));
        assert_eq!(attrs.mtime, Some(22));
        assert_eq!(encode_attrs(&attrs), buf);
    }

    #[test]
    fn write_side_packet_builders_carry_expected_layouts() {
        // OPEN：type + id + len+path + pflags + attrs(flags=0)。
        let frame = build_open(
            5,
            b"/up/a\xE9.bin",
            PFLAGS_WRITE | PFLAGS_CREAT | PFLAGS_TRUNC,
            &RawAttrs::default(),
        );
        assert_eq!(frame[4], FXP_OPEN);
        assert_eq!(&frame[5..9], &5_u32.to_be_bytes());
        let path_len = 10_u32.to_be_bytes();
        assert_eq!(&frame[9..13], &path_len);
        assert_eq!(&frame[13..23], b"/up/a\xE9.bin");
        let pflags = (PFLAGS_WRITE | PFLAGS_CREAT | PFLAGS_TRUNC).to_be_bytes();
        assert_eq!(&frame[23..27], &pflags);
        assert_eq!(&frame[27..], &0_u32.to_be_bytes()); // 空 attrs
                                                        // WRITE：type + id + len+handle + offset + len+data。
        let frame = build_write(6, b"h1", 4096, b"abc");
        assert_eq!(frame[4], FXP_WRITE);
        assert_eq!(&frame[9..13], &2_u32.to_be_bytes());
        assert_eq!(&frame[13..15], b"h1");
        assert_eq!(&frame[15..23], &4096_u64.to_be_bytes());
        assert_eq!(&frame[23..27], &3_u32.to_be_bytes());
        assert_eq!(&frame[27..], b"abc");
        // SETSTAT：type + id + len+path + attrs。
        let frame = build_setstat(
            7,
            b"/tmp/f",
            &RawAttrs {
                permissions: Some(0o600),
                ..RawAttrs::default()
            },
        );
        assert_eq!(frame[4], FXP_SETSTAT);
        assert_eq!(&frame[9..13], &6_u32.to_be_bytes());
        assert_eq!(&frame[19..23], &ATTR_PERMISSIONS.to_be_bytes());
        assert_eq!(&frame[23..], &0o600_u32.to_be_bytes());
        // READLINK 复用字符串请求骨架。
        let frame = build_readlink(8, b"/lnk");
        assert_eq!(frame[4], FXP_READLINK);
        // SYMLINK：OpenSSH 次序，第一个字符串是 target。
        let frame = build_symlink(9, b"tgt\xE9", b"/lnk");
        assert_eq!(frame[4], FXP_SYMLINK);
        assert_eq!(&frame[9..13], &4_u32.to_be_bytes());
        assert_eq!(&frame[13..17], b"tgt\xE9");
        assert_eq!(&frame[17..21], &4_u32.to_be_bytes());
        assert_eq!(&frame[21..], b"/lnk");
    }

    /// 内存双工流的桩服务器：INIT 回 VERSION，随后每个请求按脚本回预置
    /// 包体（自动回填请求帧里的 id）。纯内存往返，不连 SSH。
    /// 脚本包体格式：`[type, id 占位 4 字节, 剩余包体]`。
    async fn scripted_server(stream: tokio::io::DuplexStream, replies: Vec<Vec<u8>>) {
        test_support::scripted_server(stream, replies, None).await
    }

    fn status_body(code: u32) -> Vec<u8> {
        test_support::status_body(code)
    }

    fn attrs_body(size: u64, permissions: u32) -> Vec<u8> {
        test_support::attrs_body(size, permissions)
    }

    fn handle_body(value: &[u8]) -> Vec<u8> {
        test_support::handle_body(value)
    }

    fn data_body(data: &[u8]) -> Vec<u8> {
        test_support::data_body(data)
    }

    /// NAME 单条目回包（READLINK 用）：name + 空 longname + 空 attrs。
    fn name_body_one(name: &[u8]) -> Vec<u8> {
        test_support::name_body_one(name)
    }

    #[tokio::test]
    async fn write_ops_round_trip_through_scripted_replies() {
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(scripted_server(
            server_side,
            vec![
                handle_body(b"h1"),        // open_write → HANDLE
                status_body(0),            // write → ok
                status_body(0),            // close → ok
                status_body(0),            // setstat → ok
                name_body_one(b"tgt\xE9"), // readlink → NAME
                status_body(2),            // symlink → 失败
            ],
        ));
        let mut client = RawSftp::init(client_side).await.unwrap();
        let handle = client.open_write(b"/up/a\xE9.bin").await.unwrap();
        assert_eq!(handle, b"h1".to_vec());
        client.write_chunk(&handle, 0, b"data").await.unwrap();
        client.close(&handle).await.unwrap();
        client
            .setstat(
                b"/up/a\xE9.bin",
                &RawAttrs {
                    permissions: Some(0o600),
                    ..RawAttrs::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(client.readlink(b"/lnk").await.unwrap(), b"tgt\xE9".to_vec());
        let error = client.symlink(b"tgt", b"/lnk2").await.unwrap_err();
        assert!(error.contains("status 2"), "{error}");
        // WRITE 单包超限在客户端侧直接拒绝（不发出请求）。
        let oversized = vec![0_u8; MAX_WRITE_CHUNK + 1];
        assert!(client.write_chunk(b"h", 0, &oversized).await.is_err());
    }

    #[tokio::test]
    async fn write_ops_pair_requests_with_scripted_replies() {
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(scripted_server(
            server_side,
            vec![
                status_body(0),          // mkdir ok
                status_body(11),         // remove failed (SSH_FX_FAILURE-ish)
                attrs_body(7, 0o040755), // lstat → 目录
                status_body(0),          // rmdir ok
                status_body(0),          // rename ok
            ],
        ));
        let mut client = RawSftp::init(client_side).await.unwrap();

        client.mkdir(b"/a/b").await.unwrap();
        let error = client.remove(b"/a/b/\xE9.txt").await.unwrap_err();
        assert!(error.contains("status 11"), "{error}");
        let attrs = client.lstat(b"/a/b").await.unwrap();
        assert_eq!(attrs.size, Some(7));
        assert_eq!(attrs.permissions, Some(0o040755));
        client.rmdir(b"/a/b").await.unwrap();
        client.rename(b"/old\xE9", b"/new").await.unwrap();
    }

    #[tokio::test]
    async fn unexpected_replies_surface_as_errors() {
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(scripted_server(
            server_side,
            vec![attrs_body(1, 0o100644)], // remove 收到 ATTRS → 异常回包
        ));
        let mut client = RawSftp::init(client_side).await.unwrap();
        let error = client.remove(b"/a").await.unwrap_err();
        assert!(error.contains("unexpected reply"), "{error}");
    }

    #[tokio::test]
    async fn read_file_loops_reads_until_cap_and_sends_raw_path_bytes() {
        let requests = test_support::request_log();
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(test_support::scripted_server(
            server_side,
            vec![
                handle_body(b"h1"), // OPEN(READ)
                data_body(b"ab"),   // READ#1
                data_body(b"cde"),  // READ#2 → 累计达到 cap
                status_body(0),     // CLOSE
            ],
            Some(requests.clone()),
        ));
        let mut client = RawSftp::init(client_side).await.unwrap();
        let data = client.read_file(b"/d/caf\xE9.txt", 0, 5).await.unwrap();
        assert_eq!(data, b"abcde".to_vec());
        // INIT 之后的 OPEN 帧携带原始路径字节（latin-1 往返的字节级证据）：
        // payload = type + id + path_len + path + pflags + attrs。
        let open = &test_support::recorded_requests(&requests)[1];
        assert_eq!(open[0], FXP_OPEN);
        let path = b"/d/caf\xE9.txt";
        assert_eq!(&open[9..9 + path.len()], &path[..]);
        // READ 帧 offset 从 0 推进。
        let read = &test_support::recorded_requests(&requests)[2];
        assert_eq!(read[0], FXP_READ);
        assert_eq!(&read[11..19], &0_u64.to_be_bytes());
    }

    #[tokio::test]
    async fn read_file_stops_on_eof_and_honors_offset() {
        let requests = test_support::request_log();
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(test_support::scripted_server(
            server_side,
            vec![
                handle_body(b"h1"),      // OPEN(READ)
                data_body(b"xy"),        // READ#1（短读但未到 cap）
                status_body(SSH_FX_EOF), // READ#2 → EOF 收尾
                status_body(0),          // CLOSE
            ],
            Some(requests.clone()),
        ));
        let mut client = RawSftp::init(client_side).await.unwrap();
        let data = client.read_file(b"/f", 100, 10).await.unwrap();
        assert_eq!(data, b"xy".to_vec());
        // READ#1 的 offset 显式携带调用方给的起点。
        let read = &test_support::recorded_requests(&requests)[2];
        assert_eq!(&read[11..19], &100_u64.to_be_bytes());
    }

    #[test]
    fn error_status_extracts_codes_from_error_strings() {
        assert_eq!(
            error_status("SFTP raw lstat failed with status 2"),
            Some(SSH_FX_NO_SUCH_FILE)
        );
        assert_eq!(
            error_status("SFTP raw read failed with status 11"),
            Some(11)
        );
        assert_eq!(error_status("SFTP raw read failed: boom"), None);
        assert_eq!(error_status(""), None);
    }

    /// CI run 36146663371 根因回归：MKDIR 帧必须携带 ATTRS 字段
    /// （draft-ietf-secsh-filexfer-02 §5.2）。修复前的帧（path 后即截断）
    /// 让 OpenSSH sftp-server 的 `decode_attrib` fatal 退出。此处逐字节
    /// 锁定修复后的帧布局。
    #[test]
    fn mkdir_request_carries_attrs_field() {
        let frame = build_mkdir(4, b"/d/n\xE9", &RawAttrs::default());
        // len = type(1) + id(4) + path_len(4) + path(5) + attrs flags(4) = 18。
        assert_eq!(
            frame,
            vec![
                0, 0, 0, 18, // 帧长
                FXP_MKDIR, 0, 0, 0, 4, // type + id
                0, 0, 0, 5, b'/', b'd', b'/', b'n', 0xE9, // len + path 原始字节
                0, 0, 0, 0, // ATTRS flags=0（空 attrs）
            ]
        );
        // 修复前的错误形态（build_string_request 装的 MKDIR，缺 attrs）必须
        // 被严格桩拒绝——CI "early eof" 的离线复现锚点。
        let malformed = build_string_request(FXP_MKDIR, 4, b"/d/n\xE9");
        assert_ne!(frame, malformed);
        assert!(test_support::validate_request(&malformed[4..]).is_err());
        assert!(test_support::validate_request(&frame[4..]).is_ok());
    }

    /// 严格桩一致性回归：客户端所有操作构造器产出的帧都必须恰好通过
    /// draft-02 布局校验；典型畸形帧（截断/拖尾/缺字段）必须被拒绝。
    #[test]
    fn strict_validator_accepts_all_client_frames_and_rejects_malformed() {
        let attrs = RawAttrs {
            permissions: Some(0o644),
            ..RawAttrs::default()
        };
        let frames = vec![
            build_init(),
            build_open(1, b"/a", PFLAGS_READ, &RawAttrs::default()),
            build_close(2, b"h"),
            build_read(3, b"h", 5, 10),
            build_write(4, b"h", 5, b"abc"),
            build_string_request(FXP_LSTAT, 5, b"/a"),
            build_setstat(6, b"/a", &attrs),
            build_string_request(FXP_OPENDIR, 7, b"/a"),
            build_string_request(FXP_REMOVE, 8, b"/a"),
            build_mkdir(9, b"/a", &RawAttrs::default()),
            build_string_request(FXP_RMDIR, 10, b"/a"),
            build_readdir(11, b"h"),
            build_string_request(FXP_STAT, 12, b"/a"),
            build_rename(13, b"/a", b"/b"),
            build_readlink(14, b"/a"),
            build_symlink(15, b"t", b"/l"),
        ];
        for frame in &frames {
            let payload = &frame[4..];
            if let Err(error) = test_support::validate_request(payload) {
                panic!(
                    "client frame rejected by strict stub ({error}); hexdump: {}",
                    test_support::hexdump(payload)
                );
            }
        }
        // 截断（id 都不完整）/ INIT 拖尾 / STAT 拖尾 / READ 缺 offset / MKDIR
        // 缺 attrs。
        let v = test_support::validate_request;
        assert!(v(&[FXP_STAT, 0, 0]).is_err());
        assert!(v(&[FXP_INIT, 0, 0, 0, 3, 0]).is_err());
        assert!(v(
            &build_string_request(FXP_STAT, 1, b"/a")[4..] // 拖尾一个字节
                .iter()
                .copied()
                .chain([0_u8])
                .collect::<Vec<_>>()
        )
        .is_err());
        let mut short_read = build_read(1, b"h", 0, 8)[4..].to_vec();
        short_read.truncate(short_read.len() - 8); // 掐掉 offset+len
        assert!(v(&short_read).is_err());
        assert!(v(&build_string_request(FXP_MKDIR, 1, b"/a")[4..]).is_err());
    }

    #[tokio::test]
    async fn mkdir_round_trips_through_strict_stub() {
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(scripted_server(server_side, vec![status_body(0)]));
        let mut client = RawSftp::init(client_side).await.unwrap();
        client.mkdir(b"/d/n\xE9").await.unwrap();
    }

    /// CI run 36146663371 的离线复现：OpenSSH 语义桩（解析失败即 fatal
    /// 断流）收到修复前的畸形 MKDIR（path 后无 attrs）时，客户端读响应
    /// 得到 "early eof"——与真机 smoke 的错误串逐字一致。
    #[tokio::test]
    async fn attrless_mkdir_reproduces_ci_early_eof_against_openssh_fatal_stub() {
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(test_support::openssh_fatal_server(server_side, vec![]));
        let mut client = RawSftp::init(client_side).await.unwrap();
        // 修复前的错误帧形态：MKDIR 用 build_string_request 装（缺 ATTRS）。
        client
            .send(&build_string_request(FXP_MKDIR, 99, b"/d/n\xE9"))
            .await
            .unwrap();
        let error = client.recv().await.unwrap_err();
        assert!(error.contains("early eof"), "{error}");
    }
}

/// 内存桩的跨模块复用（`#[cfg(test)]`）：mcp.rs 的 M18 工具级闭环测试用
/// 同一套桩服务器与回包构造器做 latin-1 往返验证，不连真实 SSH。
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 桩服务器收到的请求帧（去掉长度前缀的 payload），供测试断言「发出的
    /// 路径/数据字节」——latin-1 往返闭环的字节级证据。
    pub type RequestLog = Arc<Mutex<Vec<Vec<u8>>>>;

    pub fn request_log() -> RequestLog {
        Arc::new(Mutex::new(Vec::new()))
    }

    pub fn recorded_requests(log: &RequestLog) -> Vec<Vec<u8>> {
        log.lock().unwrap().clone()
    }

    /// 内存双工流的桩服务器（先例：本文件测试模块 M14-B 起）：INIT 回
    /// VERSION，随后每个请求按脚本回预置包体（自动回填请求帧里的 id），
    /// 并把收到的请求 payload 记入 `requests`（None 则不记录）。
    ///
    /// 严格一致性（CI "early eof" 复现线）：每个请求帧先过
    /// [`validate_request`] 按 draft-ietf-secsh-filexfer-02 精确校验字段
    /// 布局（旧宽松桩对帧内容不设防，正是 MKDIR 缺 ATTRS 这种畸形帧在
    /// 本地全绿、真机 OpenSSH 上炸掉的原因）。违规时按
    /// [`StrictMode`] 语义处置。
    pub async fn scripted_server(
        stream: tokio::io::DuplexStream,
        replies: Vec<Vec<u8>>,
        requests: Option<RequestLog>,
    ) {
        scripted_server_mode(stream, replies, requests, StrictMode::Panic).await
    }

    /// OpenSSH 语义的负路径桩：请求布局违规 = sftp-server `fatal` ——进程
    /// 退出、通道 EOF（直接断开流，绝不回包）。用于离线复现 CI 的
    /// "SFTP raw read failed: early eof"（run 36146663371）。
    pub async fn openssh_fatal_server(stream: tokio::io::DuplexStream, replies: Vec<Vec<u8>>) {
        scripted_server_mode(stream, replies, None, StrictMode::Fatal).await
    }

    /// 桩的违规处置模式。
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub enum StrictMode {
        /// 测试桩自检：违规即 panic（带 hexdump），让测试用例第一时间炸在桩上。
        Panic,
        /// 模拟 OpenSSH sftp-server：解析失败即 fatal 退出（静默断流）。
        Fatal,
    }

    async fn scripted_server_mode(
        mut stream: tokio::io::DuplexStream,
        mut replies: Vec<Vec<u8>>,
        requests: Option<RequestLog>,
        mode: StrictMode,
    ) {
        let mut header = [0_u8; 4];
        loop {
            if stream.read_exact(&mut header).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(header) as usize;
            let mut payload = vec![0_u8; len];
            stream.read_exact(&mut payload).await.unwrap();
            if let Err(error) = validate_request(&payload) {
                match mode {
                    StrictMode::Panic => panic!(
                        "strict stub rejected malformed request ({error}); hexdump: {}",
                        hexdump(&payload)
                    ),
                    StrictMode::Fatal => break, // sftp-server fatal：通道 EOF
                }
            }
            if let Some(log) = requests.as_ref() {
                log.lock().unwrap().push(payload.clone());
            }
            let (kind, body) = if payload[0] == FXP_INIT {
                (FXP_VERSION, 3_u32.to_be_bytes().to_vec())
            } else {
                let id = u32::from_be_bytes(payload[1..5].try_into().unwrap());
                let scripted = if mode == StrictMode::Fatal && replies.is_empty() {
                    // fatal 模式下只承诺对合法请求维持连接；无脚本时回 STATUS 0
                    // 维持会话（负路径测试只关心畸形帧触发 fatal）。
                    status_body(0)
                } else {
                    replies.remove(0)
                };
                let mut scripted = scripted;
                scripted[1..5].copy_from_slice(&id.to_be_bytes());
                let kind = scripted.remove(0);
                (kind, scripted)
            };
            let mut packet = vec![kind];
            packet.extend_from_slice(&body);
            let mut frame = (packet.len() as u32).to_be_bytes().to_vec();
            frame.extend_from_slice(&packet);
            stream.write_all(&frame).await.unwrap();
            stream.flush().await.unwrap();
        }
    }

    /// 严格按 draft-ietf-secsh-filexfer-02 校验一个去帧请求 payload 的字段
    /// 布局：字段存在、顺序、长度与类型逐一核对，且必须恰好消费完
    /// （多发/漏发/截断都拒绝）。客户端所有 [`super::RawSftp`] 操作都应通过。
    pub fn validate_request(payload: &[u8]) -> Result<(), String> {
        if payload.is_empty() {
            return Err("empty payload".to_string());
        }
        let kind = payload[0];
        if kind == FXP_INIT {
            if payload.len() != 5 {
                return Err(format!(
                    "INIT must be exactly type + u32 version, got {} bytes",
                    payload.len()
                ));
            }
            return Ok(());
        }
        if payload.len() < 5 {
            return Err(format!("request type {kind} truncated before id"));
        }
        let mut cursor = 5_usize;
        match kind {
            // 单路径：STAT/LSTAT/OPENDIR/REMOVE/RMDIR/READLINK。
            FXP_STAT | FXP_LSTAT | FXP_OPENDIR | FXP_REMOVE | FXP_RMDIR | FXP_READLINK => {
                expect_string(payload, &mut cursor, "path")?;
            }
            // 单句柄：CLOSE/READDIR。
            FXP_CLOSE | FXP_READDIR => {
                expect_string(payload, &mut cursor, "handle")?;
            }
            FXP_READ => {
                expect_string(payload, &mut cursor, "handle")?;
                expect_u64(payload, &mut cursor, "offset")?;
                expect_u32(payload, &mut cursor, "len")?;
            }
            FXP_WRITE => {
                expect_string(payload, &mut cursor, "handle")?;
                expect_u64(payload, &mut cursor, "offset")?;
                expect_string(payload, &mut cursor, "data")?;
            }
            FXP_OPEN => {
                expect_string(payload, &mut cursor, "path")?;
                expect_u32(payload, &mut cursor, "pflags")?;
                expect_attrs(payload, &mut cursor, "attrs")?;
            }
            // MKDIR 与 SETSTAT 是「路径 + ATTRS」布局：MKDIR 的 attrs 正是
            // CI 现场缺失的字段（OpenSSH process_mkdir fatal 的直接原因）。
            FXP_MKDIR | FXP_SETSTAT => {
                expect_string(payload, &mut cursor, "path")?;
                expect_attrs(payload, &mut cursor, "attrs")?;
            }
            FXP_RENAME | FXP_SYMLINK => {
                expect_string(payload, &mut cursor, "first string")?;
                expect_string(payload, &mut cursor, "second string")?;
            }
            _ => return Err(format!("unexpected request type {kind}")),
        }
        if cursor != payload.len() {
            return Err(format!(
                "type {kind}: consumed {cursor} of {} bytes (missing or trailing fields)",
                payload.len()
            ));
        }
        Ok(())
    }

    fn expect_string(payload: &[u8], cursor: &mut usize, what: &str) -> Result<(), String> {
        skip_string(payload, cursor).map_err(|_| format!("{what} truncated"))
    }

    fn expect_u32(payload: &[u8], cursor: &mut usize, what: &str) -> Result<u32, String> {
        read_u32(payload, cursor).map_err(|_| format!("{what} truncated"))
    }

    fn expect_u64(payload: &[u8], cursor: &mut usize, what: &str) -> Result<u64, String> {
        read_u64(payload, cursor).map_err(|_| format!("{what} truncated"))
    }

    fn expect_attrs(payload: &[u8], cursor: &mut usize, what: &str) -> Result<(), String> {
        let (_, consumed) =
            parse_attrs(&payload[*cursor..]).map_err(|_| format!("{what} truncated"))?;
        *cursor += consumed;
        Ok(())
    }

    /// 测试诊断用 hexdump（空格分隔的大写十六进制，超长截断）。
    pub fn hexdump(bytes: &[u8]) -> String {
        let limit = bytes.len().min(64);
        let dump = bytes[..limit]
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ");
        if bytes.len() > limit {
            format!("{dump}… (+{} bytes)", bytes.len() - limit)
        } else {
            dump
        }
    }

    pub fn status_body(code: u32) -> Vec<u8> {
        let mut body = vec![FXP_STATUS];
        body.extend_from_slice(&0_u32.to_be_bytes());
        body.extend_from_slice(&code.to_be_bytes());
        body
    }

    pub fn attrs_body(size: u64, permissions: u32) -> Vec<u8> {
        attrs_body_full(size, permissions, None, None)
    }

    /// 带 atime/mtime 的 attrs 回包（stat 映射测试用）。
    pub fn attrs_body_full(
        size: u64,
        permissions: u32,
        atime: Option<u32>,
        mtime: Option<u32>,
    ) -> Vec<u8> {
        let mut body = vec![FXP_ATTRS];
        body.extend_from_slice(&0_u32.to_be_bytes()); // id 占位
        let mut flags = ATTR_SIZE | ATTR_PERMISSIONS;
        if atime.is_some() || mtime.is_some() {
            flags |= ATTR_ACMODTIME;
        }
        body.extend_from_slice(&flags.to_be_bytes());
        body.extend_from_slice(&size.to_be_bytes());
        body.extend_from_slice(&permissions.to_be_bytes());
        if flags & ATTR_ACMODTIME != 0 {
            body.extend_from_slice(&atime.unwrap_or(0).to_be_bytes());
            body.extend_from_slice(&mtime.unwrap_or(0).to_be_bytes());
        }
        body
    }

    pub fn handle_body(value: &[u8]) -> Vec<u8> {
        let mut body = vec![FXP_HANDLE];
        body.extend_from_slice(&0_u32.to_be_bytes()); // id 占位
        body.extend_from_slice(&(value.len() as u32).to_be_bytes());
        body.extend_from_slice(value);
        body
    }

    pub fn data_body(data: &[u8]) -> Vec<u8> {
        let mut body = vec![FXP_DATA];
        body.extend_from_slice(&0_u32.to_be_bytes()); // id 占位
        body.extend_from_slice(&(data.len() as u32).to_be_bytes());
        body.extend_from_slice(data);
        body
    }

    /// NAME 单条目回包（READLINK 用）：name + 空 longname + 空 attrs。
    pub fn name_body_one(name: &[u8]) -> Vec<u8> {
        let mut body = vec![FXP_NAME];
        body.extend_from_slice(&0_u32.to_be_bytes()); // id 占位
        body.extend_from_slice(&1_u32.to_be_bytes());
        body.extend_from_slice(&(name.len() as u32).to_be_bytes());
        body.extend_from_slice(name);
        body.extend_from_slice(&0_u32.to_be_bytes()); // longname 空
        body.extend_from_slice(&0_u32.to_be_bytes()); // attrs flags=0
        body
    }
}
