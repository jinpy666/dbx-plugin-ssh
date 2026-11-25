//! #324：MCP 内联拨号的代理支持。`socksProxy`（SOCKS5）与 `httpProxy`
//! （HTTP CONNECT）参数让 AI 内联 host/账号密码的连接能穿过只允许代理
//! 出网的机器；引用已保存连接的路径仍走宿主 `runtime` 隧道端点，此处
//! 不参与。密码只活在内存里的 `StoredConnection`，不落盘、不回显。
//!
//! HTTP CONNECT 握手手写（报文小、规则稳定，不值得引入大依赖）；
//! SOCKS5 用 tokio-socks（认证协商协议面大，手写易错，0.5 为当前
//! 纯 Rust tokio 生成）。

use base64::Engine;
use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

/// 代理类型：SOCKS5 或 HTTP CONNECT（MCP 参数 `socksProxy` / `httpProxy`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyKind {
    Socks5,
    HttpConnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    /// Basic 认证用户名/密码；空串表示匿名。与连接密码同寿命，只进内存。
    pub username: String,
    pub password: String,
}

/// 经代理拨出的预连流。SOCKS5 返回 tokio-socks 的流，HTTP CONNECT 返回
/// 完成握手的裸 TcpStream；统一装箱给 russh `connect_stream`。
pub trait ProxyStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ProxyStream for T {}

impl ProxyConfig {
    fn param_name(kind: &ProxyKind) -> &'static str {
        match kind {
            ProxyKind::Socks5 => "socksProxy",
            ProxyKind::HttpConnect => "httpProxy",
        }
    }

    fn default_port(kind: &ProxyKind) -> u16 {
        match kind {
            ProxyKind::Socks5 => 1080,
            ProxyKind::HttpConnect => 8080,
        }
    }

    pub fn from_mcp_value(kind: ProxyKind, value: &Value) -> Result<Self, String> {
        let name = Self::param_name(&kind);
        let object = value
            .as_object()
            .ok_or_else(|| format!("{name} must be an object with host/port/username/password"))?;
        let host = object
            .get("host")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{name} is missing a host string"))?;
        let host = crate::model::validate_host_field(host.to_string())
            .map_err(|error| format!("{name}: {error}"))?;
        let port = match object.get("port") {
            None | Some(Value::Null) => Self::default_port(&kind),
            Some(value) => {
                let port = value
                    .as_u64()
                    .ok_or_else(|| format!("{name} port must be a number"))?;
                u16::try_from(port)
                    .ok()
                    .filter(|port| *port > 0)
                    .ok_or_else(|| format!("{name} port must be between 1 and 65535"))?
            }
        };
        let username = object
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let password = object
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok(Self {
            kind,
            host,
            port,
            username,
            password,
        })
    }

    /// 从 MCP 工具参数提取内联代理：socksProxy/httpProxy 互斥，都缺省
    /// （或显式 null）返回 None，维持直连现状。
    pub fn from_mcp_args(arguments: &Value) -> Result<Option<Self>, String> {
        let socks = arguments.get("socksProxy").filter(|value| !value.is_null());
        let http = arguments.get("httpProxy").filter(|value| !value.is_null());
        match (socks, http) {
            (None, None) => Ok(None),
            (Some(socks), None) => Self::from_mcp_value(ProxyKind::Socks5, socks).map(Some),
            (None, Some(http)) => Self::from_mcp_value(ProxyKind::HttpConnect, http).map(Some),
            (Some(_), Some(_)) => Err(
                "socksProxy and httpProxy are mutually exclusive; pass exactly one".to_string(),
            ),
        }
    }

    /// 经代理建立到 target 的隧道连接；timeout 同时约束到代理的 TCP
    /// 连接与代理协议握手。SOCKS5 的目标以域名形式转交代理解析
    /// （proxied 环境里本地 DNS 常不可用），HTTP CONNECT 同理。
    pub async fn connect(
        &self,
        target_host: &str,
        target_port: u16,
        timeout: Duration,
    ) -> Result<Box<dyn ProxyStream>, String> {
        let dial = tokio::time::timeout(timeout, async {
            match self.kind {
                ProxyKind::Socks5 => {
                    let stream = if self.username.is_empty() {
                        tokio_socks::tcp::Socks5Stream::connect(
                            (self.host.as_str(), self.port),
                            (target_host, target_port),
                        )
                        .await
                    } else {
                        tokio_socks::tcp::Socks5Stream::connect_with_password(
                            (self.host.as_str(), self.port),
                            (target_host, target_port),
                            self.username.as_str(),
                            self.password.as_str(),
                        )
                        .await
                    };
                    stream
                        .map(|stream| Box::new(stream) as Box<dyn ProxyStream>)
                        .map_err(|error| {
                            format!("SOCKS5 proxy {}:{} failed: {error}", self.host, self.port)
                        })
                }
                ProxyKind::HttpConnect => {
                    let mut stream = tokio::net::TcpStream::connect((self.host.as_str(), self.port))
                        .await
                        .map_err(|error| {
                            format!("HTTP proxy {}:{} unreachable: {error}", self.host, self.port)
                        })?;
                    use tokio::io::AsyncWriteExt;
                    let request = http_connect_request(
                        target_host,
                        target_port,
                        Some((self.username.as_str(), self.password.as_str())),
                    );
                    stream
                        .write_all(request.as_bytes())
                        .await
                        .map_err(|error| {
                            format!("HTTP proxy {}:{} request failed: {error}", self.host, self.port)
                        })?;
                    let response = read_http_response(&mut stream).await?;
                    parse_http_connect_response(&response)?;
                    Ok(Box::new(stream) as Box<dyn ProxyStream>)
                }
            }
        })
        .await
        .map_err(|_| format!("proxy {}:{} connect timed out", self.host, self.port))??;
        Ok(dial)
    }
}

