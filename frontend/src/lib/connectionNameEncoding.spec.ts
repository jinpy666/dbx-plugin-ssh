import { describe, expect, it } from "vitest";
import {
  choiceFromOverride,
  effectiveNameEncoding,
  mergeNameEncodingStore,
  normalizeNameEncodingOverride,
  overrideFromChoice,
  SFTP_NAME_ENCODING_OVERRIDES_MAX,
} from "./connectionNameEncoding";

describe("connection name encoding control semantics", () => {
  it("normalizes stored values against the auto/latin-1 whitelist", () => {
    expect(normalizeNameEncodingOverride("auto")).toBe("auto");
    expect(normalizeNameEncodingOverride("latin-1")).toBe("latin-1");
    // 白名单外（gbk）/非字符串一律未覆盖——由全局偏好兜底。
    for (const bad of ["gbk", "", "AUTO", 7, null, undefined, {}]) {
      expect(normalizeNameEncodingOverride(bad)).toBeNull();
    }
  });

  it("maps store buckets to the three-state control and back", () => {
    expect(choiceFromOverride("latin-1")).toBe("latin-1");
    expect(choiceFromOverride("auto")).toBe("auto");
    for (const bad of ["gbk", undefined, 7]) {
      expect(choiceFromOverride(bad)).toBe("follow");
    }
    expect(overrideFromChoice("follow")).toBeNull();
    expect(overrideFromChoice("auto")).toBe("auto");
    expect(overrideFromChoice("latin-1")).toBe("latin-1");
  });

  it("resolves effective encoding: connection override > global > auto default", () => {
    expect(effectiveNameEncoding("latin-1", "auto")).toBe("latin-1");
    expect(effectiveNameEncoding(null, "latin-1")).toBe("latin-1");
    expect(effectiveNameEncoding(null, null)).toBe("auto");
    // 白名单回退：覆盖非法回全局，全局也非法回缺省。
    expect(effectiveNameEncoding("gbk", "latin-1")).toBe("latin-1");
    expect(effectiveNameEncoding("gbk", "gbk")).toBe("auto");
  });

  it("merges read-modify-write stores, dropping invalid buckets and capping size", () => {
    // 非对象 store 按空表处理。
    expect(mergeNameEncodingStore("junk", "conn-1", "auto")).toEqual({ "conn-1": "auto" });
    expect(mergeNameEncodingStore(null, "conn-1", "latin-1")).toEqual({ "conn-1": "latin-1" });
    // 保留其他连接的合法桶；非法桶与空键丢弃；本连接桶被替换。
    const merged = mergeNameEncodingStore(
      { "conn-1": "auto", "conn-2": "latin-1", "conn-3": "gbk", "": "auto", "conn-4": 7 },
      "conn-1",
      "latin-1",
    );
    expect(merged).toEqual({ "conn-2": "latin-1", "conn-1": "latin-1" });
    // 「跟随全局」= 删除本连接桶，其他连接保留。
    const removed = mergeNameEncodingStore({ "conn-1": "auto", "conn-2": "latin-1" }, "conn-1", null);
    expect(removed).toEqual({ "conn-2": "latin-1" });
    // 超限截断：其他桶最多保留上限个，目标连接仍写入。
    const full: Record<string, string> = {};
    for (let i = 0; i < SFTP_NAME_ENCODING_OVERRIDES_MAX + 5; i += 1) {
      full[`conn-${i}`] = "auto";
    }
    const capped = mergeNameEncodingStore(full, "target", "latin-1");
    expect(Object.keys(capped).length).toBe(SFTP_NAME_ENCODING_OVERRIDES_MAX);
    expect(capped.target).toBe("latin-1");
  });
});
