import { describe, expect, it } from "vitest";
import { ARBITER_PRIORITIES, resolveKeyOwners, type ArbiterClaim, type ClaimKey, type OverlayId } from "./overlayArbiter";

// 快照与场景守卫：优先级表是从 2026-10 `handleTerminalKey` 顺序链逐字推导的
// （docs/IMPL_PLAN_OVERLAY_KEY_ARBITER.zh-CN.md §1.2）。改表必须同步本 spec——
// #150/#152 的全部历史回归场景在此钉死键权归属。

function claim(overlay: OverlayId, key: ClaimKey, visible = true): ArbiterClaim {
  return { overlay, key, priority: ARBITER_PRIORITIES[key][overlay] ?? 0, visible };
}

/** 各浮层按各自「可见/开门」判定产出 claims 的镜像辅助（S3 接线后由
 *  App.vue hub 提供；此处按场景手工展开）。 */
function owners(claims: ArbiterClaim[]) {
  return resolveKeyOwners(claims);
}

describe("overlayArbiter priority table snapshot", () => {
  it("pins the table derived from the 2026-10 key routing chain", () => {
    expect(ARBITER_PRIORITIES).toEqual({
      arrowUp: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
      arrowDown: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
      enter: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
      tab: { ghost: 500, completion: 400, suggestion: 300, historyPanel: 200 },
      accept: { ghost: 500 },
      escape: { completion: 400, suggestion: 300, historyPanel: 200, search: 150, ghost: 140, quickSelect: 100 },
      anchor: { promptHints: 100 },
    });
  });
});