/// 读到 HTTP 响应头终结符（`\r\n\r\n`）为止，供 CONNECT 握手解析；
/// 8 KiB 封顶，防止异常代理把连接当数据泵。
async fn read_http_response(
    stream: &mut tokio::net::TcpStream,
) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("HTTP proxy response failed: {error}"))?;
        if read == 0 {
            return Err("HTTP proxy closed the connection before a response".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 8 * 1024 {
            return Err("HTTP proxy response exceeds 8 KiB without a header terminator".to_string());
        }
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(buffer);
        }
    }
}

/// HTTP CONNECT 请求报文（纯函数便于单测）。
pub fn http_connect_request(host: &str, port: u16, auth: Option<(&str, &str)>) -> String {
    let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if let Some((username, password)) = auth.filter(|(username, _)| !username.is_empty()) {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {encoded}\r\n"));
    }
    request.push_str("\r\n");
    request
}

/// 解析 HTTP CONNECT 响应：状态行 2xx 即成功，其余报错（含 407）。
/// 逐行找状态行而不是只看首行，容忍个别代理在前面垫行。
pub fn parse_http_connect_response(bytes: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "HTTP proxy response is not valid UTF-8".to_string())?;
    let status = text
        .lines()
        .find(|line| line.starts_with("HTTP/"))
        .ok_or_else(|| "HTTP proxy sent no HTTP status line".to_string())?;
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("HTTP proxy sent a malformed status line: {}", status.trim()))?;
    if (200..300).contains(&code) {
        Ok(())
    } else {
        Err(format!("HTTP CONNECT failed: {}", status.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_proxy_args_mean_direct_dial() {
        let args = json!({ "host": "h", "username": "u" });
        assert_eq!(ProxyConfig::from_mcp_args(&args), Ok(None));
    }

    #[test]
    fn socks_proxy_defaults_to_port_1080() {
        let args = json!({ "host": "h", "username": "u", "socksProxy": { "host": "127.0.0.1" } });
        assert_eq!(
            ProxyConfig::from_mcp_args(&args),
            Ok(Some(ProxyConfig {
                kind: ProxyKind::Socks5,
                host: "127.0.0.1".into(),
                port: 1080,
                username: String::new(),
                password: String::new(),
            }))
        );
    }

    #[test]
    fn http_proxy_keeps_explicit_fields() {
        let args = json!({ "host": "h", "username": "u",
            "httpProxy": { "host": "proxy.lan", "port": 3128, "username": "pu", "password": "pp" } });
        assert_eq!(
            ProxyConfig::from_mcp_args(&args),
            Ok(Some(ProxyConfig {
                kind: ProxyKind::HttpConnect,
                host: "proxy.lan".into(),
                port: 3128,
                username: "pu".into(),
                password: "pp".into(),
            }))
        );
    }

    #[test]
    fn both_proxy_kinds_are_refused() {
        let args = json!({
            "host": "h", "username": "u",
            "socksProxy": { "host": "a" }, "httpProxy": { "host": "b" },
        });
        let error = ProxyConfig::from_mcp_args(&args).unwrap_err();
        assert!(error.contains("socksProxy") && error.contains("httpProxy"));
    }

    #[test]
    fn proxy_object_validates_host_and_port() {
        let missing_host = json!({ "socksProxy": { "port": 1080 } });
        assert!(ProxyConfig::from_mcp_args(&missing_host).is_err());
        let empty_host = json!({ "httpProxy": { "host": "   " } });
        assert!(ProxyConfig::from_mcp_args(&empty_host).is_err());
        let zero_port = json!({ "socksProxy": { "host": "p", "port": 0 } });
        assert!(ProxyConfig::from_mcp_args(&zero_port).is_err());
        let huge_port = json!({ "socksProxy": { "host": "p", "port": 70000 } });
        assert!(ProxyConfig::from_mcp_args(&huge_port).is_err());
        let text_port = json!({ "socksProxy": { "host": "p", "port": "1080" } });
        assert!(ProxyConfig::from_mcp_args(&text_port).is_err());
        let not_an_object = json!({ "socksProxy": "127.0.0.1:1080" });
        assert!(ProxyConfig::from_mcp_args(&not_an_object).is_err());
    }

    #[test]
    fn http_connect_request_targets_and_authenticates() {
        let anonymous = http_connect_request("h", 22, None);
        assert!(anonymous.starts_with("CONNECT h:22 HTTP/1.1\r\n"));
        assert!(anonymous.contains("Host: h:22\r\n"));
        assert!(anonymous.ends_with("\r\n\r\n"));
        assert!(!anonymous.contains("Proxy-Authorization"));

        let with_auth = http_connect_request("h", 22, Some(("u", "p")));
        // base64("u:p") == "dTpw"
        assert!(with_auth.contains("Proxy-Authorization: Basic dTpw\r\n"));
    }

    #[test]
    fn http_connect_response_accepts_2xx() {
        assert_eq!(
            parse_http_connect_response(b"HTTP/1.1 200 Connection established\r\n\r\n"),
            Ok(())
        );
        // 1.0 代理（老squid等）+ 附带头与响应体都要能过。
        assert_eq!(
            parse_http_connect_response(b"HTTP/1.0 200 OK\r\nX-Proxy: y\r\n\r\npayload"),
            Ok(())
        );
    }

    #[test]
    fn http_connect_response_rejects_failures() {
        let refused = parse_http_connect_response(
            b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
        )
        .unwrap_err();
        assert!(refused.contains("407"));
        assert!(parse_http_connect_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").is_err());
        assert!(parse_http_connect_response(b"not http at all\r\n\r\n").is_err());
        assert!(parse_http_connect_response(b"").is_err());
    }
}
