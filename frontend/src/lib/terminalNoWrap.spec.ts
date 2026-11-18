import { describe, expect, it } from "vitest";
import { applyNoWrapWidth, isAltScreenSwitch, registerAltScreenWatch, resolveNoWrapTargetCols, type NoWrapTerminalLike } from "./terminalNoWrap";

function fakeTerm(cols: number, rows = 30, bufferType = "normal") {
  const resizeCalls: Array<[number, number]> = [];
  const term: NoWrapTerminalLike = {
    cols,
    rows,
    resize: (c, r) => {
      resizeCalls.push([c, r]);
      term.cols = c;
    },
    buffer: { active: { type: bufferType } },
  };
  return { term, resizeCalls };
}

describe("resolveNoWrapTargetCols (#306)", () => {
  it("关闭时保持可视列数", () => {
    expect(resolveNoWrapTargetCols({ enabled: false, configuredCols: 1000, viewportCols: 120, alternate: false })).toBe(120);
  });

  it("开启且普通缓冲区时取 max(可视, 配置列数)", () => {
    expect(resolveNoWrapTargetCols({ enabled: true, configuredCols: 1000, viewportCols: 120, alternate: false })).toBe(1000);
    expect(resolveNoWrapTargetCols({ enabled: true, configuredCols: 100, viewportCols: 120, alternate: false })).toBe(120);
  });

  it("备用屏（vim/htop）自动回退可视列数", () => {
    expect(resolveNoWrapTargetCols({ enabled: true, configuredCols: 1000, viewportCols: 120, alternate: true })).toBe(120);
  });
});

describe("applyNoWrapWidth (#306)", () => {
  it("目标列数不同时 resize 并返回 true", () => {
    const { term, resizeCalls } = fakeTerm(120);
    expect(applyNoWrapWidth(term, { enabled: true, configuredCols: 1000, viewportCols: 120 })).toBe(true);
    expect(resizeCalls).toEqual([[1000, 30]]);
  });

  it("目标列数相同时不动并返回 false", () => {
    const { term, resizeCalls } = fakeTerm(1000);
    expect(applyNoWrapWidth(term, { enabled: true, configuredCols: 1000, viewportCols: 120 })).toBe(false);
    expect(resizeCalls).toEqual([]);
  });

  it("备用屏时回退到可视列数", () => {
    const { term, resizeCalls } = fakeTerm(1000, 30, "alternate");
    expect(applyNoWrapWidth(term, { enabled: true, configuredCols: 1000, viewportCols: 120 })).toBe(true);
    expect(resizeCalls).toEqual([[120, 30]]);
  });

  it("缺省 viewportCols 时用当前列数判断", () => {
    const { term, resizeCalls } = fakeTerm(120);
    expect(applyNoWrapWidth(term, { enabled: false, configuredCols: 1000 })).toBe(false);
    expect(resizeCalls).toEqual([]);
  });
});

describe("isAltScreenSwitch (#306)", () => {
  it("识别 DECSET/DECRST 1049/47/1047", () => {
    expect(isAltScreenSwitch([1049])).toBe(true);
    expect(isAltScreenSwitch([[1049]])).toBe(true);
    expect(isAltScreenSwitch([47])).toBe(true);
    expect(isAltScreenSwitch([1047])).toBe(true);
    expect(isAltScreenSwitch([25])).toBe(false);
    // 括号粘贴模式 2004 不得误判
    expect(isAltScreenSwitch([2004])).toBe(false);
  });
});

describe("registerAltScreenWatch (#306)", () => {
  it("DECSET/DECRST 命中备用屏模式时回调，其余放行", () => {
    const handlers: Array<{ matcher: { final: string }; cb: (params: ReadonlyArray<number | number[]>) => boolean | void }> = [];
    const term = { parser: { registerCsiHandler: (matcher: { final: string }, cb: (params: ReadonlyArray<number | number[]>) => boolean | void) => { handlers.push({ matcher, cb }); return { dispose() {} }; } } };
    let switches = 0;
    registerAltScreenWatch(term, () => { switches += 1; });
    expect(handlers).toHaveLength(2);
    expect(handlers.every((h) => h.matcher.final === "h" || h.matcher.final === "l")).toBe(true);
    // 进入备用屏
    expect(handlers[0]!.cb([1049])).toBe(false);
    expect(switches).toBe(1);
    // 退出备用屏
    expect(handlers[1]!.cb([[1049]])).toBe(false);
    expect(switches).toBe(2);
    // 无关模式不回调
    expect(handlers[0]!.cb([2004])).toBe(false);
    expect(handlers[1]!.cb([25])).toBe(false);
    expect(switches).toBe(2);
  });
});
