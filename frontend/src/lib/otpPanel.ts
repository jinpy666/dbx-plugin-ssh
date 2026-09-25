/**
 * OTP 面板与会话导入向导的纯逻辑层：otp/list 脱敏视图与 bindings 表解析、
 * otp/generate 响应解析与 TOTP 倒计时、otp/import-qr 结果到编辑草稿的映射、
 * otp/save 参数构造、流式导入预览参数、二进制转 base64、
 * 以及「发送验证码到终端」时的活跃会话挑选。组件（OtpPanel.vue /
 * ImportWizard.vue）只做状态编排与 UI；这里全部是可单测的纯函数。
 */

// ---------------------------------------------------------------------------
// otp/list：脱敏条目视图 + 连接绑定表
// ---------------------------------------------------------------------------

export interface OtpEntryView {
  id: string;
  otpType: "totp" | "hotp";
  issuer: string;
  username: string;
  hasSecret: boolean;
  algorithm: string;
  digits: number;
  period: number;
  counter: number | null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseEntry(raw: unknown): OtpEntryView | null {
  if (!raw || typeof raw !== "object") return null;
  const view = raw as Record<string, unknown>;
  const id = asText(view.id);
  if (!id) return null;
  return {
    id,
    otpType: view.otpType === "hotp" ? "hotp" : "totp",
    issuer: asText(view.issuer),
    username: asText(view.username),
    hasSecret: view.hasSecret === true,
    algorithm: asText(view.algorithm) || "SHA1",
    digits: asNumber(view.digits, 6),
    period: asNumber(view.period, 30),
    counter: typeof view.counter === "number" && Number.isFinite(view.counter) ? view.counter : null,
  };
}

/** 解析 `otp/list` 的 entries；缺字段或非对象的行丢弃，不抛错。 */
export function parseOtpEntries(payload: unknown): OtpEntryView[] {
  const list = (payload as { entries?: unknown } | null | undefined)?.entries;
  if (!Array.isArray(list)) return [];
  return list.map(parseEntry).filter((entry): entry is OtpEntryView => entry !== null);
}

/** 解析 `otp/list` 的 bindings（connectionId -> entryId）。 */
export function parseOtpBindings(payload: unknown): Record<string, string> {
  const table = (payload as { bindings?: unknown } | null | undefined)?.bindings;
  if (!table || typeof table !== "object" || Array.isArray(table)) return {};
  const out: Record<string, string> = {};
  for (const [connectionId, entryId] of Object.entries(table as Record<string, unknown>)) {
    if (typeof entryId === "string" && entryId) out[connectionId] = entryId;
  }
  return out;
}

/** 某条目当前被绑定到的连接 ID 列表。 */
export function boundConnectionsOf(bindings: Record<string, string>, entryId: string): string[] {
  return Object.entries(bindings)
    .filter(([, boundEntryId]) => boundEntryId === entryId)
    .map(([connectionId]) => connectionId);
}

// ---------------------------------------------------------------------------
// otp/generate 响应 + 倒计时
// ---------------------------------------------------------------------------

export interface OtpCodeState {
  code: string;
  /** TOTP：本周期剩余秒；HOTP 无周期语义，恒为 0。 */
  remaining: number;
  /** TOTP：本窗口已被本面板取过码（后端窗口缓存拒绝重复生成）。 */
  reused: boolean;
}

/**
 * 解析 `otp/generate` 响应：
 *  - HOTP：`{ code, hotp: true }`（无剩余秒）。
 *  - TOTP：`{ code, remainingSeconds }` 或已用窗口的 `{ code: null, reused: true, remainingSeconds }`。
 * 解析不出 code 且非 reused 时返回 null（调用方保留旧状态）。
 */
export function parseGenerateResponse(payload: unknown): OtpCodeState | null {
  if (!payload || typeof payload !== "object") return null;
  const view = payload as Record<string, unknown>;
  const remaining = asNumber(view.remainingSeconds, 0);
  if (view.reused === true) return { code: "", remaining, reused: true };
  if (typeof view.code === "string" && view.code) return { code: view.code, remaining, reused: false };
  return null;
}

/** 每秒 tick：剩余秒递减，到 0 止（不出现负数）。 */
export function tickCountdown(remaining: number): number {
  return remaining > 0 ? remaining - 1 : 0;
}

/** 线性进度条百分比（0-100，整数），period 非法时返回 0。 */
export function countdownPercent(remaining: number, period: number): number {
  if (!Number.isFinite(remaining) || !Number.isFinite(period) || period <= 0) return 0;
  const percent = (Math.min(Math.max(remaining, 0), period) / period) * 100;
  return Math.round(percent);
}

/** 倒计时文案：两位数字补零（30s 周期习惯上显示 "07" 而非 "7"）。 */
export function formatCountdown(seconds: number): string {
  const clamped = Math.min(Math.max(Math.floor(Number.isFinite(seconds) ? seconds : 0), 0), 99);
  return String(clamped).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// 编辑草稿：otp/import-qr 预填 + otp/save 参数
// ---------------------------------------------------------------------------

export interface OtpDraft {
  /** 空串 = 新建；非空 = 编辑该条目。 */
  id: string;
  otpType: "totp" | "hotp";
  issuer: string;
  username: string;
  /** 编辑时留空 = 保留旧密钥（后端契约，见 otp_store::save_entry）。 */
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  /** HOTP 起始计数；文本形态便于空输入框校验。 */
  counter: string;
}

export function emptyOtpDraft(): OtpDraft {
  return { id: "", otpType: "totp", issuer: "", username: "", secret: "", algorithm: "SHA1", digits: 6, period: 30, counter: "" };
}

/** 从脱敏条目视图生成编辑草稿：密钥永不出库，secret 恒留空。 */
export function entryToDraft(entry: OtpEntryView): OtpDraft {
  return {
    id: entry.id,
    otpType: entry.otpType,
    issuer: entry.issuer,
    username: entry.username,
    secret: "",
    algorithm: entry.algorithm,
    digits: entry.digits,
    period: entry.period,
    counter: entry.counter === null ? "" : String(entry.counter),
  };
}

/** 列表展示用的稳定标签（issuer 优先，回退 username，再回退 otpType）。 */
export function entryLabel(entry: OtpEntryView): string {
  return entry.issuer || entry.username || entry.otpType;
}

/**
 * `otp/import-qr` 响应 → 预填草稿。label 按 Google Authenticator 约定是
 * `Issuer:account`，解析不出 account 时整段留空由用户补填。
 */
export function qrResponseToDraft(payload: unknown): OtpDraft | null {
  if (!payload || typeof payload !== "object") return null;
  const view = payload as Record<string, unknown>;
  const secret = asText(view.secretBase32);
  if (!secret) return null;
  const otpType = view.otpType === "hotp" ? "hotp" : "totp";
  const issuer = asText(view.issuer);
  const label = asText(view.label);
  const prefix = issuer ? `${issuer}:` : "";
  const account = prefix && label.startsWith(prefix)
    ? label.slice(prefix.length)
    : label.includes(":")
      ? label.slice(label.indexOf(":") + 1)
      : label;
  const digits = asNumber(view.digits, 6);
  const period = asNumber(view.period, 30);
  const counter = view.counter;
  return {
    id: "",
    otpType,
    issuer,
    username: account,
    secret,
    algorithm: asText(view.algorithm) || "SHA1",
    digits: digits >= 6 && digits <= 8 ? digits : 6,
    period: period >= 1 && period <= 3600 ? period : 30,
    counter: otpType === "hotp" && typeof counter === "number" && Number.isFinite(counter) ? String(counter) : "",
  };
}

/** `otp/save` 参数：编辑带 id；secret 留空不携带（保留旧密钥）；HOTP 才带 counter。 */
export function otpSaveParams(draft: OtpDraft): Record<string, unknown> {
  const params: Record<string, unknown> = {
    otpType: draft.otpType,
    issuer: draft.issuer.trim(),
    username: draft.username.trim(),
    algorithm: draft.algorithm,
    digits: draft.digits,
    period: draft.period,
  };
  if (draft.id) params.id = draft.id;
  if (draft.secret.trim()) params.secret = draft.secret.replace(/[\s-]/g, "").trim();
  if (draft.otpType === "hotp" && draft.counter.trim()) params.counter = Number(draft.counter);
  return params;
}

/** 新建 HOTP 必须给起始计数（后端契约）；返回错误码或空串。 */
export function otpDraftError(draft: OtpDraft): "" | "issuer" | "secret" | "counter" | "counterNumber" {
  if (!draft.issuer.trim()) return "issuer";
  if (!draft.id && !draft.secret.trim()) return "secret";
  if (draft.otpType === "hotp") {
    if (!draft.counter.trim()) return "counter";
    if (!/^\d+$/.test(draft.counter.trim())) return "counterNumber";
  }
  return "";
}

// ---------------------------------------------------------------------------
// 会话导入：流式预览与脱敏规范化导出
// ---------------------------------------------------------------------------

export type ImportKind = "moba" | "xshell" | "windterm" | "securecrt" | "finalshell" | "electerm" | "termius";

export const IMPORT_TOTAL_LIMIT = 64 * 1024 * 1024;
export const IMPORT_CHUNK_LIMIT = 256 * 1024;

export interface ImportSessionView {
  index: number;
  name: string;
  host: string;
  port: number | null;
  username: string;
  groupPath: string;
  description: string;
  authKind: string;
  hasSecret: boolean;
  secretNote: string;
}

function parseSessionView(raw: unknown, index: number): ImportSessionView | null {
  if (!raw || typeof raw !== "object") return null;
  const view = raw as Record<string, unknown>;
  const port = typeof view.port === "number" && Number.isFinite(view.port) ? view.port : null;
  return {
    index: typeof view.index === "number" && Number.isFinite(view.index) ? view.index : index,
    name: asText(view.name), host: asText(view.host), port, username: asText(view.username),
    groupPath: asText(view.groupPath), description: asText(view.description),
    authKind: asText(view.authKind), hasSecret: view.hasSecret === true, secretNote: asText(view.secretNote),
  };
}

/** 解析流式 `import/preview/finish` 的脱敏行。 */
export function parseImportSessions(payload: unknown): ImportSessionView[] {
  const list = (payload as { sessions?: unknown } | null | undefined)?.sessions;
  return Array.isArray(list) ? list.map(parseSessionView).filter((session): session is ImportSessionView => session !== null) : [];
}

/** 发起流式预览：主文件和可选 WindTerm user.config 共用 64 MiB 预算。 */
export function importPreviewStartParams(kind: ImportKind, mainSize: number, userConfigSize: number, masterPassword: string): Record<string, unknown> {
  const safeMain = Math.max(0, Math.floor(mainSize));
  const safeConfig = Math.max(0, Math.floor(userConfigSize));
  if (safeMain + safeConfig > IMPORT_TOTAL_LIMIT) throw new Error("import-size-limit");
  const params: Record<string, unknown> = { kind, mainSize: safeMain };
  if (kind === "windterm" && safeConfig) params.userConfigSize = safeConfig;
  if (kind === "windterm" && masterPassword) params.masterPassword = masterPassword;
  return params;
}

/** SFTP 同款二进制帧：8 字节 BE offset 后接至多 256 KiB 原始字节。 */
export function importPreviewChunk(offset: number, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > IMPORT_CHUNK_LIMIT) throw new Error("import-chunk-limit");
  const frame = new Uint8Array(8 + bytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setBigUint64(0, BigInt(offset));
  frame.set(bytes, 8);
  return frame;
}

/** 已知 WindTerm 主密码错误转成可翻译错误码。 */
export function importErrorCode(error: unknown): "" | "masterPassword" | "sizeLimit" {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/master password/i.test(message)) return "masterPassword";
  return /64\s*MiB|exceed.*limit|size-limit/i.test(message) ? "sizeLimit" : "";
}

// ---------------------------------------------------------------------------
// 杂项：文件 base64 + 活跃会话挑选
// ---------------------------------------------------------------------------

/** 二进制 → base64。分块拼接避免大文件触发 Function 参数长度上限。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export interface SendTargetSession {
  sessionId: string;
  connectionId?: string;
  workbenchId?: string;
  connected?: boolean;
}

/**
 * 挑选「发送验证码」的目标会话：优先本工作台（同 workbenchId）的活跃会话，
 * 其次同连接的其他会话；都不命中返回空串。connected === false 视为已死会话。
 */
export function pickSendTargetSession(
  sessions: unknown,
  connectionId: string,
  workbenchId: string,
): string {
  if (!Array.isArray(sessions)) return "";
  const live = sessions.filter((session): session is SendTargetSession => {
    if (!session || typeof session !== "object") return false;
    const view = session as Record<string, unknown>;
    return typeof view.sessionId === "string" && !!view.sessionId && view.connected !== false;
  });
  const sameWorkbench = live.find((session) => workbenchId && session.workbenchId === workbenchId);
  if (sameWorkbench) return sameWorkbench.sessionId;
  const sameConnection = live.find((session) => connectionId && session.connectionId === connectionId);
  return sameConnection ? sameConnection.sessionId : "";
}
