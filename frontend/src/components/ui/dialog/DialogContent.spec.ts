import { describe, expect, it } from "vitest";

// DialogContent 定位器结构防线(issue #153):定位器是 grid 但未定义轨道时,
// 弹窗 `width: min(680px, 100%)` 的百分比在 auto 轨道上按内容尺寸解析,
// 窄视口下弹窗不收缩、右侧溢出屏幕(审计日志是最宽的 680px 弹窗,最先暴露;
// 其他弹窗在更窄窗口同样会犯)。定位器必须用 minmax(0,1fr) 显式约束列/行,
// 让百分比宽度解析到真实可用空间。
import dialogContentSource from "./DialogContent.vue?raw";

describe("DialogContent positioner grid track guard", () => {
  it("constrains the grid track (minmax(0,1fr)) so narrow-viewport dialogs clamp instead of overflowing", () => {
    expect(dialogContentSource).toContain("grid-cols-[minmax(0,1fr)]");
    expect(dialogContentSource).toContain("grid-rows-[minmax(0,1fr)]");
    // place-items-center 依赖轨道存在才能居中:两个守卫一起断言,防止只删不换。
    expect(dialogContentSource).toContain("place-items-center");
  });
});
