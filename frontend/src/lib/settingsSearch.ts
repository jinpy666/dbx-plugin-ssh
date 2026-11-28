// 设置分类检索（纯函数）：13 个分类逐个点进去找某项设置太慢，导航顶部给一个
// 搜索框。匹配面 = 本地化分类名 + 分类 id（用户可能记得英文 id 或中文名），
// 空白分词 AND；命中分类保持原有导航顺序（分类是有心智顺序的，不按分数重排）。

export interface SettingsCategoryEntry {
  id: string;
  labelKey: string;
}

/** 查询分词：小写、按空白切分、丢弃空段。 */
export function settingsQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** 单分类匹配：每个 token 都需命中本地化名或 id 的子串。 */
export function matchesSettingsCategory(
  category: SettingsCategoryEntry,
  label: string,
  query: string,
): boolean {
  const tokens = settingsQueryTokens(query);
  if (!tokens.length) return true;
  const haystacks = [label.toLowerCase(), category.id.toLowerCase(), category.labelKey.toLowerCase()];
  return tokens.every((token) => haystacks.some((entry) => entry.includes(token)));
}

/** 过滤分类（保持原序；空查询返回副本）。 */
export function filterSettingsCategories(
  categories: readonly SettingsCategoryEntry[],
  labelOf: (category: SettingsCategoryEntry) => string,
  query: string,
): SettingsCategoryEntry[] {
  if (!settingsQueryTokens(query).length) return [...categories];
  return categories.filter((category) => matchesSettingsCategory(category, labelOf(category), query));
}
