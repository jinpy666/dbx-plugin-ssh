import { describe, expect, it } from "vitest";
import { ARBITER_PRIORITIES, resolveKeyOwners, type ArbiterClaim, type ClaimKey, type OverlayId } from "./overlayArbiter";

// 快照与场景守卫：优先级表是从 2026-10 `handleTerminalKey` 顺序链逐字推导的
// （docs/IMPL_PLAN_OVERLAY_KEY_ARBITER.zh-CN.md §1.2）。改表必须同步本 spec——
// #150/#152 的全部历史回归场景在此钉死键权归属。

function claim(overlay: OverlayId, key: ClaimKey, visible = true): ArbiterClaim {
  return { overlay, key, priority: ARBITER_PRIORITIES[key][overlay] ?? 0, visible };
}

/** 各浮层按各自「可见/开门」判定产出 claims 的镜像辅助（S2/S3 接线后由
 *  App.vue hub 提供；此处按场景手工展开）。 */
function owners(claims: ArbiterClaim[]) {
  return resolveKeyOwners(claims);
}

describe("overlayArbiter priority table snapshot", () => {
  it("pins the table derived from the 2026-10 key routing chain", () => {
    expect(ARBITER_PRIORITIES).toEqual({
      arrowUp: { historyPanel: 400, completion: 300, suggestion: 250, quickSelect: 200 },
      arrowDown: { historyPanel: 400, completion: 300, suggestion: 250, quickSelect: 200 },
      accept: { ghost: 500, historyPanel: 400, completion: 300, suggestion: 250, quickSelect: 200 },
      escape: { search: 500, ghost: 490, historyPanel: 400, completion: 300, suggestion: 250, quickSelect: 200 },
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
      claim("suggestion", "accept", false),
    ]);
    expect(result.accept).toBeNull();
    expect(result.arrowUp).toBeNull();
  });

  it("#152 panel open: ↑↓/accept/escape all belong to the history panel", () => {
    const result = owners([
      claim("historyPanel", "arrowUp"),
      claim("historyPanel", "arrowDown"),
      claim("historyPanel", "accept"),
      claim("historyPanel", "escape"),
    ]);
    expect(result.arrowUp).toBe("historyPanel");
    expect(result.arrowDown).toBe("historyPanel");
    expect(result.accept).toBe("historyPanel");
    expect(result.escape).toBe("historyPanel");
  });

  it("suggestion overlay open: it owns ↑/accept/escape and ghost yields by visibility", () => {
    // ghost 的 accept 优先级（500）高于 suggestion（250），但让位编码在
    // 可见性（历史建议浮层开着时无 ghost）——可见性优先于优先级。
    const result = owners([
      claim("ghost", "accept", false),
      claim("suggestion", "arrowUp"),
      claim("suggestion", "arrowDown"),
      claim("suggestion", "accept"),
      claim("suggestion", "escape"),
    ]);
    expect(result.arrowUp).toBe("suggestion");
    expect(result.arrowDown).toBe("suggestion");
    expect(result.accept).toBe("suggestion");
    expect(result.escape).toBe("suggestion");
  });

  it("completion menu open with ghost match: ↑↓ owned by completion, Ctrl+→ still ghost", () => {
    // 菜单只占用 ↑↓/Tab/Esc；带修饰的 → 归 ghost（#138 批 2 起同屏共存），
    // ghost 的 accept 让位只对 suggestion——对 completion 不让。
    const result = owners([
      claim("ghost", "accept", true),
      claim("completion", "arrowUp"),
      claim("completion", "arrowDown"),
      claim("completion", "accept"),
      claim("completion", "escape"),
    ]);
    expect(result.arrowUp).toBe("completion");
    expect(result.arrowDown).toBe("completion");
    expect(result.accept).toBe("ghost");
    expect(result.escape).toBe("completion");
  });

  it("quick-select open: navigation and escape belong to it when nothing above is open", () => {
    const result = owners([
      claim("quickSelect", "arrowUp"),
      claim("quickSelect", "arrowDown"),
      claim("quickSelect", "accept"),
      claim("quickSelect", "escape"),
    ]);
    expect(result.arrowUp).toBe("quickSelect");
    expect(result.arrowDown).toBe("quickSelect");
    expect(result.accept).toBe("quickSelect");
    expect(result.escape).toBe("quickSelect");
  });

  it("terminal search open: Esc closes search ahead of an open history panel", () => {
    const result = owners([claim("search", "escape"), claim("historyPanel", "escape")]);
    expect(result.escape).toBe("search");
  });

  it("ghost keycap menu: Esc collapses the menu ahead of the history panel", () => {
    const result = owners([claim("ghost", "escape"), claim("historyPanel", "escape")]);
    expect(result.escape).toBe("ghost");
  });

  it("panel open beats completion/suggestion/quick-select on shared keys (chain order)", () => {
    const result = owners([
      claim("historyPanel", "accept"),
      claim("completion", "accept"),
      claim("suggestion", "accept"),
      claim("quickSelect", "accept"),
      claim("historyPanel", "arrowUp"),
      claim("completion", "arrowUp"),
      claim("suggestion", "arrowUp"),
      claim("quickSelect", "arrowUp"),
    ]);
    expect(result.accept).toBe("historyPanel");
    expect(result.arrowUp).toBe("historyPanel");
  });

  it("promptHints anchor: owned only while no other overlay is open", () => {
    const quiet = owners([claim("promptHints", "anchor", true)]);
    expect(quiet.anchor).toBe("promptHints");
    // 引导条自身的 overlayOpen 门把 claim 置不可见；仲裁器兜底不双持。
    const busy = owners([
      claim("promptHints", "anchor", false),
      claim("suggestion", "accept"),
    ]);
    expect(busy.anchor).toBeNull();
  });

  it("everything closed: every key belongs to the remote shell", () => {
    expect(owners([])).toEqual({
      arrowUp: null,
      arrowDown: null,
      accept: null,
      escape: null,
      anchor: null,
    });
  });

  it("ties resolve to the first declared claim (tie is a table smell, kept deterministic)", () => {
    const tied: ArbiterClaim[] = [
      { overlay: "suggestion", key: "accept", priority: 300, visible: true },
      { overlay: "completion", key: "accept", priority: 300, visible: true },
    ];
    expect(resolveKeyOwners(tied).accept).toBe("suggestion");
  });
});
