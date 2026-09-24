// i18n 完整性守卫：七语 localTerminal 段的 key 集合必须完全一致。此前漏译
// 靠 review 肉眼（typecheck 不报），新增键时用它兜底。
import { describe, expect, it } from "vitest";
import { messages } from "../lib/i18n";

const LOCALES = ["en", "es", "it", "ja", "pt-BR", "zh-CN", "zh-TW"] as const;

function keySet(block: unknown, prefix = ""): string[] {
  if (typeof block !== "object" || block === null) return [prefix];
  return Object.entries(block as Record<string, unknown>).flatMap(([key, value]) =>
    keySet(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n localTerminal section", () => {
  it("has identical key sets across all seven locales", () => {
    const reference = keySet((messages as unknown as Record<string, Record<string, unknown>>)["en"].localTerminal).sort();
    expect(reference.length).toBeGreaterThan(0);
    for (const locale of LOCALES.slice(1)) {
      const keys = keySet((messages as unknown as Record<string, Record<string, unknown>>)[locale].localTerminal).sort();
      expect(keys, `${locale} diverges`).toEqual(reference);
    }
  });

  it("covers the sessionStatus.local pill in every locale", () => {
    for (const locale of LOCALES) {
      const block = (messages as unknown as Record<string, Record<string, Record<string, unknown>>>)[locale].sessionStatus;
      expect(typeof block.local).toBe("string");
    }
  });
});
