// AI 助手设置（Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL §5.3）：三个功能
// 开关 + AI 修复的「不再询问」授权位，单键 JSON 存 pluginStore。
// 默认口径（隐私优先，见方案 §4.3）：
// - search（`#` AI 命令搜索）默认开——只发送用户敲的自然语言与 cwd 等元数据；
// - fix（失败命令 AI 修复）默认关——开启即授权插件在命令失败时**采集终端输出**，
//   发送前还有一次快照预览确认（首次）；
// - assist（热键唤起 AI 助手）默认开——只发送显式选中的文本/当前屏快照；
// - fixConsent：「不再询问」记忆位，设置页可清空重置。
// 能力缺失（旧宿主 capabilities.ai 缺省）时开关保语义、入口降级，见 aiBridge。

import { pluginStore } from "./pluginStore";

export const AI_SETTINGS_STORE_KEY = "ssh-ai-assist";

export interface AiSettings {
  /** `#` AI 命令搜索（Warp AI Command Search 同位）：**默认关（2026-10-02
   *  决策暂缓）**——空行 # 被本地截留仍是行为变化；直连 v2（生成即回填，
   *  Warp 同款默认插入）已实现，开启即得。 */
  search: boolean;
  /** 失败命令 AI 修复：**默认开（2026-10-02 体验反馈，对齐 Warp 自动出现）**
   *  ——修复条仅本地展示，发送仍过首次快照预览确认（记「不再询问」）+ 宿主
   *  逐次授权。 */
  fix: boolean;
  assist: boolean;
  /** 面板会话 Agent 档 opt-in（openConversation mode:"agent"）：执行面为既有
   *  MCP 工具 + 插件审批门，默认 ask。 */
  agentMode: boolean;
  fixConsent: boolean;
}

export const AI_SETTINGS_DEFAULTS: AiSettings = { search: false, fix: true, assist: true, agentMode: false, fixConsent: false };

/** 解析持久化值：逐字段回退默认（旧版本/损坏值不整包失效）。 */
export function sanitizeAiSettings(raw: unknown): AiSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    search: typeof source.search === "boolean" ? source.search : AI_SETTINGS_DEFAULTS.search,
    fix: typeof source.fix === "boolean" ? source.fix : AI_SETTINGS_DEFAULTS.fix,
    assist: typeof source.assist === "boolean" ? source.assist : AI_SETTINGS_DEFAULTS.assist,
    agentMode: typeof source.agentMode === "boolean" ? source.agentMode : AI_SETTINGS_DEFAULTS.agentMode,
    fixConsent: source.fixConsent === true,
  };
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = pluginStore.getItem(AI_SETTINGS_STORE_KEY);
    return sanitizeAiSettings(raw == null || raw === "" ? undefined : JSON.parse(raw));
  } catch {
    return { ...AI_SETTINGS_DEFAULTS };
  }
}

export function saveAiSettings(settings: AiSettings) {
  try {
    pluginStore.setItem(AI_SETTINGS_STORE_KEY, JSON.stringify(settings));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
}
