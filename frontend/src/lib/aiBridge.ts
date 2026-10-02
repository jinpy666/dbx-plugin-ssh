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

// —— 直连文本生成（宿主 t8y2/dbx#10629，桌面 Tauri 运行时独有）：web 面板
// capabilities.aiCompletion 缺省，消费方回退面板会话路径。凭据全程宿主管理，
// 每次发送宿主原生确认（插件名 + 模型）。

/** 直连生成能力位（host.ai.listModels/generateText 可调）。 */
export function aiCompletionAvailable(api: DbxPluginApiLike | undefined | null): boolean {
  return api?.capabilities?.aiCompletion === true;
}

/** 推荐位能力位（host.ai.setRecommendations/clearRecommendations 可调）。 */
export function aiRecommendationsAvailable(api: DbxPluginApiLike | undefined | null): boolean {
  return api?.capabilities?.aiRecommendations === true;
}

export interface AiModelRow {
  configId: string;
  name: string;
  model: string;
  isDefault: boolean;
}

/** 已配置的 API 模型列表：宿主桥已白名单过滤，这里再投影一次（纵深防御，
 *  防适配器泄漏 config 对象的 endpoint/headers 等字段）。 */
export async function listAiModels(api: DbxPluginApiLike): Promise<AiModelRow[]> {
  const rows = await api.request<unknown>("host.ai.listModels");
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .filter((row) => typeof row.configId === "string" && typeof row.model === "string")
    .map((row) => ({ configId: row.configId as string, name: typeof row.name === "string" ? row.name : "", model: row.model as string, isDefault: row.isDefault === true }));
}

/** 挑默认模型：isDefault 优先，否则首个；空表 null（调用方回退面板）。 */
export function pickDefaultAiModel(models: readonly AiModelRow[]): AiModelRow | null {
  return models.find((row) => row.isDefault) ?? models[0] ?? null;
}

/** 直连文本生成：prompt ≤100k、返回纯文本 ≤16k（宿主裁剪）。异常原样上抛。 */
export async function generateAiText(api: DbxPluginApiLike, input: { configId: string; model: string; prompt: string }): Promise<string> {
  return api.request<string>("host.ai.generateText", input);
}

/** 推送 AI 面板推荐卡（≤5 张，随工作台存续不持久化）。best-effort 由调用方容错。 */
export async function setAiRecommendations(api: DbxPluginApiLike, update: { context: Record<string, unknown>; items: Array<{ id: string; label: string; prompt: string; order?: number }> }): Promise<void> {
  await api.request("host.ai.setRecommendations", update);
}

/** 清空本工作台的插件推荐卡。 */
export async function clearAiRecommendations(api: DbxPluginApiLike): Promise<void> {
  await api.request("host.ai.clearRecommendations");
}
