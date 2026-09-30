/**
 * 端口映射（对标 Xshell/ssh(1) -L/-R）：把当前 SSH 会话上的转发映射解析成
 * 工作台面板行、校验添加表单并在 `ssh/forward/state` 事件到达时就地更新。
 * 本模块只做纯解析/校验/格式化，RPC 调用留在 App.vue。
 *
 * sidecar 协议（docs/PROTOCOL.zh-CN.md）：
 * - `ssh/forward/list` { connectionId? | sessionId? } → { forwards: row[] }
 * - `ssh/forward/start` { sessionId, kind, listenHost?, listenPort,
 *   targetHost, targetPort } → { forward: row }
 * - `ssh/forward/stop` { id } → { success, forward }
 * - `ssh/forward/state`（事件）{ id, state, error? }
 */

export type ForwardKind = "local" | "remote" | "dynamic";

export interface PortForward {
  id: string;
  sessionId: string;
  connectionId: string;
  kind: ForwardKind;
  listenHost: string;
  listenPort: number;
  /** 实际绑定端口：本地 0 端口由 OS 挑选、远程 0 端口由服务端挑选。 */
  boundPort: number;
  targetHost: string;
  targetPort: number;
  state: "starting" | "active" | "stopped" | "error";
  error?: string;
  connectionsTotal: number;
  connectionsActive: number;
  bytesUp: number;
  bytesDown: number;
}

/** 添加映射表单的字符串态：输入框里的端口在提交前都是文本。 */
export interface ForwardFormDraft {
  kind: ForwardKind;
  listenHost: string;
  listenPort: string;
  targetHost: string;
  targetPort: string;
}

/** 表单校验错误码 → i18n `forwards.error.*`；null 表示通过。 */
export type ForwardFormError = "listenHost" | "targetHost" | "port" | null;

/** `ssh/forward/interfaces` 行：本机可绑定地址 + 接口名 + 回环标记。 */
export interface HostInterface {
  name: string;
  addr: string;
  isLoopback: boolean;
}

function asForwardRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseKind(value: unknown): ForwardKind {
  return value === "remote" || value === "dynamic" ? value : "local";
}

/** `ssh/forward/list` / `ssh/forward/start` 载荷 → 面板行；坏行直接丢弃。 */
export function parseForwards(payload: unknown): PortForward[] {
  const record = asForwardRecord(payload);
  const rows = record && Array.isArray(record.forwards) ? record.forwards : [];
  const single = record && record.forward ? [record.forward] : [];
  const parsed: PortForward[] = [];
  for (const row of [...rows, ...single]) {
    const source = asForwardRecord(row);
    if (!source || typeof source.id !== "string" || !source.id) continue;
    parsed.push({
      id: source.id,
      sessionId: stringField(source, "sessionId"),
      connectionId: stringField(source, "connectionId"),
      kind: parseKind(source.kind),
      listenHost: stringField(source, "listenHost") || "127.0.0.1",
      listenPort: numberField(source, "listenPort"),
      boundPort: numberField(source, "boundPort"),
      targetHost: stringField(source, "targetHost"),
      targetPort: numberField(source, "targetPort"),
      state: parseState(source.state),
      error: typeof source.error === "string" && source.error ? source.error : undefined,
      connectionsTotal: numberField(source, "connectionsTotal"),
      connectionsActive: numberField(source, "connectionsActive"),
      bytesUp: numberField(source, "bytesUp"),
      bytesDown: numberField(source, "bytesDown"),
    });
  }
  return parsed;
}

function parseState(value: unknown): PortForward["state"] {
  return value === "starting" || value === "stopped" || value === "error" ? value : "active";
}

/**
 * 就地套用一条 `ssh/forward/state` 事件：已知 id 更新状态列，未知 id 忽略
 * （由下一次 list 校正）。返回新数组，保持 Vue 响应式替换语义。
 */
export function applyForwardState(
  rows: PortForward[],
  event: { id?: unknown; state?: unknown; error?: unknown },
): PortForward[] {
  if (typeof event.id !== "string" || !event.id) return rows;
  return rows.map((row) =>
    row.id === event.id
      ? { ...row, state: parseState(event.state), error: typeof event.error === "string" && event.error ? event.error : undefined }
      : row,
  );
}

/**
 * 表单校验（与 sidecar `parse_spec` 同语义的客户端预检）：
 * - listen/target 主机必须是 IPv4、IPv6（可带 `[]`）或主机名标签；
 * - listenHost 缺省回落 127.0.0.1（`*` 仅远程映射可用）；
 * - 两个端口必须是 0..=65535 整数；0 表示让 OS/服务端挑选。
 */
export function validateForwardForm(draft: ForwardFormDraft): ForwardFormError {
  if (!isValidHost(draft.listenHost.trim(), { allowEmpty: true, allowWildcard: draft.kind === "remote" })) {
    return "listenHost";
  }
  if (draft.kind !== "dynamic" && !isValidHost(draft.targetHost.trim(), { allowEmpty: false, allowWildcard: false })) {
    return "targetHost";
  }
  for (const port of draft.kind === "dynamic" ? [draft.listenPort] : [draft.listenPort, draft.targetPort]) {
    const value = Number(port.trim());
    if (!port.trim() || !Number.isInteger(value) || value < 0 || value > 65535) return "port";
  }
  return null;
}

const WILDCARD_HOSTS = new Set(["*", "0.0.0.0", "::", ""]);

/** 主机语法门（与 sidecar `normalize_host` 同规则的 JS 版）：IPv4 / IPv6 /
 * 主机名 / 回环名；`*` 通配仅远程监听可用；嵌入式端口与 scheme 拒绝。 */
