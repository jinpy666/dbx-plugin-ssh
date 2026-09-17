import { describe, expect, it } from "vitest";
import {
  PURPOSE_KEY_TO_I18N,
  purposeKeyLabel,
  sanitizeTriagePayload,
  severityClass,
  TRIAGE_PAYLOAD_LIMIT,
} from "./alertTriage";

describe("triage payload sanitization", () => {
  it("trims surrounding whitespace and passes short payloads through", () => {
    expect(sanitizeTriagePayload("  {\"title\":\"ok\"}  ")).toBe("{\"title\":\"ok\"}");
    expect(sanitizeTriagePayload("\n\t uptime \r\n")).toBe("uptime");
    expect(sanitizeTriagePayload("")).toBe("");
    expect(sanitizeTriagePayload("   ")).toBe("");
  });

  it("truncates payloads beyond 64 KiB", () => {
    expect(TRIAGE_PAYLOAD_LIMIT).toBe(65_536);
    const oversized = "x".repeat(TRIAGE_PAYLOAD_LIMIT + 100);
    const clamped = sanitizeTriagePayload(oversized);
    expect(clamped).toHaveLength(TRIAGE_PAYLOAD_LIMIT);
    // 已在限内的 payload 原样返回，不做多余拷贝语义。
    const exact = "y".repeat(TRIAGE_PAYLOAD_LIMIT);
    expect(sanitizeTriagePayload(exact)).toBe(exact);
  });
});

describe("severity classification", () => {
  it("maps critical synonyms to critical (case-insensitive)", () => {
    expect(severityClass("critical")).toBe("critical");
    expect(severityClass("FATAL")).toBe("critical");
    expect(severityClass(" Critical ")).toBe("critical");
  });

  it("maps warning synonyms to warning", () => {
    expect(severityClass("warning")).toBe("warning");
    expect(severityClass("WARN")).toBe("warning");
  });

  it("maps info synonyms to info", () => {
    expect(severityClass("info")).toBe("info");
    expect(severityClass("Notice")).toBe("info");
  });

  it("falls back to unknown for anything else", () => {
    expect(severityClass("error")).toBe("unknown");
    expect(severityClass("")).toBe("unknown");
    expect(severityClass("   ")).toBe("unknown");
    expect(severityClass("page")).toBe("unknown");
  });
});

describe("purposeKey → i18n mapping", () => {
  it("keeps the full backend contract as an isomorphic mapping", () => {
    const expectedKeys = [
      "loadSnapshot",
      "cpuTop",
      "cpuTopProcesses",
      "cpuVmstat",
      "memFree",
      "memTopProcesses",
      "diskUsage",
      "diskDu",
      "diskInode",
      "netSummary",
      "netLinks",
      "oomDmesg",
      "oomJournal",
      "serviceStatus",
      "serviceJournal",
    ];
    expect(Object.keys(PURPOSE_KEY_TO_I18N).sort()).toEqual([...expectedKeys].sort());
    for (const purposeKey of expectedKeys) {
      expect(PURPOSE_KEY_TO_I18N[purposeKey]).toBe(`alertTriage.purpose.${purposeKey}`);
    }
  });

  it("labels known purposeKeys through the i18n lookup", () => {
    const seen: string[] = [];
    const t = (key: string) => {
      seen.push(key);
      return `«${key}»`;
    };
    expect(purposeKeyLabel("memFree", t)).toBe("«alertTriage.purpose.memFree»");
    expect(seen).toEqual(["alertTriage.purpose.memFree"]);
  });

  it("falls back to the raw purposeKey when unknown to the table", () => {
    const seen: string[] = [];
    const t = (key: string) => {
      seen.push(key);
      return `translated:${key}`;
    };
    expect(purposeKeyLabel("gpuMetrics", t)).toBe("gpuMetrics");
    expect(seen).toEqual([]);
  });
});
