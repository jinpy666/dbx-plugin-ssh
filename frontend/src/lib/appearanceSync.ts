// 跨表面终端外观同步（tab 工作台 ↔ dock 底部栏面板）：两个表面是各自独立的
// webview，外观键（配色方案/字体族/字号）经 pluginStore 写穿到宿主 storage
// 后对端没有任何通知通道（宿主桥无 storage 变更事件，opaque origin 下
// BroadcastChannel/localStorage 事件也不可用）——对端因此停在旧配色。
//
// 本模块收口同步的纯逻辑与通道探测：
// - `createAppearanceSyncModel`：防自写回落的状态机。轮询直读桥上的三键，
//   与「已确认」规范值比较；本端刚写入但桥未落地期间不采纳远端旧值（否则
//   tab 改主题时 dock 会先回落旧色一拍再弹回）。规范值经 sanitize 后按稳定
//   键序序列化，键序漂移/越界值不产生假差异。
// - `createCrossSurfaceStorageReader` / `subscribeStorageEvents`：优先宿主桥
//   storage.get（host/web 宿主一致），降级 guarded localStorage（浏览器直连，
//   顶层文档跨 iframe 共享且原生 storage 事件可用）；内存通道返回 null，
//   调用方整体禁用同步。纯逻辑零 Vue 依赖，组合式在 composables 里。
//
// 范围只覆盖终端外观三键（ssh-terminal-appearance / -font-family / -font-size）：
// 它们是「改一处、处处该变」的全局观感；会话态偏好（SFTP 布局等）本就按
// 工作台各自持有，不参与。

import {
  sanitizeTerminalAppearanceState,
  TERMINAL_APPEARANCE_KEY,
  type TerminalAppearanceState,
} from "./terminalAppearance";
import {
  parsePersistedTerminalFontFamily,
  parsePersistedTerminalFontSize,
  TERMINAL_FONT_FAMILY_KEY,
  TERMINAL_FONT_SIZE_KEY,
  type TerminalFontOverride,
} from "./terminalFont";

/** 跨表面同步的三个存储键（与 pluginStore 声明一致，单点便于对账）。 */
export const APPEARANCE_SYNC_KEYS = {
  appearance: TERMINAL_APPEARANCE_KEY,
  fontFamily: TERMINAL_FONT_FAMILY_KEY,
  fontSize: TERMINAL_FONT_SIZE_KEY,
} as const;

/** 桥直读的一次快照（三键原始串；键缺失为 null）。 */
export interface AppearanceSyncSnapshot {
  appearance: string | null;
  fontFamily: string | null;
  fontSize: string | null;
}

/** 一次 tick 的采纳决定：null 字段 = 该部分与当前一致、无需落地。 */
export interface AppearanceSyncDecision {
  appearance: TerminalAppearanceState | null;
  font: TerminalFontOverride | null;
}

/** 外观原始串 → 规范化 JSON（sanitize 固定键序）；缺失/损坏返回 null。 */
export function canonicalAppearanceRaw(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  try {
    return JSON.stringify(sanitizeTerminalAppearanceState(JSON.parse(raw)));
  } catch {
    return null;
  }
}

/** 字体两键原始串 → 覆盖态（缺失/非法按「跟随宿主」null 归一）。 */
export function parseFontSync(familyRaw: string | null, sizeRaw: string | null): TerminalFontOverride {
  return {
    fontFamily: parsePersistedTerminalFontFamily(familyRaw),
    fontSize: parsePersistedTerminalFontSize(sizeRaw),
  };
}

function fontEquals(a: TerminalFontOverride, b: TerminalFontOverride): boolean {
  return a.fontFamily === b.fontFamily && a.fontSize === b.fontSize;
}