export function isValidHost(
  raw: string,
  options: { allowEmpty: boolean; allowWildcard: boolean },
): boolean {
  let host = raw.trim().toLowerCase();
  if (!host) return options.allowEmpty;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1 || end !== host.length - 1) return false;
    host = host.slice(1, end);
  }
  if (host === "*") return options.allowWildcard;
  if (isIPv4(host) || isIPv6(host)) return true;
  if (host === "localhost") return true;
  if (/[:/@]/.test(host) || host.length > 253) return false;
  // 全数字点分但不是合法 IPv4（如 999.1.1.1）：是笔误，不是主机名。
  if (/^[\d.]+$/.test(host)) return false;
  return host.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIPv6(host: string): boolean {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) return false;
  // 借 URL 解析器校验 IPv6 字面量（host 字段不含端口，直接包进 []）。
  try {
    new URL(`http://[${host}]`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 冲突预检（与 sidecar 同规则）：同方向、同端口（0 = 自动挑选永不冲突）、
 * 主机相同或任一侧通配（`*`/`0.0.0.0`/`::`/空）即冲突。返回冲突行。
 */
export function findForwardConflict(
  rows: PortForward[],
  draft: Pick<ForwardFormDraft, "kind" | "listenHost" | "listenPort">,
): PortForward | null {
  const port = Number(draft.listenPort.trim());
  if (!Number.isInteger(port) || port <= 0) return null;
  const host = normalizePickHost(draft.listenHost.trim());
  return (
    rows.find(
      (row) =>
        (draft.kind === "remote" ? row.kind === "remote" : row.kind !== "remote") &&
        row.listenPort === port &&
        (WILDCARD_HOSTS.has(host) ||
          WILDCARD_HOSTS.has(normalizePickHost(row.listenHost)) ||
          host === normalizePickHost(row.listenHost)),
    ) ?? null
  );
}

function normalizePickHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (!value) value = "127.0.0.1";
  return value;
}

/**
 * `ssh/forward/interfaces` 载荷 → 网卡地址行；坏行丢弃。探测失败（空载荷）
 * 返回空数组，选择器隐藏、手输不受影响。
 */
export function parseInterfaces(payload: unknown): HostInterface[] {
  const record = asForwardRecord(payload);
  const rows = record && Array.isArray(record.interfaces) ? record.interfaces : [];
  const parsed: HostInterface[] = [];
  for (const row of rows) {
    const source = asForwardRecord(row);
    if (!source) continue;
    const addr = typeof source.addr === "string" ? source.addr.trim() : "";
    if (!addr) continue;
    parsed.push({
      name: typeof source.name === "string" ? source.name : "",
      addr,
      isLoopback: source.isLoopback === true,
    });
  }
  return parsed;
}

/** 监听地址 datalist 的静态默认候选行；labelKey 是完整 i18n key（含
 * `forwards.` 前缀，i18nKeyReferences 扫描器按全量 key 校验），翻译留在
 * 组件侧。 */
export interface ListenHostOption {
  value: string;
  labelKey: string;
}

/**
 * 按方向的监听地址默认候选。本地（-L）绑定发生在客户机：全接口 + 回环字面量，
 * 客户机网卡探测结果由组件追加。远程（-R）的绑定发生在 SSH 服务器上，客户机
 * 网卡地址在这里是误导——默认候选换成服务器侧地址：回环组（127.0.0.1、
 * localhost 名、::1）与全接口组（0.0.0.0、::、sshd 通配 `*`）。全部条目都
 * 通过 validateForwardForm（`*` 仅远程合法，本地组刻意不含）。
 */
export function listenHostOptions(kind: ForwardKind): ListenHostOption[] {
  if (kind !== "remote") {
    return [
      { value: "0.0.0.0", labelKey: "forwards.allInterfaces" },
      { value: "127.0.0.1", labelKey: "forwards.loopback" },
      { value: "::1", labelKey: "forwards.loopback" },
    ];
  }
  return [
    { value: "127.0.0.1", labelKey: "forwards.loopback" },
    { value: "localhost", labelKey: "forwards.loopbackName" },
    { value: "::1", labelKey: "forwards.loopback" },
    { value: "0.0.0.0", labelKey: "forwards.allInterfaces" },
    { value: "::", labelKey: "forwards.allInterfacesV6" },
    { value: "*", labelKey: "forwards.wildcardHost" },
  ];
}

/** 校验通过后的 RPC 参数（端口转数字；listenHost 空串交给 sidecar 默认）。 */
export function forwardStartParams(draft: ForwardFormDraft, ownerId: string, independent = false) {
  return {
    ...(independent ? { connectionId: ownerId } : { sessionId: ownerId }),
    kind: draft.kind,
    listenHost: draft.listenHost.trim(),
    listenPort: Number(draft.listenPort.trim()),
    ...(draft.kind === "dynamic" ? {} : {
      targetHost: draft.targetHost.trim(),
      targetPort: Number(draft.targetPort.trim()),
    }),
  };
}

/** 面板行主文案：`127.0.0.1:8080 → db:5432`，0 端口显示实际绑定值。 */
export function formatForwardRoute(row: Pick<PortForward, "kind" | "listenHost" | "listenPort" | "boundPort" | "targetHost" | "targetPort">): string {
  const listen = row.boundPort > 0 ? row.boundPort : row.listenPort;
  if (row.kind === "dynamic") return `SOCKS5 ${row.listenHost}:${listen}`;
  const arrow = row.kind === "remote" ? "←" : "→";
  return `${row.listenHost}:${listen} ${arrow} ${row.targetHost}:${row.targetPort}`;
}

export function formatForwardBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "KiB";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
