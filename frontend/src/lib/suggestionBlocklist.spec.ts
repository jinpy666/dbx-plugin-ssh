// @vitest-environment happy-dom
// 建议黑名单纯逻辑单测（批 4c）：pluginStore 以 mockDbxHost 的 localStorage
// 兜底档承载，这里直接驱动存取函数验证去重/置顶/截断/容错。
import { beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_STORE_KEYS } from "./pluginStore";
import { addToSuggestionBlocklist, clearSuggestionBlocklist, loadSuggestionBlocklist } from "./suggestionBlocklist";

describe("suggestionBlocklist (批 4c, Warp IgnoredSuggestions 语义)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("registers its key in PLUGIN_STORE_KEYS (host hydration whitelist)", () => {
    // 宿主 storage 水合只拉白名单键：漏注册 = 黑名单每次启动整体复活。
    expect(PLUGIN_STORE_KEYS).toContain("ssh-suggestion-blocklist");
  });

  it("starts empty and round-trips additions", () => {
    expect(loadSuggestionBlocklist()).toEqual([]);
    const next = addToSuggestionBlocklist("docker compose up -d", loadSuggestionBlocklist());
    expect(next).toEqual(["docker compose up -d"]);
    expect(loadSuggestionBlocklist()).toEqual(["docker compose up -d"]);
  });

  it("dedupes and moves repeated entries to the front", () => {
    let list = addToSuggestionBlocklist("a", []);
    list = addToSuggestionBlocklist("b", list);
    list = addToSuggestionBlocklist("a", list);
    expect(list).toEqual(["a", "b"]);
  });

  it("ignores blank commands and caps the list at 100 entries", () => {
    let list: string[] = [];
    expect(addToSuggestionBlocklist("   ", list)).toBe(list);
    for (let i = 0; i < 120; i += 1) list = addToSuggestionBlocklist(`cmd-${i}`, list);
    expect(list).toHaveLength(100);
    expect(list[0]).toBe("cmd-119");
    expect(loadSuggestionBlocklist()).toHaveLength(100);
  });

  it("clears and persists the empty list", () => {
    addToSuggestionBlocklist("a", []);
    expect(clearSuggestionBlocklist()).toEqual([]);
    expect(loadSuggestionBlocklist()).toEqual([]);
  });
});
