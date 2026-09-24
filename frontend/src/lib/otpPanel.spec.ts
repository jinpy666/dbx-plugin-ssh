// otpPanel 纯逻辑测试：otp/list 与 import/parse 的容错解析、otp/generate
// 三种响应形态、倒计时换算、QR 响应到编辑草稿的映射、save/commit 参数构造、
// base64 分块编码与发送目标会话挑选。
import { describe, expect, it } from "vitest";
import {
  boundConnectionsOf,
  bytesToBase64,
  countdownPercent,
  emptyOtpDraft,
  entryLabel,
  entryToDraft,
  formatCountdown,
  importBaseParams,
  importCommitParams,
  importErrorCode,
  otpDraftError,
  otpSaveParams,
  parseGenerateResponse,
  parseImportResult,
  parseImportSessions,
  parseOtpBindings,
  parseOtpEntries,
  pickSendTargetSession,
  qrResponseToDraft,
  tickCountdown,
} from "./otpPanel";

describe("otp/list parsing", () => {
  it("parses entries and bindings from the sanitized views", () => {
    const payload = {
      entries: [
        { id: "e1", otpType: "totp", issuer: "ACME", username: "dev", hasSecret: true, algorithm: "SHA1", digits: 6, period: 30, counter: null },
        { id: "e2", otpType: "hotp", issuer: "", username: "ops", hasSecret: true, algorithm: "SHA256", digits: 8, period: 30, counter: 4 },
      ],
      bindings: { "conn-1": "e1", "conn-2": "e2" },
    };
    const entries = parseOtpEntries(payload);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "e1", otpType: "totp", counter: null });
    expect(entries[1]).toMatchObject({ id: "e2", otpType: "hotp", counter: 4 });
    expect(parseOtpBindings(payload)).toEqual({ "conn-1": "e1", "conn-2": "e2" });
    expect(boundConnectionsOf(parseOtpBindings(payload), "e1")).toEqual(["conn-1"]);
    expect(boundConnectionsOf(parseOtpBindings(payload), "e3")).toEqual([]);
  });

  it("drops malformed rows and tolerates missing sections", () => {
    expect(parseOtpEntries({})).toEqual([]);
    expect(parseOtpEntries({ entries: null })).toEqual([]);
    expect(parseOtpEntries({ entries: [null, {}, { id: "" }, "x", { id: "ok" }] })).toEqual([
      { id: "ok", otpType: "totp", issuer: "", username: "", hasSecret: false, algorithm: "SHA1", digits: 6, period: 30, counter: null },
    ]);
    expect(parseOtpBindings({})).toEqual({});
    expect(parseOtpBindings({ bindings: [] })).toEqual({});
    expect(parseOtpBindings({ bindings: { a: "", b: "e1", c: 3 } })).toEqual({ b: "e1" });
  });
});

describe("otp/generate responses", () => {
  it("parses the three documented shapes", () => {
    expect(parseGenerateResponse({ code: "123456", remainingSeconds: 21 })).toEqual({ code: "123456", remaining: 21, reused: false });
    expect(parseGenerateResponse({ code: null, reused: true, remainingSeconds: 9 })).toEqual({ code: "", remaining: 9, reused: true });
    expect(parseGenerateResponse({ code: "654321", hotp: true })).toEqual({ code: "654321", remaining: 0, reused: false });
    expect(parseGenerateResponse({})).toBeNull();
    expect(parseGenerateResponse(null)).toBeNull();
    expect(parseGenerateResponse({ code: "" })).toBeNull();
  });
});

describe("countdown helpers", () => {
  it("ticks down and floors at zero", () => {
    expect(tickCountdown(30)).toBe(29);
    expect(tickCountdown(1)).toBe(0);
    expect(tickCountdown(0)).toBe(0);
    expect(tickCountdown(-3)).toBe(0);
  });

  it("maps remaining seconds onto a clamped linear percent", () => {
    expect(countdownPercent(30, 30)).toBe(100);
    expect(countdownPercent(15, 30)).toBe(50);
    expect(countdownPercent(0, 30)).toBe(0);
    expect(countdownPercent(45, 30)).toBe(100);
    expect(countdownPercent(10, 0)).toBe(0);
    expect(countdownPercent(Number.NaN, 30)).toBe(0);
  });

  it("formats countdowns with two digits", () => {
    expect(formatCountdown(7)).toBe("07");
    expect(formatCountdown(30)).toBe("30");
    expect(formatCountdown(0)).toBe("00");
    expect(formatCountdown(100)).toBe("99");
    expect(formatCountdown(Number.NaN)).toBe("00");
  });
});