describe("resolveKeyOwners scenarios (issue #150/#152 regression set)", () => {
  it("#150 MFA prompt pending: ↑ belongs to nobody (remote readline owns it)", () => {
    // 交互提示待答：historyPanel 唤起门（canOpenHistoryPanel）判 false，
    // 其 arrowUp 唤起 claim 不可见，且无其他浮层在场。
    const result = owners([claim("historyPanel", "arrowUp", false)]);
    expect(result.arrowUp).toBeNull();
    expect(result.arrowDown).toBeNull();
  });

  it("#150 control: at a normal prompt the bare ↑ raise-claim wins", () => {
    const result = owners([claim("historyPanel", "arrowUp", true)]);
    expect(result.arrowUp).toBe("historyPanel");
  });

  it("#150 typing while pending: suggestion claims nothing on behalf of the panel", () => {
    // 待答态下建议浮层同样不弹（suggestionGuard 门），无 claim 即无持有者。
    const result = owners([
      claim("historyPanel", "arrowUp", false),
      claim("suggestion", "enter", false),
    ]);
    expect(result.enter).toBeNull();
    expect(result.arrowUp).toBeNull();
  });

  it("#152 panel open: ↑↓/Enter/Tab/Esc all belong to the history panel", () => {
    const result = owners([
      claim("historyPanel", "arrowUp"),
      claim("historyPanel", "arrowDown"),
      claim("historyPanel", "enter"),
      claim("historyPanel", "tab"),
      claim("historyPanel", "escape"),
    ]);
    expect(result.arrowUp).toBe("historyPanel");
    expect(result.arrowDown).toBe("historyPanel");
    expect(result.enter).toBe("historyPanel");
    expect(result.tab).toBe("historyPanel");
    expect(result.escape).toBe("historyPanel");
  });

  it("suggestion overlay open: it owns the nav/enter/tab keys and ghost yields by visibility", () => {
    // ghost 的 tab 优先级（500）高于 suggestion（300），但让位编码在可见性
    // （历史建议浮层开着时无 ghost）——可见性优先于优先级。
    const result = owners([
      claim("ghost", "tab", false),
      claim("suggestion", "arrowUp"),
      claim("suggestion", "arrowDown"),
      claim("suggestion", "enter"),
      claim("suggestion", "tab"),
      claim("suggestion", "escape"),
    ]);
    expect(result.arrowUp).toBe("suggestion");
    expect(result.arrowDown).toBe("suggestion");
    expect(result.enter).toBe("suggestion");
    expect(result.tab).toBe("suggestion");
    expect(result.escape).toBe("suggestion");
  });

  it("completion menu open: owns ↑↓/Enter/Tab/Esc; ghost Tab-accept yields via visibility; → stays ghost", () => {
    // 菜单只占用 ↑↓/Tab/Esc；带修饰的 → 归 ghost（#138 批 2 起同屏共存）。
    // Tab 维度上 ghost 的 claim 因 !completionOpen 不可见（「Tab 接受建议」
    // 开关在菜单开着时不生效），accept 维度（→）不受影响。
    const result = owners([
      claim("ghost", "accept", true),
      claim("ghost", "tab", false),
      claim("completion", "arrowUp"),
      claim("completion", "arrowDown"),
      claim("completion", "enter"),
      claim("completion", "tab"),
      claim("completion", "escape"),
    ]);
    expect(result.arrowUp).toBe("completion");
    expect(result.arrowDown).toBe("completion");
    expect(result.enter).toBe("completion");
    expect(result.tab).toBe("completion");
    expect(result.accept).toBe("ghost");
    expect(result.escape).toBe("completion");
  });

  it("ghost Tab-accept owns the tab key only when the completion menu is closed", () => {
    expect(owners([claim("ghost", "tab", true)]).tab).toBe("ghost");
    expect(owners([claim("ghost", "tab", false)]).tab).toBeNull();
  });

  it("quick-select open: navigation/enter/escape belong to it when nothing above is open", () => {
    const result = owners([
      claim("quickSelect", "arrowUp"),
      claim("quickSelect", "arrowDown"),
      claim("quickSelect", "enter"),
      claim("quickSelect", "escape"),
    ]);
    expect(result.arrowUp).toBe("quickSelect");
    expect(result.arrowDown).toBe("quickSelect");
    expect(result.enter).toBe("quickSelect");
    expect(result.escape).toBe("quickSelect");
  });

  it("the open panel takes Esc ahead of search close and the ghost keycap menu (chain order)", () => {
    const result = owners([
      claim("historyPanel", "escape"),
      claim("search", "escape"),
      claim("ghost", "escape"),
    ]);
    expect(result.escape).toBe("historyPanel");
  });

  it("search close and the ghost keycap menu own Esc only when no panel is open", () => {
    expect(owners([claim("search", "escape")]).escape).toBe("search");
    expect(owners([claim("ghost", "escape")]).escape).toBe("ghost");
  });

  it("completion/suggestion outrank the open panel on shared keys (chain: they are judged first)", () => {
    const result = owners([
      claim("historyPanel", "arrowUp"),
      claim("historyPanel", "enter"),
      claim("completion", "arrowUp"),
      claim("completion", "enter"),
      claim("suggestion", "arrowUp"),
      claim("quickSelect", "arrowUp"),
    ]);
    expect(result.arrowUp).toBe("completion");
    expect(result.enter).toBe("completion");
  });

  it("the open panel beats quick-select on shared keys (chain order)", () => {
    const result = owners([
      claim("historyPanel", "arrowUp"),
      claim("historyPanel", "enter"),
      claim("historyPanel", "escape"),
      claim("quickSelect", "arrowUp"),
      claim("quickSelect", "enter"),
      claim("quickSelect", "escape"),
    ]);
    expect(result.arrowUp).toBe("historyPanel");
    expect(result.enter).toBe("historyPanel");
    expect(result.escape).toBe("historyPanel");
  });

  it("promptHints anchor: owned only while no other overlay is open", () => {
    const quiet = owners([claim("promptHints", "anchor", true)]);
    expect(quiet.anchor).toBe("promptHints");
    // 引导条自身的 overlayOpen 门把 claim 置不可见；仲裁器兜底不双持。
    const busy = owners([
      claim("promptHints", "anchor", false),
      claim("suggestion", "enter"),
    ]);
    expect(busy.anchor).toBeNull();
  });

  it("everything closed: every key belongs to the remote shell", () => {
    expect(owners([])).toEqual({
      arrowUp: null,
      arrowDown: null,
      enter: null,
      tab: null,
      accept: null,
      escape: null,
      anchor: null,
    });
  });

  it("ties resolve to the first declared claim (tie is a table smell, kept deterministic)", () => {
    const tied: ArbiterClaim[] = [
      { overlay: "suggestion", key: "enter", priority: 400, visible: true },
      { overlay: "completion", key: "enter", priority: 400, visible: true },
    ];
    expect(resolveKeyOwners(tied).enter).toBe("suggestion");
  });
});
