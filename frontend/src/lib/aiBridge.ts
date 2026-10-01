// 宿主 AI 通道薄封装（Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL §2）：
// 能力探测（桥 capabilities.ai，旧宿主缺省 = 不支持）+ host.ai.openConversation
// 调用。插件不持有任何 AI 配置——provider/密钥/模型全在宿主 Settings → AI；
// 调用失败按结构化错误上抛，由调用方降级为可见提示（不静默吞）。

export interface DbxPluginApiLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  readonly capabilities?: { ai?: boolean } & Record<string, unknown>;
}

/** 宿主 AI 面板可用：capabilities.ai 为 true（桥广播位 = openAiConversation 在位）。 */
export function aiBridgeAvailable(api: DbxPluginApiLike | undefined | null): boolean {
  return api?.capabilities?.ai === true;
}

/** 发起宿主 AI 会话。返回 true = 宿主已接收（面板打开）；false/异常由调用方处理。 */
export async function openAiConversation(api: DbxPluginApiLike | undefined | null, request: unknown): Promise<boolean> {
  if (!api || !aiBridgeAvailable(api)) return false;
  await api.request("host.ai.openConversation", request);
  return true;
}
