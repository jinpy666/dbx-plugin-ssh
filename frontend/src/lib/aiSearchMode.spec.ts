// `#` AI 命令搜索状态机单测（Warp AI 对齐批）：进入/输入/提交/退出与门。
import { describe, expect, it } from "vitest";
import { AI_SEARCH_QUERY_MAX, canActivateAiSearch, classifyAiSearchInput, createAiSearchState, nextAiSearchState } from "./aiSearchMode";

const openGates = { alternateActive: false, commandRunning: false, transferBusy: false, suggestionOpen: false, completionOpen: false, historyPanelOpen: false, quickSelectOpen: false, searchOpen: false };

describe("classifyAiSearchInput", () => {
  it("单可打印 / 退格 / 回车 / Esc / Ctrl+C 各归其类", () => {
    expect(classifyAiSearchInput("a")).toEqual({ kind: "printable", char: "a" });
    expect(classifyAiSearchInput("\u007f")).toEqual({ kind: "backspace" });
    expect(classifyAiSearchInput("\r")).toEqual({ kind: "submit" });
    expect(classifyAiSearchInput("\u001b")).toEqual({ kind: "cancel" });
    expect(classifyAiSearchInput("\u0003")).toEqual({ kind: "cancel" });
  });

  it("纯可打印批次并入，含控制字符/CSI 归 abort", () => {
    expect(classifyAiSearchInput("list files")).toEqual({ kind: "printableBatch", text: "list files" });
    expect(classifyAiSearchInput("a\tb")).toEqual({ kind: "abort" });
    expect(classifyAiSearchInput("\u001b[A")).toEqual({ kind: "abort" });
    expect(classifyAiSearchInput("")).toEqual({ kind: "abort" });
  });
});

describe("nextAiSearchState", () => {
  it("未激活时事件原样返回（激活由 App 显式驱动）", () => {
    const state = createAiSearchState();
    expect(nextAiSearchState(state, { kind: "printable", char: "a" })).toEqual({ state, action: "none" });
  });

  it("printable 累积 query，backspace 回退，退到空退出", () => {
    let state = { active: true, query: "" };
    state = nextAiSearchState(state, { kind: "printable", char: "l" }).state;
    state = nextAiSearchState(state, { kind: "printableBatch", text: "s -la" }).state;
    expect(state.query).toBe("ls -la");
    state = nextAiSearchState(state, { kind: "backspace" }).state;
    expect(state.query).toBe("ls -l");
    const back = nextAiSearchState({ active: true, query: "" }, { kind: "backspace" });
    expect(back.state.active).toBe(false);
    expect(back.action).toBe("cancel");
  });

  it("submit 清空并上抛动作；cancel/abort 退出", () => {
    const submit = nextAiSearchState({ active: true, query: "ls" }, { kind: "submit" });
    expect(submit.action).toBe("submit");
    expect(submit.state.active).toBe(false);
    expect(nextAiSearchState({ active: true, query: "ls" }, { kind: "cancel" }).action).toBe("cancel");
    expect(nextAiSearchState({ active: true, query: "ls" }, { kind: "abort" }).action).toBe("cancel");
  });

  it("query 超长截断", () => {
    const state = nextAiSearchState({ active: true, query: "a".repeat(AI_SEARCH_QUERY_MAX) }, { kind: "printable", char: "b" });
    expect(state.state.query.length).toBe(AI_SEARCH_QUERY_MAX);
  });
});

describe("canActivateAiSearch", () => {
  it("门全净才可激活", () => {
    expect(canActivateAiSearch(openGates)).toBe(true);
    for (const key of Object.keys(openGates) as Array<keyof typeof openGates>) {
      expect(canActivateAiSearch({ ...openGates, [key]: true })).toBe(false);
    }
  });
});
