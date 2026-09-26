// 终端 OSC 白名单通道（WT-2 协议应答矩阵批）：OSC 9 / OSC 777 通知与
// OSC 1337 SetUserVar 的纯函数解析。与 terminalOsc.ts（OSC 10/11/52）、
// terminalModeQueries.ts（CSI 查询）同属"内核不应答/不消费、插件层补"的
// 应答面；本模块只做形状解析与防御上限，接线（parser 注册/通知/目录跟随）
// 留在 App.vue。对应 WezTerm 的 `user-var-changed` 事件与 toast 通知消费。

export interface OscNotification {
  /** 远端标题；OSC 9 或无标题的 OSC 777 为空串（由调用方决定兜底文案）。 */
  title: string;
  body: string;
}

export interface TerminalUserVar {
  name: string;
  value: string;
}

/** 通知标题/正文上限（字符）：远端可无限刷屏，超限截断而非丢弃。 */
export const OSC_NOTIFY_TITLE_MAX = 120;
export const OSC_NOTIFY_BODY_MAX = 600;
/** SetUserVar 名称上限（字符）。 */
export const USER_VAR_NAME_MAX = 64;
/** SetUserVar base64 载荷上限（字符）：shell 集成的 cwd/命令元数据远小于此。 */
export const USER_VAR_PAYLOAD_MAX = 16_384;
/** SetUserVar 解码后取用上限（字符）：超限视为异常载荷整体忽略。 */
export const USER_VAR_VALUE_MAX = 8_192;

const OSC777_NOTIFY_PREFIX = "notify;";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function cleanSingleLine(text: string): string {
  // 通知文案压成单行：换行在 Toast 单行布局里不可见还可能被样式吞掉。
  return text.replace(/[\r\n]+/g, " ").trim();
}

/**
 * OSC 777 → 通知。kitty/urxvt 约定 `OSC 777 ; notify ; TITLE ; BODY`；
 * 只有 body（`notify;BODY`）时标题留空。非 notify 类（如 urxvt 的进度
 * 上报）返回 null——白名单语义：不认识的种类不消费，交回内核忽略。
 */
export function parseOsc777Notify(data: string): OscNotification | null {
  if (typeof data !== "string" || !data.startsWith(OSC777_NOTIFY_PREFIX)) return null;
  const rest = data.slice(OSC777_NOTIFY_PREFIX.length);
  const separator = rest.indexOf(";");
  const title = separator < 0 ? "" : cleanSingleLine(rest.slice(0, separator));
  const body = cleanSingleLine(separator < 0 ? rest : rest.slice(separator + 1));
  if (!title && !body) return null;
  return { title: truncate(title, OSC_NOTIFY_TITLE_MAX), body: truncate(body, OSC_NOTIFY_BODY_MAX) };
}

/**
 * OSC 9 → 通知（iTerm2 growl 风格，payload 即正文）。空正文返回 null
 * （配合空标题的 OSC 777 一起由调用方兜底，不弹无内容的通知）。
 */
export function parseOsc9Notification(data: string): OscNotification | null {
  const body = cleanSingleLine(typeof data === "string" ? data : "");
  if (!body) return null;
  return { title: "", body: truncate(body, OSC_NOTIFY_BODY_MAX) };
}

/** base64（标准字母表，容忍空白）→ UTF-8 串；解码失败返回 null。 */
function decodeBase64Utf8(payload: string): string | null {
  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

/**
 * OSC 1337 `SetUserVar=name=<base64 value>` → { name, value }（iTerm2 格式）。
 * 防御性：缺 `=`、空名、超限、坏 base64 一律返回 null（降级忽略，不进 UI）。
 * 非本格式（`File=…` 内联图像、`CurrentDir=…` 直通等）返回 null 交回
 * 注册序中更晚的 handler——xterm 6 对同一 OSC id 的多 handler 按"后注册
 * 先执行"派发，本插件 handler 返回 false 即落回 ImageAddon 的图像通道。
 */
export function parseOsc1337SetUserVar(data: string): TerminalUserVar | null {
  if (typeof data !== "string" || !data.startsWith("SetUserVar=")) return null;
  const payload = data.slice("SetUserVar=".length);
  const separator = payload.indexOf("=");
  if (separator <= 0) return null;
  const name = payload.slice(0, separator);
  const encoded = payload.slice(separator + 1);
  if (!name || name.length > USER_VAR_NAME_MAX) return null;
  if (!encoded || encoded.length > USER_VAR_PAYLOAD_MAX) return null;
  const value = decodeBase64Utf8(encoded);
  if (value === null || value.length > USER_VAR_VALUE_MAX) return null;
  return { name, value };
}

/** SetUserVar 里承载 cwd 元数据的常见约定名（iTerm2/WezTerm shell 集成惯例）。 */
export function isCwdUserVarName(name: string): boolean {
  return name === "cwd" || name === "CurrentDir" || name === "currentdir";
}

/**
 * cwd 元数据 → 可跟随的目录路径。只接受 POSIX 绝对路径（本插件的 SSH/SFTP
 * 目录跟随面向 *nix 主机；Windows 路径与既有 OSC 7 `file://` 解析一样不认），
 * 含 NUL/换行的值拒绝。值是原始路径（base64 解码后不做事 URL 解码——路径里
 * 的 `%` 是字面字符）。
 */
export function cwdFromUserVar(name: string, value: string): string | null {
  if (!isCwdUserVarName(name)) return null;
  const path = value.trim();
  if (!path.startsWith("/")) return null;
  if (/[\0\n\r]/.test(path)) return null;
  return path;
}

export interface DirectoryFollowEvent {
  path: string;
  at: number;
}

/**
 * OSC 7 与 SetUserVar cwd 双通道并存时的跟随裁决（优先级语义）：
 * - 无 SetUserVar 通道 → OSC 7 照常跟随（既有行为不变，回落保留）；
 * - 两通道报告同一路径 → 跟随（重复触发是无害 no-op）；
 * - 分歧时以更晚的事件为准（SetUserVar 在 cd 即刻上报，先于提示符时刻的
 *   OSC 7——这正是它"优先"的窗口；提示符 OSC 7 更晚到达则说明提示符时刻的
 *   真实 cwd 已变，以提示符为准回落）。
 */
export function shouldOsc7FollowOverrideUserVarCwd(userVar: DirectoryFollowEvent | null, osc7Path: string, now: number): boolean {
  if (!userVar) return true;
  if (userVar.path === osc7Path) return true;
  return now >= userVar.at;
}
