// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { applyAppearanceColorVars, subscribeHostEnvironment } from "../../../shared/frontend/hostThemeRuntime";

// shared/frontend/hostThemeRuntime 薄 spec（X-P2/P3/P4 收敛）：证明本插件工具
// 链下 import 解析、行为成立——env locale/theme 分发、context 旧桥回退、
// appearance/themeChannel 互斥、聚合退订、颜色变量令牌探测/回退。
describe("shared hostThemeRuntime", () => {
  it("dispatches env locale/theme via onEvent and ignores backend events", () => {
    const seen: { locale?: string; theme?: unknown } = {};
    let envCount = 0;
    let listener: ((event: unknown) => void) | undefined;
    const unsub = subscribeHostEnvironment<{ appearance: "dark" }, { appearance: "dark" }>(
      {
        onEvent: (l) => {
          listener = l as (event: unknown) => void;
          return () => {
            listener = undefined;
          };
        },
      },
      {
        onEnv: () => {
          envCount += 1;
        },
        onLocale: (locale) => (seen.locale = locale),
        onTheme: (theme) => (seen.theme = theme),
      },
    );
    listener?.({ type: "event", method: "ssh/session/state", params: {} });
    listener?.({ type: "env", locale: "ja" });
    listener?.({ type: "env", theme: { appearance: "dark" } });
    expect(seen).toEqual({ locale: "ja", theme: { appearance: "dark" } });
    // onEnv 每条 env 事件都触发（含不携带 locale/theme 的），后端事件不触发。
    expect(envCount).toBe(2);
    unsub();
    expect(listener).toBeUndefined();
  });

  it("prefers onContext and falls back to legacy onContextChange", () => {
    const hits: string[] = [];
    const ctx = { connectionId: "c1" };
    const viaOnContext = subscribeHostEnvironment(
      {
        onContext: (l) => {
          l(ctx);
          return () => hits.push("onContext-unsub");
        },
        onContextChange: () => {
          hits.push("legacy-should-not-subscribe");
          return () => undefined;
        },
      },
      { onContext: (c) => hits.push(`onContext:${String(c.connectionId)}`) },
    );
    expect(hits).toEqual(["onContext:c1"]);
    viaOnContext();

    hits.length = 0;
    const viaLegacy = subscribeHostEnvironment(
      {
        onContextChange: (l) => {
          l(ctx);
          return () => hits.push("legacy-unsub");
        },
      },
      { onContext: (c) => hits.push(`legacy:${String(c.connectionId)}`) },
    );
    expect(hits).toEqual(["legacy:c1"]);
    viaLegacy();
    expect(hits).toEqual(["legacy:c1", "legacy-unsub"]);
  });

  it("subscribes onAppearanceChange when present, else the theme channel (mutually exclusive)", () => {
    let appearanceListener: ((a: { colorScheme: "light" | "dark" }) => void) | undefined;
    let themeListener: ((t: { appearance: "light" | "dark" }) => void) | undefined;
    const appearances: Array<"light" | "dark"> = [];
    const themes: Array<"light" | "dark"> = [];

    const withAppearance = subscribeHostEnvironment<{ colorScheme: "light" | "dark" }, { appearance: "light" | "dark" }>(
      {
        onAppearanceChange: (l) => {
          appearanceListener = l;
          return () => {
            appearanceListener = undefined;
          };
        },
      },
      { onAppearance: (a) => appearances.push(a.colorScheme), onTheme: (t) => themes.push(t.appearance) },
      { themeChannel: (l) => { themeListener = l; return () => { themeListener = undefined; }; } },
    );
    appearanceListener?.({ colorScheme: "light" });
    expect(appearances).toEqual(["light"]);
    expect(themeListener).toBeUndefined();
    withAppearance();

    subscribeHostEnvironment<{ colorScheme: "light" | "dark" }, { appearance: "light" | "dark" }>(
      {},
      { onAppearance: (a) => appearances.push(a.colorScheme), onTheme: (t) => themes.push(t.appearance) },
      { themeChannel: (l) => { themeListener = l; return () => { themeListener = undefined; }; } },
    );
    themeListener?.({ appearance: "dark" });
    expect(themes).toEqual(["dark"]);
    expect(appearanceListener).toBeUndefined();
  });

  it("applyAppearanceColorVars writes the fallback palette when host tokens are missing", () => {
    const el = document.createElement("div");
    applyAppearanceColorVars(el, { background: "rgb(1 2 3)", mutedForeground: undefined });
    expect(el.style.getPropertyValue("--background")).toBe("rgb(1 2 3)");
    // 缺失颜色字段不写空串（避免无效内联）。
    expect(el.style.getPropertyValue("--muted-foreground")).toBe("");
  });

  it("applyAppearanceColorVars defers to the bridge only for host-written inline tokens", () => {
    const el = document.createElement("div");
    // 宿主 SDK 把令牌 inline 写在根节点：插件变量让位给 themeSync 桥。
    el.style.setProperty("--color-background", "oklch(0.2 0 0)");
    applyAppearanceColorVars(el, { background: "rgb(1 2 3)" });
    expect(el.style.getPropertyValue("--background")).toBe("");
    // 宿主令牌撤掉后（SDK 清空 inline），下一次 appearance 推送回写插件色板。
    el.style.removeProperty("--color-background");
    applyAppearanceColorVars(el, { background: "rgb(1 2 3)" });
    expect(el.style.getPropertyValue("--background")).toBe("rgb(1 2 3)");
  });

  it("applyAppearanceColorVars survives the boot→replay double application (theme cycle regression)", () => {
    // 回归：boot 首次应用写入 inline 色板后，紧随的 appearance 重放（mock 的
    // onAppearanceChange 立即回调）曾据 computed 值误判「宿主接管」而
    // removeProperty，复活 --background ↔ --color-background 循环、整站失色。
    // 判定只看 inline 令牌：自身色板不是宿主接管信号，重放必须保持幂等。
    const el = document.createElement("div");
    const colors = { background: "rgb(19 20 22)", foreground: "rgb(215 215 219)" };
    applyAppearanceColorVars(el, colors);
    applyAppearanceColorVars(el, colors);
    applyAppearanceColorVars(el, colors);
    expect(el.style.getPropertyValue("--background")).toBe("rgb(19 20 22)");
    expect(el.style.getPropertyValue("--foreground")).toBe("rgb(215 215 219)");
  });
});