describe("draft helpers", () => {
  it("prefills a draft from a sanitized entry with the secret left empty", () => {
    const draft = entryToDraft({ id: "e1", otpType: "hotp", issuer: "ACME", username: "dev", hasSecret: true, algorithm: "SHA512", digits: 8, period: 30, counter: 7 });
    expect(draft).toEqual({ id: "e1", otpType: "hotp", issuer: "ACME", username: "dev", secret: "", algorithm: "SHA512", digits: 8, period: 30, counter: "7" });
  });

  it("falls back through issuer/username/type for the display label", () => {
    const entry = { id: "e1", otpType: "totp" as const, issuer: "ACME", username: "dev", hasSecret: true, algorithm: "SHA1", digits: 6, period: 30, counter: null };
    expect(entryLabel(entry)).toBe("ACME");
    expect(entryLabel({ ...entry, issuer: "" })).toBe("dev");
    expect(entryLabel({ ...entry, issuer: "", username: "" })).toBe("totp");
  });

  it("maps QR responses onto prefilled drafts", () => {
    const draft = qrResponseToDraft({ otpType: "totp", issuer: "ACME", label: "ACME:dev@example.com", secretBase32: "GEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 8, period: 60, counter: null });
    expect(draft).toEqual({ id: "", otpType: "totp", issuer: "ACME", username: "dev@example.com", secret: "GEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 8, period: 60, counter: "" });
    const fallback = qrResponseToDraft({ otpType: "hotp", issuer: "", label: "plain:ops", secretBase32: "JBSW", algorithm: "SHA1", digits: 0, period: 0, counter: 3 });
    expect(fallback).toMatchObject({ otpType: "hotp", username: "ops", digits: 6, period: 30, counter: "3" });
    expect(qrResponseToDraft({})).toBeNull();
    expect(qrResponseToDraft({ secretBase32: "" })).toBeNull();
  });

  it("builds save params: id only when editing, secret only when set, counter only for hotp", () => {
    const created = otpSaveParams({ id: "", otpType: "totp", issuer: " ACME ", username: " dev ", secret: "gezd gnbv", algorithm: "SHA1", digits: 6, period: 30, counter: "" });
    expect(created).toEqual({ otpType: "totp", issuer: "ACME", username: "dev", secret: "gezdgnbv", algorithm: "SHA1", digits: 6, period: 30 });
    const edited = otpSaveParams({ id: "e1", otpType: "totp", issuer: "ACME", username: "", secret: "", algorithm: "SHA1", digits: 6, period: 30, counter: "" });
    expect(edited).toEqual({ otpType: "totp", issuer: "ACME", username: "", algorithm: "SHA1", digits: 6, period: 30, id: "e1" });
    const hotp = otpSaveParams({ id: "", otpType: "hotp", issuer: "ACME", username: "", secret: "GEZD", algorithm: "SHA1", digits: 6, period: 30, counter: "5" });
    expect(hotp).toMatchObject({ otpType: "hotp", counter: 5 });
    // 小写/带分隔符的 base32 原样去除空白后提交（大小写由后端归一化）。
    expect(otpSaveParams({ id: "", otpType: "totp", issuer: "ACME", username: "dev", secret: "gezd gnbv", algorithm: "SHA1", digits: 6, period: 30, counter: "" })).toMatchObject({ secret: "gezdgnbv" });
  });

  it("validates drafts against the backend contract", () => {
    const base = { ...emptyOtpDraft(), issuer: "ACME", secret: "GEZD" };
    expect(otpDraftError(base)).toBe("");
    expect(otpDraftError({ ...base, issuer: " " })).toBe("issuer");
    expect(otpDraftError({ ...base, secret: "" })).toBe("secret");
    const editing = { ...base, id: "e1", secret: "" };
    expect(otpDraftError(editing)).toBe("");
    expect(otpDraftError({ ...editing, otpType: "hotp", counter: "" })).toBe("counter");
    expect(otpDraftError({ ...editing, otpType: "hotp", counter: "abc" })).toBe("counterNumber");
    expect(otpDraftError({ ...editing, otpType: "hotp", counter: "5" })).toBe("");
  });
});

describe("import wizard helpers", () => {
  it("parses sanitized previews with stable indexes", () => {
    const sessions = parseImportSessions({ sessions: [
      { index: 0, name: "web-1", host: "10.0.0.1", port: 22, username: "dev", groupPath: "Prod/Web", description: "", authKind: "password", hasSecret: true },
      { name: "no-index", host: "10.0.0.2" },
    ] });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ index: 0, name: "web-1", port: 22, hasSecret: true });
    expect(sessions[1]).toMatchObject({ index: 1, name: "no-index", port: null });
    // secretNote 原因码随预览透传；缺失时为空串。
    expect(sessions[0]).toMatchObject({ secretNote: "" });
    const noted = parseImportSessions({ sessions: [
      { index: 0, name: "fw", host: "h", port: 22, username: "root", groupPath: "", description: "", authKind: "password", hasSecret: false, secretNote: "encrypted" },
    ] });
    expect(noted[0]).toMatchObject({ secretNote: "encrypted", hasSecret: false });
    expect(parseImportSessions({})).toEqual([]);
    expect(parseImportSessions({ sessions: "x" })).toEqual([]);
  });

  it("parses commit results", () => {
    expect(parseImportResult({ imported: 3, skipped: 1 })).toEqual({ imported: 3, skipped: 1 });
    expect(parseImportResult({})).toEqual({ imported: 0, skipped: 0 });
  });

  it("builds base params carrying optional WindTerm fields only when set", () => {
    expect(importBaseParams("moba", "QUJD", "", "")).toEqual({ kind: "moba", fileBase64: "QUJD" });
    expect(importBaseParams("windterm", "QUJD", "VVNFUg==", "pw")).toEqual({ kind: "windterm", fileBase64: "QUJD", userConfigBase64: "VVNFUg==", masterPassword: "pw" });
    const commit = importCommitParams("xshell", "QUJD", "", "", [0, 2]);
    expect(commit).toEqual({ kind: "xshell", fileBase64: "QUJD", selectedIndexes: [0, 2] });
    // M7 四来源 kind 与普通文件参数一致（无附加字段）。
    for (const kind of ["securecrt", "finalshell", "electerm", "termius"] as const) {
      expect(importBaseParams(kind, "QQ==", "eHg=", "pw")).toEqual({ kind, fileBase64: "QQ==" });
    }
  });

  it("maps the WindTerm master-password contract error", () => {
    expect(importErrorCode(new Error("WindTerm master password is required"))).toBe("masterPassword");
    expect(importErrorCode(new Error("boom"))).toBe("");
    expect(importErrorCode("WindTerm MASTER PASSWORD is required")).toBe("masterPassword");
  });
});

describe("bytesToBase64", () => {
  it("round-trips small and chunked payloads", () => {
    expect(bytesToBase64(new TextEncoder().encode("ABC"))).toBe(btoa("ABC"));
    const big = new Uint8Array(0x8000 + 3).map((_, index) => index % 251);
    const encoded = bytesToBase64(big);
    expect(encoded.length).toBe(Math.ceil(big.length / 3) * 4);
    const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(big);
  });
});

describe("pickSendTargetSession", () => {
  const sessions = [
    { sessionId: "s-other-conn", connectionId: "conn-b", workbenchId: "wb-9", connected: true },
    { sessionId: "s-same-wb", connectionId: "conn-a", workbenchId: "wb-1", connected: true },
    { sessionId: "s-dead", connectionId: "conn-a", workbenchId: "wb-2", connected: false },
    { sessionId: "s-same-conn", connectionId: "conn-a", workbenchId: "wb-2", connected: true },
    "garbage",
  ];

  it("prefers the live session of the current workbench, then the connection", () => {
    expect(pickSendTargetSession(sessions, "conn-a", "wb-1")).toBe("s-same-wb");
    // 同 workbench 的会话在另一连接上：workbench 优先于连接匹配。
    expect(pickSendTargetSession(sessions, "conn-z", "wb-9")).toBe("s-other-conn");
    // 无同 workbench 会话时回退到同连接的第一个活跃会话。
    expect(pickSendTargetSession(sessions, "conn-a", "wb-404")).toBe("s-same-wb");
  });

  it("skips dead sessions and returns empty when nothing matches", () => {
    expect(pickSendTargetSession(sessions, "conn-c", "wb-404")).toBe("");
    expect(pickSendTargetSession([], "conn-a", "wb-1")).toBe("");
    expect(pickSendTargetSession(null, "conn-a", "wb-1")).toBe("");
  });
});
