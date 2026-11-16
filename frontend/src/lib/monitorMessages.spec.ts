// 监控面板文案（计划 §4-B6）：七 locale 的 monitor 命名空间键集/占位符/非空
// 校验。键集全等由 workbench.spec 的全表对比兜底，这里聚焦 monitor.* 子集的
// 语义契约：en 为基准的 29 键在其余六语逐一在场、无空串、无占位符漂移，
// 并抽查关键徽标键在各语都不是键名本身（防漏译渲染成原始键）。
import { describe, expect, it } from "vitest";
import { workbenchMessage, workbenchMessageTable, type WorkbenchLocale } from "./i18n";

const LOCALES: WorkbenchLocale[] = ["en", "es", "it", "ja", "pt-BR", "zh-CN", "zh-TW"];

/** en 基准键清单（计划 §4-B6 明细）：新增/删除键必须同步此处与其余六语。 */
const MONITOR_KEYS = [
  "monitor.title",
  "monitor.privacy",
  "monitor.privacyHint",
  "monitor.refresh",
  "monitor.filterAll",
  "monitor.filterLive",
  "monitor.filterIssues",
  "monitor.badgeConnecting",
  "monitor.badgeLive",
  "monitor.badgeFailed",
  "monitor.badgeUnsupported",
  "monitor.badgeStopped",
  "monitor.addWatch",
  "monitor.removeWatch",
  "monitor.openTerminal",
  "monitor.retry",
  "monitor.details",
  "monitor.detailsLoad",
  "monitor.detailsUptime",
  "monitor.detailsDisks",
  "monitor.detailsUsers",
  "monitor.sessionClosed",
  "monitor.pollStopped",
  "monitor.emptyGroup",
  "monitor.noServers",
  "monitor.groupAll",
  "monitor.groupColor",
  "monitor.groupDelete",
  "monitor.groupManage",
  "monitor.groupName",
  "monitor.groupNew",
  "monitor.taskLimit",
  "monitor.cpu",
  "monitor.memory",
  "monitor.network",
] as const;

describe("monitor panel messages", () => {
  it("declares every monitor key in all seven locales", () => {
    for (const locale of LOCALES) {
      const table = workbenchMessageTable(locale);
      const monitorKeys = Object.keys(table).filter((key) => key.startsWith("monitor."));
      expect(monitorKeys.sort(), `${locale} monitor key set`).toEqual([...MONITOR_KEYS].sort());
    }
  });

  it("keeps monitor copy non-empty and placeholder-aligned with en", () => {
    const enTable = workbenchMessageTable("en");
    for (const locale of LOCALES.filter((candidate) => candidate !== "en")) {
      const table = workbenchMessageTable(locale);
      for (const key of MONITOR_KEYS) {
        expect(table[key].length, `${locale}.${key} is empty`).toBeGreaterThan(0);
        const expected = [...enTable[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        const actual = [...table[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(actual, `${locale}.${key} placeholders drift from en`).toEqual(expected);
      }
    }
  });

  it("resolves badges and labels to real copy in every locale", () => {
    for (const locale of LOCALES) {
      for (const key of ["monitor.badgeLive", "monitor.badgeFailed", "monitor.addWatch", "monitor.title"]) {
        expect(workbenchMessage(locale, key), `${locale}.${key}`).not.toBe(key);
      }
    }
  });
});
