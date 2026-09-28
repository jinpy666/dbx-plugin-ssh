// @vitest-environment node
// Windows shell 内建候选（shellBuiltins）：提示符判定、前缀候选、source
// 包装器的透传/兜底语义（同步与 thenable 两种内层形态）。
import { describe, expect, it } from "vitest";
import {
  detectShellKind,
  shellBuiltinItems,
  withShellBuiltinsSource,
} from "./shellBuiltins";
import type { FigCompletionSource, FigSourceRequest } from "../fig/source";
import type { CompletionResponse } from "../core/types";

function makeRequest(overrides: Partial<FigSourceRequest> = {}): FigSourceRequest {
  return {
    line: "get-ch",
    requestId: 7,
    revision: 3,
    sessionId: "s1",
    trigger: "typing",
    ...overrides,
  };
}

const readyResponse = (items: number): CompletionResponse => ({
  requestId: 7,
  revision: 3,
  state: "ready",
  items: Array.from({ length: items }, (_, index) => ({
    id: `fig:${index}`,
    label: `cmd${index}`,
    kind: "command",
    score: 100,
    source: "fig-spec",
    edit: { text: `cmd${index} `, replaceStart: 0, replaceEnd: 4 },
  })),
});

describe("detectShellKind", () => {
  it("recognizes PowerShell drive prompts", () => {
    expect(detectShellKind("PS C:\\Users\\demo>")).toBe("powershell");
    expect(detectShellKind("PS C:\\Users\\demo>get-ch")).toBe("powershell");
    expect(detectShellKind("  PS D:\\>")).toBe("powershell");
  });

  it("recognizes cmd drive prompts", () => {
    expect(detectShellKind("C:\\Users\\demo>")).toBe("cmd");
    expect(detectShellKind("D:\\>cd ")).toBe("cmd");
  });

  it("rejects posix prompts and non-prompt lines", () => {
    expect(detectShellKind("demo@server:~$ ls")).toBeNull();
    expect(detectShellKind("demo@server ~ % ")).toBeNull();
    expect(detectShellKind("total 24")).toBeNull();
    expect(detectShellKind("")).toBeNull();
  });
});

describe("shellBuiltinItems", () => {
  it("filters powershell cmdlets by case-insensitive prefix", () => {
    const items = shellBuiltinItems("powershell", "get-ch", 0, 6);
    expect(items[0]?.label).toBe("Get-ChildItem");
    expect(items[0]?.kind).toBe("command");
    expect(items[0]?.source).toBe("shell-builtin");
    expect(items.every((item) => item.label.toLowerCase().startsWith("get-ch"))).toBe(true);
  });

  it("filters cmd builtins and fills a trailing space edit", () => {
    const items = shellBuiltinItems("cmd", "task", 0, 4);
    expect(items.map((item) => item.label)).toEqual(["taskkill", "tasklist"]);
    expect(items[0]?.edit).toMatchObject({ text: "taskkill ", replaceStart: 0, replaceEnd: 4, cursorOffset: 9 });
  });

  it("returns nothing for an unrelated prefix", () => {
    expect(shellBuiltinItems("powershell", "zzz", 0, 3)).toHaveLength(0);
  });
});

describe("withShellBuiltinsSource", () => {
  it("passes through non-empty ready responses untouched", () => {
    const inner: FigCompletionSource = { id: "fig", resolve: () => readyResponse(2) };
    const wrapped = withShellBuiltinsSource(inner, () => "powershell");
    const response = wrapped.resolve(makeRequest());
    expect(response && "state" in response ? response.items : []).toHaveLength(2);
  });

  it("falls back to builtins at the command-name position when the engine passes through", () => {
    const inner: FigCompletionSource = { id: "fig", resolve: () => null };
    const wrapped = withShellBuiltinsSource(inner, () => "powershell");
    const response = wrapped.resolve(makeRequest({ line: "get-ch" }));
    expect(response?.state).toBe("ready");
    expect(response?.items[0]?.label).toBe("Get-ChildItem");
    // 编辑范围 = 命令名 token 的 [0, 6)，接受后补尾随空格
    expect(response?.items[0]?.edit).toMatchObject({ replaceStart: 0, replaceEnd: 6 });
  });

  it("stays out of multi-token and trailing-space positions", () => {
    const inner: FigCompletionSource = { id: "fig", resolve: () => null };
    const wrapped = withShellBuiltinsSource(inner, () => "powershell");
    expect(wrapped.resolve(makeRequest({ line: "sudo get-ch" }))).toBeNull();
    expect(wrapped.resolve(makeRequest({ line: "get-ch " }))).toBeNull();
    expect(wrapped.resolve(makeRequest({ line: "" }))).toBeNull();
  });

  it("does nothing without a detected windows shell", () => {
    const inner: FigCompletionSource = { id: "fig", resolve: () => null };
    const wrapped = withShellBuiltinsSource(inner, () => null);
    expect(wrapped.resolve(makeRequest())).toBeNull();
  });

  it("awaits thenable inner results (worker runner shape) before falling back", async () => {
    const inner = {
      id: "fig",
      resolve: () => Promise.resolve(null),
    } as unknown as FigCompletionSource;
    const wrapped = withShellBuiltinsSource(inner, () => "cmd");
    const outcome = wrapped.resolve(makeRequest({ line: "task" }));
    expect(outcome).not.toBeNull();
    const response = await outcome;
    expect(response?.items.map((item) => item.label)).toEqual(["taskkill", "tasklist"]);
  });

  it("survives an inner throw and still offers builtins", () => {
    const inner: FigCompletionSource = {
      id: "fig",
      resolve: () => {
        throw new Error("boom");
      },
    };
    const wrapped = withShellBuiltinsSource(inner, () => "cmd");
    expect(wrapped.resolve(makeRequest({ line: "net" }))?.items[0]?.label).toBe("net");
  });
});
