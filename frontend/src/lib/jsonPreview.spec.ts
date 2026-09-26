// jsonPreview 纯函数层单测（issue #96）：检测口径、降级链、字段树路径/截断、
// 大小保护与搜索过滤。全部不连 SSH、不碰 DOM。
import { describe, expect, it } from "vitest";
import {
  JSON_PREVIEW_MAX_BYTES,
  JSON_PREVIEW_MAX_FIELDS,
  buildJsonPreview,
  filterJsonFields,
  flattenJsonFields,
  isJsonPreviewCandidate,
  jsonValueType,
  sniffsJsonText,
} from "./jsonPreview";

describe("isJsonPreviewCandidate / sniffsJsonText", () => {
  it("accepts .json and .geojson by extension", () => {
    expect(isJsonPreviewCandidate("config.json", "")).toBe(true);
    expect(isJsonPreviewCandidate("CONFIG.JSON", "")).toBe(true);
    expect(isJsonPreviewCandidate("map.geojson", "")).toBe(true);
  });

  it("rejects line-delimited variants regardless of content", () => {
    expect(isJsonPreviewCandidate("events.jsonl", '{"a":1}\n{"a":2}\n')).toBe(false);
    expect(isJsonPreviewCandidate("trace.ndjson", '{"a":1}\n')).toBe(false);
  });

  it("sniffs only extension-less files whose first non-whitespace char is { or [", () => {
    expect(isJsonPreviewCandidate("config", '{"name":"dbx"}')).toBe(true);
    expect(isJsonPreviewCandidate("config", "  \n\t[1, 2]\n")).toBe(true);
    expect(isJsonPreviewCandidate("config", "#!/bin/sh\necho hi")).toBe(false);
    // 有扩展名的非 JSON 文件不嗅探：结构化日志（.log 开头即 {）不该被劫持成 JSON 视图。
    expect(isJsonPreviewCandidate("app.log", '{"level":"info"}')).toBe(false);
    expect(isJsonPreviewCandidate("data.txt", "[1,2]")).toBe(false);
    expect(sniffsJsonText(" \r\n{\"a\":1}")).toBe(true);
    expect(sniffsJsonText("null")).toBe(false);
  });
});

describe("jsonValueType", () => {
  it("classifies JSON scalar and container kinds", () => {
    expect(jsonValueType(null)).toBe("null");
    expect(jsonValueType(true)).toBe("boolean");
    expect(jsonValueType(42)).toBe("number");
    expect(jsonValueType("x")).toBe("string");
    expect(jsonValueType([])).toBe("array");
    expect(jsonValueType({})).toBe("object");
  });
});

