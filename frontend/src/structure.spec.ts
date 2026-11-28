// 结构守卫：文件体积预算 + 层方向。
//
// 为什么需要：前端已经出现 App.vue 1.2 万行、lib/i18n.ts 1 万行这类单体。
// 单文件继续膨胀会让 review、并行修改与测试定位都失控，而且这类退化在 PR 里
// 只能靠肉眼拦。本 spec 扫描真实源码，把「生产源码 ≤ 600 行、spec/测试 ≤ 1200
// 行」和「lib/ 不得反向依赖 components/ 或 App.vue」变成可执行的检查。
//
// 存量债务用冻结白名单过渡：条目值 = 当前行数，只允许收缩——文件缩到预算内
// 或被删除后，条目必须删除，否则测试失败。
//
// 白名单从真实文件树生成（失败信息里给出 `路径: 行数`），不要手写行数。
import { describe, expect, it } from "vitest";

// Vite 的 `?raw` 把源码内联进测试模块，无需 fs；键相对本 spec 所在目录
// （src/），如 "./App.vue"、"./lib/i18n.ts"。
const SOURCES = import.meta.glob("./**/*.{ts,vue}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

const MAX_SOURCE_LINES = 600;
const MAX_SPEC_LINES = 1_200;

/** 迁移期白名单：路径 → 当前允许的行数。 */
const LINE_ALLOWLIST: Record<string, number> = {
  "./App.vue": 12658,
  "./lib/i18n.ts": 10984,
  "./mockDbxHost.ts": 2335,
  "./components/SettingsDialog.vue": 1894,
  "./components/OtpPanel.vue": 822,
  "./components/MonitorPanel.vue": 792,
  "./composables/useCommandSuggestions.ts": 663,
};

/**
 * 方向白名单：lib/ 里今天仍引用 components/ 的文件。
 * 只允许收缩：条目必须仍然违规，否则失败。
 */
const DIRECTION_ALLOWLIST: string[] = ["./lib/fileIcons.ts"];

function countLines(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

function isSpec(key: string): boolean {
  return (
    key.endsWith(".spec.ts") ||
    key.endsWith(".test.ts") ||
    key.includes("/testing/")
  );
}

function budgetFor(key: string): number {
  return isSpec(key) ? MAX_SPEC_LINES : MAX_SOURCE_LINES;
}

/** 超预算文件 + 陈旧白名单条目。空输入必须返回空结果。 */
function lineViolations(
  sources: Record<string, string>,
  allow: Record<string, number>,
): string[] {
  const out: string[] = [];
  for (const [key, text] of Object.entries(sources)) {
    const lines = countLines(text);
    const limit = allow[key] ?? budgetFor(key);
    if (lines > limit) out.push(`${key}: ${lines} > ${limit}`);
  }
  for (const [key, allowed] of Object.entries(allow)) {
    const budget = budgetFor(key);
    if (allowed <= budget) {
      out.push(`${key}: 白名单值 ${allowed} 必须大于预算 ${budget}（冻结的是超标行数）`);
      continue;
    }
    const text = sources[key];
    if (text === undefined) continue; // 失效条目由 deadLineEntries 负责
    const lines = countLines(text);
    if (lines <= budget) {
      out.push(`${key}: 白名单条目已陈旧（${lines} <= 预算 ${budget}，允许 ${allowed}）`);
    }
  }
  return out;
}

/** 白名单条目对应的文件已被移动/删除。 */
function deadLineEntries(
  sources: Record<string, string>,
  allow: Record<string, number>,
): string[] {
  return Object.keys(allow).filter((key) => sources[key] === undefined);
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)["'`]([^"'`]+)["'`]/gm;

/** 把 import 说明符解析成本 spec 视角的键（"./lib/x"）；裸模块返回 null。 */
function resolveKey(from: string, spec: string): string | null {
  const clean = spec.split("?")[0].split("#")[0];
  const aliased = clean.startsWith("@/");
  if (!aliased && !clean.startsWith(".")) return null;
  const parts = aliased ? [] : from.split("/").slice(0, -1).filter((p) => p !== "" && p !== ".");
  const segments = aliased ? clean.slice(2).split("/") : clean.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return "./" + parts.join("/");
}

/** `lib/` 是被单测直接覆盖的纯逻辑层；spec 文件可在测试里挂组件，不受此限。 */
function upwardImports(key: string, text: string): string[] {
  if (!key.startsWith("./lib/") || isSpec(key)) return [];
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const target = resolveKey(key, match[1]);
    if (target === "./App.vue" || target?.startsWith("./components/")) {
      out.push(`${key} -> ${match[1]}`);
    }
  }
  return out;
}

function directionViolations(
  sources: Record<string, string>,
  allow: string[],
): string[] {
  const out: string[] = [];
  for (const [key, text] of Object.entries(sources)) {
    if (allow.includes(key)) continue;
    out.push(...upwardImports(key, text));
  }
  return out;
}

/** 方向白名单里已经不再违规（或文件已删）的条目。 */
function deadDirectionEntries(
  sources: Record<string, string>,
  allow: string[],
): string[] {
  return allow.filter((key) => {
    const text = sources[key];
    return text === undefined || upwardImports(key, text).length === 0;
  });
}

describe("structure guards", () => {
  describe("file budgets", () => {
    it("accepts empty input", () => {
      expect(lineViolations({}, {})).toEqual([]);
      expect(deadLineEntries({}, {})).toEqual([]);
    });

    it("detects an over-budget source file", () => {
      expect(lineViolations({ "./big.ts": "x\n".repeat(601) }, {})).toEqual([
        "./big.ts: 601 > 600",
      ]);
      expect(lineViolations({ "./ok.ts": "x\n".repeat(600) }, {})).toEqual([]);
    });

    it("applies the larger spec budget to spec and testing files", () => {
      expect(lineViolations({ "./a.spec.ts": "x\n".repeat(1200) }, {})).toEqual([]);
      expect(lineViolations({ "./a.spec.ts": "x\n".repeat(1201) }, {})).toEqual([
        "./a.spec.ts: 1201 > 1200",
      ]);
      expect(lineViolations({ "./a.test.ts": "x\n".repeat(1200) }, {})).toEqual([]);
      expect(
        lineViolations({ "./lib/testing/helper.ts": "x\n".repeat(1200) }, {}),
      ).toEqual([]);
    });

    it("keeps an allowlist entry that still covers the file quiet", () => {
      expect(lineViolations({ "./big.ts": "x\n".repeat(700) }, { "./big.ts": 700 })).toEqual([]);
    });

    it("detects a stale allowlist entry (file shrank into budget)", () => {
      const out = lineViolations(
        { "./was-big.ts": "x\n".repeat(600) },
        { "./was-big.ts": 800 },
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("陈旧");
    });

    it("detects a dead allowlist entry (file deleted)", () => {
      expect(deadLineEntries({ "./other.ts": "x\n" }, { "./gone.ts": 900 })).toEqual([
        "./gone.ts",
      ]);
    });
  });

  describe("layer direction", () => {
    it("accepts empty input", () => {
      expect(directionViolations({}, [])).toEqual([]);
      expect(deadDirectionEntries({}, [])).toEqual([]);
    });

    it("detects lib importing components", () => {
      const sources = { "./lib/a.ts": 'import X from "../components/X.vue";\n' };
      expect(directionViolations(sources, [])).toEqual([
        "./lib/a.ts -> ../components/X.vue",
      ]);
      expect(directionViolations(sources, ["./lib/a.ts"])).toEqual([]);
    });

    it("resolves the @/ alias too", () => {
      const sources = { "./lib/a.ts": 'import X from "@/components/X.vue";\n' };
      expect(directionViolations(sources, [])).toEqual([
        "./lib/a.ts -> @/components/X.vue",
      ]);
    });

    it("ignores non-lib layers and specs", () => {
      const text = 'import X from "../components/X.vue";\n';
      const sources = { "./composables/a.ts": text, "./lib/a.spec.ts": text };
      expect(directionViolations(sources, [])).toEqual([]);
    });

    it("detects a dead direction entry", () => {
      const sources = { "./lib/a.ts": 'import { x } from "./x";\n' };
      expect(deadDirectionEntries(sources, ["./lib/a.ts"])).toEqual(["./lib/a.ts"]);
    });
  });

  describe("real tree", () => {
    it("scans the whole tree (guard is not vacuous)", () => {
      expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
      expect(SOURCES["./App.vue"]).toBeTypeOf("string");
      expect(SOURCES["./lib/i18n.ts"]).toBeTypeOf("string");
    });

    it("keeps every file within budget", () => {
      expect(lineViolations(SOURCES, LINE_ALLOWLIST)).toEqual([]);
    });

    it("keeps the allowlist alive (only allowed to shrink)", () => {
      expect(deadLineEntries(SOURCES, LINE_ALLOWLIST)).toEqual([]);
    });

    it("keeps lib free of component imports", () => {
      expect(directionViolations(SOURCES, DIRECTION_ALLOWLIST)).toEqual([]);
      expect(deadDirectionEntries(SOURCES, DIRECTION_ALLOWLIST)).toEqual([]);
    });
  });
});
