/**
 * 终端浮层键权仲裁器（架构评审最高优先还债项，见
 * docs/IMPL_PLAN_OVERLAY_KEY_ARBITER.zh-CN.md）。
 *
 * 把 `handleTerminalKey` 里手工维护的浮层互斥顺序链显式化为一张优先级表：
 * 每个浮层对每个键维度做一次 claim（可见性沿用各浮层既有判定模块的输出，
 * 判定逻辑零迁移），`resolveKeyOwners` 对每个键维度选出唯一持有者。第 N 个
 * 浮层的集成成本从「改 N 处门」降为「加一行 claim」；on-call 查「为什么 ↑
 * 不进历史面板」只需看一张表。
 *
 * 优先级数字从 2026-10 的 `handleTerminalKey` 顺序链逐字推导（快照 spec
 * 钉死 #150/#152 全部历史场景）：改表先改 spec——表是数据不是逻辑。
 */

export type OverlayId =
  | "historyPanel"
  | "promptHints"
  | "ghost"
  | "suggestion"
  | "completion"
  | "quickSelect"
  | "search";

/** 仲裁的键维度。组合键过滤（裸键/修饰键/IME）留在 handleTerminalKey——
 *  那是「哪个物理键映射到哪个维度」，不是「这个维度归谁」。 */
export type ClaimKey = "arrowUp" | "arrowDown" | "accept" | "escape" | "anchor";

export interface ArbiterClaim {
  overlay: OverlayId;
  key: ClaimKey;
  /** 数值越大优先级越高；同键维度取最大者获胜。 */
  priority: number;
  /** 沿用各浮层既有判定（can* / gate / open 布尔）——判定不迁移。 */
  visible: boolean;
}

export type KeyOwners = Record<ClaimKey, OverlayId | null>;

const CLAIM_KEYS: readonly ClaimKey[] = ["arrowUp", "arrowDown", "accept", "escape", "anchor"];

/**
 * 优先级表（数值即 §1.2 拍板对象）。推导规则：
 * - 同维度数值 = 2026-10 顺序链中的守卫先后（先判者大）。链序：ghost 词块
 *   接受 → ghost 整段接受 → completion → suggestion → 历史面板 → 裸 ↑ 唤起 →
 *   搜索 Esc → ghost 键位胶囊 Esc → quick-select；
 * - ghost 的 accept（词块/整段接受）带 !suggestionOpen 让位（历史建议浮层
 *   开着时无 ghost，数据分工），让位编码在 claim 可见性里而非优先级里——
 *   completion 开着时 ghost 的 Ctrl+→ 仍可用（菜单只占用 ↑↓/Tab/Esc）；
 * - 面板分支在链上位于补全/建议之后、搜索/胶囊菜单之前——面板对 Esc 让位
 *   补全/建议、压过搜索与胶囊菜单（多数组合因互斥门不会同场，但异常态也
 *   必须逐字复刻）。
 */
export const ARBITER_PRIORITIES: Readonly<Record<ClaimKey, Partial<Record<OverlayId, number>>>> = {
  // ↑↓：补全/建议/面板(开)/quick-select 依链序；面板关闭时的裸 ↑ 唤起是
  // 同 overlay 的另一条 claim（可见性 = 唤起门，#150 待答态判 false 即
  // 无人持有，↑ 归远端 readline/菜单）。
  arrowUp: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
  arrowDown: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
  // 接受（Enter/Tab/→ 词块/整段）：ghost 两条接受分支在链最前（但让位建议
  // 浮层），其后依链序补全 > 建议 > 面板回填 > quick-select。
  accept: { ghost: 500, completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
  // Esc：补全/建议/面板先于搜索与胶囊菜单（链序），quick-select 收尾。
  escape: { completion: 400, suggestion: 300, historyPanel: 200, search: 150, ghost: 140, quickSelect: 100 },
  // 屏幕锚点（引导条放置位）：引导条独占；其他浮层在场时其可见性门
  // （overlayOpen）已把 claim 置不可见，仲裁器兜底不双持。
  anchor: { promptHints: 100 },
};

/** 对每个键维度选出可见 claim 中优先级最高者；同分取先声明者（同分是表
 *  配置错误的味道，spec 有快照守着）。全不可见 = 无人持有（null），按键
 *  归远端 shell。 */
export function resolveKeyOwners(claims: readonly ArbiterClaim[]): KeyOwners {
  const owners = {} as KeyOwners;
  for (const key of CLAIM_KEYS) {
    let best: ArbiterClaim | undefined;
    for (const claim of claims) {
      if (claim.key !== key || !claim.visible) continue;
      if (!best || claim.priority > best.priority) best = claim;
    }
    owners[key] = best?.overlay ?? null;
  }
  return owners;
}
