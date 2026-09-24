// curl 结构化补全数据（接口/网络排障高频）。
//
// 数据来源：everything.curl.dev 与 man 1 curl 常用项，格式借鉴 fig 完成规范
// 的 command/option/args 三层思路。裁剪原则：HTTP 调试高频 flag；HTTP 方法与
// 重试类可枚举值做静态枚举；URL/数据体动态。
import type { SpecCommand } from "../spec";

export const curlSpec: SpecCommand = {
  name: "curl",
  description: "Transfer data from or to a server",
  flags: [
    { name: "request", short: "X", description: "HTTP method", arg: "method", values: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
    { name: "header", short: "H", description: "Extra header", arg: "header" },
    { name: "data", short: "d", description: "Request body", arg: "data" },
    { name: "data-raw", description: "Request body without @ interpretation", arg: "data" },
    { name: "data-urlencode", description: "URL-encoded request body", arg: "data" },
    { name: "json", description: "JSON body with content-type headers", arg: "data" },
    { name: "form", short: "F", description: "Multipart form field", arg: "name=content" },
    { name: "head", short: "I", description: "Fetch headers only" },
    { name: "location", short: "L", description: "Follow redirects" },
    { name: "output", short: "o", description: "Write to a file", arg: "file" },
    { name: "remote-name", short: "O", description: "Write output to a file named after the URL" },
    { name: "silent", short: "s", description: "Silent mode" },
    { name: "show-error", short: "S", description: "Show errors even when silent" },
    { name: "fail", short: "f", description: "Fail silently on HTTP errors" },
    { name: "verbose", short: "v", description: "Verbose protocol output" },
    { name: "insecure", short: "k", description: "Skip TLS verification" },
    { name: "cacert", description: "CA certificate bundle", arg: "file" },
    { name: "user", short: "u", description: "Basic-auth credentials", arg: "user:password" },
    { name: "user-agent", short: "A", description: "User-Agent header", arg: "name" },
    { name: "referer", short: "e", description: "Referer header", arg: "url" },
    { name: "cookie", short: "b", description: "Send cookies", arg: "data" },
    { name: "cookie-jar", short: "c", description: "Save cookies to a file", arg: "file" },
    { name: "compressed", description: "Request compressed responses" },
    { name: "proxy", short: "x", description: "Proxy to use", arg: "host:port" },
    { name: "noproxy", description: "Hosts that bypass the proxy", arg: "list" },
    { name: "retry", description: "Retry transient errors N times", arg: "num" },
    { name: "retry-delay", description: "Seconds between retries", arg: "seconds" },
    { name: "max-time", description: "Total time limit", arg: "seconds" },
    { name: "connect-timeout", description: "Connect phase time limit", arg: "seconds" },
    { name: "upload-file", short: "T", description: "Upload a file", arg: "file" },
    { name: "get", short: "G", description: "Put -d data into the query string" },
    { name: "ipv4", short: "4", description: "Resolve to IPv4 only" },
    { name: "ipv6", short: "6", description: "Resolve to IPv6 only" },
    { name: "progress-bar", description: "Show a progress bar" },
    { name: "unix-socket", description: "Connect via a unix socket", arg: "path" },
  ],
  positional: { name: "url", dynamic: true },
};
