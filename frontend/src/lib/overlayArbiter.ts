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

/**
 * 仲裁的键维度。Enter/Tab/→ 拆成三个维度不是过度设计——三者的让位规则不同：
 * ghost 对 completion 不让「→」（菜单只占用 ↑↓/Tab/Esc）却让 Tab
 * （「Tab 接受建议」开关在菜单开着时不接受）；补全的 Enter 恒透传 shell。
 * 修饰键组合（Ctrl+F/Ctrl+E/Ctrl+→）的物理键匹配留在 handleTerminalKey
 * ——那是「哪个物理键映射到哪个维度」，不是「这个维度归谁」。
 */
export type ClaimKey =
  | "arrowUp"
  | "arrowDown"
  | "enter"
  | "tab"
  | "accept"
  | "escape"
  | "anchor";

export interface ArbiterClaim {
  overlay: OverlayId;
  key: ClaimKey;
  /** 数值越大优先级越高；同键维度取最大者获胜。 */
  priority: number;
  /** 沿用各浮层既有判定（can* / gate / open 布尔）——判定不迁移。 */
  visible: boolean;
}

export type KeyOwners = Record<ClaimKey, OverlayId | null>;

const CLAIM_KEYS: readonly ClaimKey[] = [
  "arrowUp",
  "arrowDown",
  "enter",
  "tab",
  "accept",
  "escape",
  "anchor",
];

/**
 * 优先级表（数值即 §1.2 拍板对象）。推导规则：
 * - 同维度数值 = 2026-10 顺序链中的守卫先后（先判者大）。链序：ghost 词块
 *   接受 → ghost 整段接受 → completion → suggestion → 历史面板 → 裸 ↑ 唤起 →
 *   搜索 Esc → ghost 键位胶囊 Esc → quick-select；
 * - ghost 的 Tab 接受对 completion 让位（编码在 claim 可见性：菜单开着时
 *   「Tab 接受建议」不生效），对 → 不让（维度拆分的原因，见 ClaimKey 注）。
 *   ghost 的词块/整段接受分支本体不查表——其组合键条件即让位编码的另一半
 *   （Ctrl+F/Ctrl+E 无维度），查表只覆盖可枚举维度；
 * - 面板分支在链上位于补全/建议之后、搜索/胶囊菜单之前——面板对 Esc/导航
 *   让位补全/建议、压过搜索与胶囊菜单（多数组合因互斥门不会同场，但异常态
 *   也必须逐字复刻）。
 */
export const ARBITER_PRIORITIES: Readonly<Record<ClaimKey, Partial<Record<OverlayId, number>>>> = {
  arrowUp: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
  arrowDown: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
  enter: { completion: 400, suggestion: 300, historyPanel: 200, quickSelect: 100 },
  tab: { ghost: 500, completion: 400, suggestion: 300, historyPanel: 200 },
  accept: { ghost: 500 },
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