describe("buildJsonPreview", () => {
  it("returns unavailable for non-JSON files", () => {
    expect(buildJsonPreview("notes.txt", "hello world")).toEqual({ kind: "unavailable" });
    expect(buildJsonPreview("", "plain text")).toEqual({ kind: "unavailable" });
  });

  it("pretty-prints with 2-space indent and flattens nested field paths", () => {
    const state = buildJsonPreview("a.json", '{"name":"dbx","nested":{"deep":[ {"id":1} ]}}');
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.pretty).toBe('{\n  "name": "dbx",\n  "nested": {\n    "deep": [\n      {\n        "id": 1\n      }\n    ]\n  }\n}\n');
    const paths = state.fields.map((field) => field.path);
    expect(paths).toEqual(["$.name", "$.nested.deep[0].id"]);
    expect(state.fields[0]).toMatchObject({ key: "name", value: "dbx", fullValue: "dbx", type: "string" });
    expect(state.fields[1]).toMatchObject({ path: "$.nested.deep[0].id", key: "id", value: "1", fullValue: "1", type: "number" });
  });

  it("degrades to invalid when the content does not parse", () => {
    expect(buildJsonPreview("broken.json", "{oops")).toEqual({ kind: "invalid" });
    // 空内容（加载失败占位等）同样按非法处理，不抛错。
    expect(buildJsonPreview("empty.json", "")).toEqual({ kind: "invalid" });
  });

  it("skips parse entirely when content is truncated or above the byte cap", () => {
    expect(buildJsonPreview("big.json", '{"a":1}', { truncated: true })).toEqual({ kind: "too-large" });
    expect(buildJsonPreview("big.json", '{"a":1}', { byteLength: JSON_PREVIEW_MAX_BYTES + 1 })).toEqual({ kind: "too-large" });
    // 恰好等于上限仍可解析。
    expect(buildJsonPreview("big.json", '{"a":1}', { byteLength: JSON_PREVIEW_MAX_BYTES })).toEqual({
      kind: "ok",
      pretty: '{\n  "a": 1\n}\n',
      fields: [{ path: "$.a", key: "a", value: "1", fullValue: "1", type: "number" }],
    });
  });

  it("keeps full string values copyable while truncating long display values", () => {
    const long = "x".repeat(500);
    const state = buildJsonPreview("s.json", JSON.stringify({ text: long }));
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.fields[0].value.length).toBeLessThan(long.length);
    expect(state.fields[0].value.endsWith("…")).toBe(true);
    expect(state.fields[0].fullValue).toBe(long);
  });

  it("treats empty containers as leaf rows and quotes non-identifier keys", () => {
    const state = buildJsonPreview("e.json", '{"empty":{},"list":[],"weird key":true,"tag":{"in ner":null}}');
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    const byPath = new Map(state.fields.map((field) => [field.path, field]));
    expect(byPath.get("$.empty")).toMatchObject({ value: "{}", fullValue: "{}", type: "object" });
    expect(byPath.get("$.list")).toMatchObject({ value: "[]", fullValue: "[]", type: "array" });
    expect(byPath.get('$["weird key"]')).toMatchObject({ value: "true", type: "boolean" });
    expect(byPath.get('$.tag["in ner"]')).toMatchObject({ value: "null", fullValue: "null", type: "null" });
  });

  it("handles scalar roots and array roots", () => {
    const scalar = buildJsonPreview("n.json", "42");
    expect(scalar.kind).toBe("ok");
    if (scalar.kind === "ok") expect(scalar.fields).toEqual([{ path: "$", key: "$", value: "42", fullValue: "42", type: "number" }]);
    const array = buildJsonPreview("arr.json", '[{"id":1},{"id":2}]');
    expect(array.kind).toBe("ok");
    if (array.kind === "ok") {
      expect(array.fields.map((field) => field.path)).toEqual(["$[0].id", "$[1].id"]);
      expect(array.fields.map((field) => field.key)).toEqual(["id", "id"]);
    }
  });

  it("caps the field list for wide structures", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < JSON_PREVIEW_MAX_FIELDS + 50; index += 1) wide[`k${index}`] = index;
    const state = buildJsonPreview("wide.json", JSON.stringify(wide));
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.fields.length).toBe(JSON_PREVIEW_MAX_FIELDS);
  });

  it("survives deep nesting without crashing or overrunning the depth cap", () => {
    const depth = 600;
    let text = "1";
    for (let index = 0; index < depth; index += 1) text = `[${text}]`;
    // JSON.parse 在该深度可成功；展平只收集到深度上限为止。
    const state = buildJsonPreview("deep.json", text);
    expect(["ok", "invalid"]).toContain(state.kind);
    if (state.kind === "ok") expect(state.fields.length).toBeLessThanOrEqual(1);
  });
});

describe("flattenJsonFields", () => {
  it("emits rows in document order for mixed containers", () => {
    const fields = flattenJsonFields({ a: 1, b: { c: "x" }, d: [true, null] });
    expect(fields.map((field) => field.path)).toEqual(["$.a", "$.b.c", "$.d[0]", "$.d[1]"]);
    expect(fields.map((field) => field.type)).toEqual(["number", "string", "boolean", "null"]);
  });
});

describe("filterJsonFields", () => {
  const fields = flattenJsonFields({ user: { name: "alice", tags: ["ops"] }, port: 22 });

  it("matches paths and values case-insensitively and trims the query", () => {
    expect(filterJsonFields(fields, " user ").map((field) => field.path)).toEqual(["$.user.name", "$.user.tags[0]"]);
    expect(filterJsonFields(fields, "ALICE").map((field) => field.path)).toEqual(["$.user.name"]);
    expect(filterJsonFields(fields, "22").map((field) => field.path)).toEqual(["$.port"]);
  });

  it("returns the original list for blank queries", () => {
    expect(filterJsonFields(fields, "   ")).toBe(fields);
    expect(filterJsonFields(fields, "")).toBe(fields);
    expect(filterJsonFields(fields, "nope")).toEqual([]);
  });
});
