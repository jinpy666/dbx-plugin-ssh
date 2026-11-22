// @vitest-environment happy-dom
// issue #304：「希望能快速创建几个分屏子窗口」——addPanes(count) 一次动作
// 并行开多个副屏窗格（与用户快速连点 addPane 走完全相同的会话管线，只是
// 并行触发），并把上限/失败语义钉进回归锚点。
import { describe, expect, it, vi } from "vitest";
import { SPLIT_PANE_MAX, useSplitPanes, type UseSplitPanesDeps } from "./useSplitPanes";

type InvokeMock = ReturnType<typeof vi.fn>;

function makeDeps(overrides?: { invoke?: InvokeMock; notify?: InvokeMock }) {
  const invoke = vi.fn(async () => ({}));
  const notify = vi.fn();
  const deps = {
    t: (key: string, values?: Record<string, string | number>) => (values ? `${key}:${JSON.stringify(values)}` : key),
    notify,
    showError: vi.fn(),
    connectionId: () => "conn-1",
    workbenchId: () => "wb-1",
    mainSessionId: () => "main-session",
    connected: () => true,
    isSshMode: () => true,
    createPaneTerminal: () => {
      throw new Error("xterm 挂载不在本单测范围（mountPane 由组件触发）");
    },
    spawnDimensions: () => ({ cols: 80, rows: 24 }),
    enqueueInput: vi.fn(),
    invoke,
    noWrapPrefs: () => ({ enabled: false, columns: 0 }),
    ...overrides,
  } as UseSplitPanesDeps;
  return {
    deps,
    invoke: (overrides?.invoke ?? invoke) as InvokeMock,
    notify: (overrides?.notify ?? notify) as InvokeMock,
  };
}

describe("useSplitPanes.addPanes (#304 quick multi-pane)", () => {
  it("一次动作开出请求数量的窗格", async () => {
    const { deps, invoke } = makeDeps();
    const pane = useSplitPanes(deps);
    await pane.addPanes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(pane.panes.value.length).toBe(2);
    expect(pane.splitOpen.value).toBe(true);
    for (const call of invoke.mock.calls) {
      expect(call[0]).toBe("ssh/session/open");
    }
  });

  it("并行触发全部会话打开（不等前一个完成才开下一个）", async () => {
    const gates: Array<(value: unknown) => void> = [];
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          gates.push(resolve);
        }),
    );
    const { deps } = makeDeps({ invoke });
    const pane = useSplitPanes(deps);
    const done = pane.addPanes(3);
    // 同一轮微任务前 invoke 必须已被调用 3 次（串行 await 会在这里只看到 1 次）。
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(pane.panes.value.length).toBe(3);
    for (const resolve of gates) resolve({});
    await done;
    expect(pane.panes.value.every((entry) => entry.state === "connected")).toBe(true);
  });

  it("请求数超过上限时截断到 SPLIT_PANE_MAX 且标题唯一", async () => {
    const { deps, invoke } = makeDeps();
    const pane = useSplitPanes(deps);
    await pane.addPanes(10);
    expect(invoke).toHaveBeenCalledTimes(SPLIT_PANE_MAX);
    expect(pane.panes.value.length).toBe(SPLIT_PANE_MAX);
    const titles = new Set(pane.panes.value.map((entry) => entry.title));
    expect(titles.size).toBe(SPLIT_PANE_MAX);
  });

  it("已达上限时只提示不再开新会话", async () => {
    const { deps, invoke, notify } = makeDeps();
    const pane = useSplitPanes(deps);
    await pane.addPanes(SPLIT_PANE_MAX);
    invoke.mockClear();
    notify.mockClear();
    await pane.addPanes(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(pane.panes.value.length).toBe(SPLIT_PANE_MAX);
  });

  it("单个会话打开失败不影响其余窗格（失败窗格落断开态）", async () => {
    const invoke = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("channel open failed");
      })
      .mockImplementation(async () => ({}));
    const { deps } = makeDeps({ invoke });
    const pane = useSplitPanes(deps);
    await pane.addPanes(3);
    expect(pane.panes.value.length).toBe(3);
    const closed = pane.panes.value.filter((entry) => entry.state === "closed");
    const connected = pane.panes.value.filter((entry) => entry.state === "connected");
    expect(closed.length).toBe(1);
    expect(connected.length).toBe(2);
    expect(closed[0].error).toContain("channel open failed");
  });
});