export function createAppearanceSyncModel(options: {
  /** 当前「持久化外观态」读取器（即写穿 ssh-terminal-appearance 的那个对象；
   * 不含 terminalFontOverride 合并——字体覆盖态走 currentFont 单独进指纹）。 */
  currentAppearance: () => TerminalAppearanceState;
  currentFont: () => TerminalFontOverride;
}) {
  let confirmedAppearance = canonicalAppearanceRaw(JSON.stringify(options.currentAppearance()));
  // 两条独立闸门：外观键与字体键的写穿各自落地确认（纯字号缩放只写字体键，
  // 外观键在桥上的内容不变——合成单一指纹会永不匹配、闸门卡死）。
  let pendingAppearance: string | null = null;
  let pendingFont: string | null = null;

  function fontFingerprint(font: TerminalFontOverride): string {
    return `${font.fontFamily ?? ""}#${font.fontSize ?? ""}`;
  }

  return {
    /** 本端外观写入（updateTerminalAppearance / 主题快照等）后调用。 */
    noteAppearanceWrite() {
      pendingAppearance = canonicalAppearanceRaw(JSON.stringify(options.currentAppearance()));
    },
    /** 本端字体写入（缩放 / 字体族设置 / 主题快照字体落地）后调用。 */
    noteFontWrite() {
      pendingFont = fontFingerprint(options.currentFont());
    },

    /** 消费一次桥直读快照，返回需要落地的部分（无变化/待确认返回全 null）。 */
    tick(snapshot: AppearanceSyncSnapshot): AppearanceSyncDecision {
      const appearanceCanonical = canonicalAppearanceRaw(snapshot.appearance);
      const font = parseFontSync(snapshot.fontFamily, snapshot.fontSize);
      const decision: AppearanceSyncDecision = { appearance: null, font: null };
      // 两键族各自独立判定：指纹一致 = 本端写入已在桥上落地，解除该条闸门
      // （解除当拍不采纳——落地值就是本端内存态）；未在途才评估远端变化。
      if (pendingAppearance != null) {
        if (appearanceCanonical === pendingAppearance) pendingAppearance = null;
      } else if (appearanceCanonical != null && appearanceCanonical !== confirmedAppearance) {
        try {
          decision.appearance = sanitizeTerminalAppearanceState(JSON.parse(snapshot.appearance!));
          confirmedAppearance = appearanceCanonical;
        } catch {
          // 损坏串不采纳也不推进确认值（下轮重试）。
        }
      }
      if (pendingFont != null) {
        if (fontFingerprint(font) === pendingFont) pendingFont = null;
      } else if (!fontEquals(font, options.currentFont())) {
        decision.font = font;
      }
      return decision;
    },
  };
}

/** 桥/localStorage 直读器：桥优先（与 pluginStore 通道一致），降级 guarded
 * localStorage；两者都不可用（内存通道/单测 node 环境）返回 null 禁用同步。 */
export function createCrossSurfaceStorageReader(): ((key: string) => Promise<string | null>) | null {
  try {
    const api = (window as unknown as {
      dbxPlugin?: { capabilities?: { storage?: boolean }; storage?: { get?(key: string): Promise<unknown> } };
    }).dbxPlugin;
    const storage = api?.capabilities?.storage ? api.storage : undefined;
    const get = storage?.get;
    if (typeof get === "function") {
      return async (key) => {
        const value = await get.call(storage, key);
        // 桥返回值与 pluginStore 水合同一归一语义：字符串原样、对象/数组
        // JSON.stringify（mock 与真实宿主都可能返回已解析对象）。
        if (typeof value === "string") return value;
        if (value == null) return null;
        return typeof value === "object" ? JSON.stringify(value) : String(value);
      };
    }
  } catch {
    // 无 window（单测 node 环境）：落到 localStorage 探测（同样抛错 → null）。
  }
  try {
    const ls = window.localStorage;
    ls.getItem("__dbx_appearance_sync_probe__");
    return async (key) => {
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}

/** localStorage 档的变更订阅（浏览器直连下顶层文档跨 iframe 共享，原生
 * storage 事件在其它文档触发）；桥档无事件通道，返回的退订恒为空操作。 */
export function subscribeStorageEvents(listener: () => void): () => void {
  try {
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  } catch {
    return () => {};
  }
}
