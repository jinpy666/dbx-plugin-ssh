// legacySpecAdapter golden parity（FIG wave-1 Lane A 零回归的根）：
// 对现有 spec.spec.ts 语料 + specs/index 全量 spec 生成语料，断言
// legacyResolve（引擎 resolver）输出与 matchSpecLine 直查在
// label/kind/顺序/描述/score/edit 边界/context 上逐一相等；层级角标
// （deriveLegacyLevel）与动态目标（legacyDynamicTarget）同场固化。
import { describe, expect, it } from "vitest";
import { matchSpecLine, type CompletionRow } from "../../completions/spec";
import { COMPLETION_SPECS } from "../../completions/specs";
import {
  completionRowFromItem,
  deriveLegacyLevel,
  legacyDynamicTarget,
  legacyResolve,
} from "./legacySpecAdapter";
import type { CompletionItem } from "../core/types";

// ---------------------------------------------------------------------------
// 语料：spec.spec.ts 手写场景 + 遍历全量 spec 生成的层级/前缀/引号/终结符行。
// ---------------------------------------------------------------------------

/** spec.spec.ts 的手写语料（真实 specs + 合成 spec 的代表行）。 */
const HANDWRITTEN = [
  "",
  " ",
  "g",
  "gi",
  "git",
  "git ch",
  "git checkout ",
  "git checkout -",
  "git checkout --",
  "git checkout -- ",
  "git checkout -- -f",
  "git checkout -b ",
  "git commit ",
  'git commit -m "hello world',
  "git status --short ",
  "kubectl get -o ",
  "kubectl get --output=j",
  "docker container ",
  "htop --tree",
  "unknown-tool sub",
  "-v git",
  // 合成 spec（spec.spec.ts SYNTHETIC）的行对真实 specs 均为未知根 → pass-through。
  "sy",
  "syn a",
  "syn alpha ",
  "syn alpha --fo",
  "syn alpha -f",
  "syn alpha --format ",
  "syn alpha --format=y",
  "syn alpha --format json ",
  "syn alpha -- -f",
];

/** 遍历 specs/index 全量 spec：根前缀 / 子命令两层层级 / flag / 值 / 短名。 */
function generatedCorpus(): string[] {
  const lines = new Set<string>();
  for (const root of COMPLETION_SPECS) {
    for (let take = 1; take <= root.name.length; take += 1) lines.add(root.name.slice(0, take));
    lines.add(`${root.name} `);
    lines.add(`${root.name} -`);
    lines.add(`${root.name} --`);
    for (const flag of root.flags ?? []) {
      lines.add(`${root.name} --${flag.name.slice(0, Math.max(1, flag.name.length - 1))}`);
      if (flag.arg !== undefined) {
        lines.add(`${root.name} --${flag.name} `);
        if (flag.values?.length) lines.add(`${root.name} --${flag.name}=${flag.values[0].slice(0, 1)}`);
      }
    }
    for (const sub of root.subcommands ?? []) {
      lines.add(`${root.name} ${sub.name}`);
      lines.add(`${root.name} ${sub.name.slice(0, Math.max(1, sub.name.length - 1))}`);
      lines.add(`${root.name} ${sub.name} `);
      lines.add(`${root.name} ${sub.name} -`);
      lines.add(`${root.name} ${sub.name} --`);
      lines.add(`${root.name} ${sub.name} -- `);
      for (const flag of sub.flags ?? []) {
        if (flag.short !== undefined) {
          lines.add(`${root.name} ${sub.name} -${flag.short}`);
          lines.add(`${root.name} ${sub.name} -${flag.short} `);
        }
        lines.add(`${root.name} ${sub.name} --${flag.name}`);
        if (flag.arg !== undefined) {
          lines.add(`${root.name} ${sub.name} --${flag.name} `);
          if (flag.values?.length) {
            lines.add(`${root.name} ${sub.name} --${flag.name}=${flag.values[0]}`);
            lines.add(`${root.name} ${sub.name} --${flag.name}=${flag.values[0].slice(0, 1)}`);
          }
        }
      }
      for (const nested of sub.subcommands ?? []) {
        lines.add(`${root.name} ${sub.name} ${nested.name} `);
      }
      if (sub.positional?.values?.length) {
        lines.add(`${root.name} ${sub.name} ${sub.positional.values[0].slice(0, 2)}`);
        lines.add(`${root.name} ${sub.name} ${sub.positional.values[0]}`);
      }
    }
  }
  return [...lines];
}

const CORPUS = [...new Set([...HANDWRITTEN, ...generatedCorpus()])];

function resolveFor(line: string): ReturnType<typeof legacyResolve> {
  return legacyResolve({ line, requestId: 7, revision: 3, sessionId: "session-a" });
}

// ---------------------------------------------------------------------------
// golden parity：resolver 输出 vs matchSpecLine 直查，逐字段相等。
// ---------------------------------------------------------------------------

describe("legacyResolve · golden parity vs matchSpecLine", () => {
  it("corpus covers the bundled specs and the handwritten scenarios", () => {
    expect(CORPUS.length).toBeGreaterThan(300);
    expect(CORPUS).toContain("git ch");
    expect(CORPUS).toContain("git checkout -b ");
    expect(CORPUS).toContain("kubectl get -o ");
    expect(CORPUS).toContain("");
  });

  it("maps every corpus line field-by-field (state/label/kind/顺序/描述/score/edit/context)", () => {
    const mismatches: string[] = [];
    for (const line of CORPUS) {
      const match = matchSpecLine(line, COMPLETION_SPECS);
      const response = resolveFor(line);
      const expectPassThrough = !match || !match.rows.length;
      if (expectPassThrough) {
        if (response.state !== "pass-through" || response.items.length !== 0) {
          mismatches.push(`${JSON.stringify(line)}: expected pass-through, got ${response.state}/${response.items.length}`);
        }
        continue;
      }
      const rows = match.rows;
      if (response.state !== "ready" || response.items.length !== rows.length) {
        mismatches.push(`${JSON.stringify(line)}: expected ready/${rows.length}, got ${response.state}/${response.items.length}`);
        continue;
      }
      response.items.forEach((item, index) => {
        const row = rows[index];
        if (item.label !== row.label) mismatches.push(`${JSON.stringify(line)}[${index}]: label ${item.label} != ${row.label}`);
        if (item.description !== row.description) mismatches.push(`${JSON.stringify(line)}[${index}]: description mismatch`);
        if (item.score !== row.score) mismatches.push(`${JSON.stringify(line)}[${index}]: score ${item.score} != ${row.score}`);
        const expectedKind = row.kind === "sub" ? "subcommand" : row.kind === "flag" ? "option" : row.kind === "value" ? "argument" : "hint";
        if (item.kind !== expectedKind) mismatches.push(`${JSON.stringify(line)}[${index}]: kind ${item.kind} != ${expectedKind}`);
        const expectedEdit = {
          text: row.token + (row.space ? " " : ""),
          replaceStart: match.replaceStart,
          replaceEnd: match.replaceEnd,
        };
        if (JSON.stringify(item.edit) !== JSON.stringify(expectedEdit)) {
          mismatches.push(`${JSON.stringify(line)}[${index}]: edit ${JSON.stringify(item.edit)} != ${JSON.stringify(expectedEdit)}`);
        }
        if (item.source !== "legacy-spec") mismatches.push(`${JSON.stringify(line)}[${index}]: source ${item.source}`);
      });
      const context = response.context;
      if (!context
        || context.commandPath.join(" ") !== match.commandPath.join(" ")
        || context.command !== (match.commandPath[0] ?? null)
        || context.tokenStart !== match.replaceStart
        || context.tokenEnd !== match.replaceEnd) {
        mismatches.push(`${JSON.stringify(line)}: context mismatch`);
      }
    }
    expect(mismatches, mismatches.slice(0, 20).join("\n")).toEqual([]);
  });

  it("keeps the row ORDER identical (rankItems is a no-op on already-ranked rows)", () => {
    for (const line of CORPUS) {
      const match = matchSpecLine(line, COMPLETION_SPECS);
      const response = resolveFor(line);
      if (!match || !match.rows.length) continue;
      expect(response.items.map((item) => item.label)).toEqual(match.rows.map((row) => row.label));
    }
  });

  it("truncates at 20 exactly like the legacy parser (rankRows)", () => {
    // kubectl 的资源枚举超过 20 条：两侧行数与顺序必须同时截到前 20。
    const line = "kubectl get ";
    const match = matchSpecLine(line, COMPLETION_SPECS);
    const response = resolveFor(line);
    expect(match?.rows.length).toBeGreaterThan(0);
    expect(response.items.length).toEqual(match?.rows.length);
    expect(response.items.length).toBeLessThanOrEqual(20);
  });

  it("produces stable ids across calls and unique ids within a response", () => {
    const line = "git checkout -";
    const first = resolveFor(line);
    const second = resolveFor(line);
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(new Set(first.items.map((item) => item.id)).size).toBe(first.items.length);
    for (const item of first.items) expect(item.id.startsWith("legacy:")).toBe(true);
  });

  it("echoes requestId/revision from the caller envelope", () => {
    const response = legacyResolve({ line: "git ch", requestId: 42, revision: 9, sessionId: "s" });
    expect(response.requestId).toBe(42);
    expect(response.revision).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 展示映射：item → CompletionMenu 行（token/space 从 edit 反推，round-trip）。
// ---------------------------------------------------------------------------

describe("completionRowFromItem · round-trip", () => {
  it("reconstructs the legacy row from the adapter item for every corpus line", () => {
    const mismatches: string[] = [];
    for (const line of CORPUS) {
      const match = matchSpecLine(line, COMPLETION_SPECS);
      if (!match || !match.rows.length) continue;
      const rows = resolveFor(line).items.map((item) => completionRowFromItem(item));
      rows.forEach((row, index) => {
        const expected: CompletionRow = match.rows[index];
        const same = row.kind === expected.kind
          && row.token === expected.token
          && row.space === expected.space
          && row.label === expected.label
          && row.description === expected.description
          && row.score === expected.score;
        if (!same) mismatches.push(`${JSON.stringify(line)}[${index}]: ${JSON.stringify(row)} != ${JSON.stringify(expected)}`);
      });
    }
    expect(mismatches, mismatches.slice(0, 20).join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 层级角标与动态目标：与 HEAD 的 match.level / match.dynamic 逐一相等。
// ---------------------------------------------------------------------------

describe("deriveLegacyLevel · parity with matchSpecLine level", () => {
  it("derives the exact HEAD level for every corpus line", () => {
    const mismatches: string[] = [];
    for (const line of CORPUS) {
      const match = matchSpecLine(line, COMPLETION_SPECS);
      const response = resolveFor(line);
      if (!match || !match.rows.length) continue;
      const level = deriveLegacyLevel(response, line);
      if (level !== match.level) mismatches.push(`${JSON.stringify(line)}: ${level} != ${match.level}`);
    }
    expect(mismatches, mismatches.slice(0, 20).join("\n")).toEqual([]);
  });

  it("covers the three presentation levels explicitly", () => {
    expect(deriveLegacyLevel(resolveFor("git ch"), "git ch")).toBe("sub");
    expect(deriveLegacyLevel(resolveFor("git checkout -"), "git checkout -")).toBe("flag");
    expect(deriveLegacyLevel(resolveFor("kubectl get -o "), "kubectl get -o ")).toBe("value");
    // flag 兜底（git commit 无子命令/位置值时拿 flags 当候选）：层级仍是 sub。
    expect(deriveLegacyLevel(resolveFor("git commit "), "git commit ")).toBe("sub");
    // 纯 hint 层（动态位置参数）：HEAD 层级 sub；等待值的 flag：HEAD 层级 value。
    expect(deriveLegacyLevel(resolveFor("git checkout "), "git checkout ")).toBe("sub");
    expect(deriveLegacyLevel(resolveFor("git checkout -b "), "git checkout -b ")).toBe("value");
  });
});

describe("legacyDynamicTarget · parity with matchSpecLine dynamic", () => {
  it("returns the dynamic target only for all-hint layers, matching the parser", () => {
    const mismatches: string[] = [];
    for (const line of CORPUS) {
      const match = matchSpecLine(line, COMPLETION_SPECS);
      const allHints = Boolean(match?.rows.length) && Boolean(match?.rows.every((row) => row.kind === "hint"));
      const expected = allHints ? (match?.dynamic ?? null) : null;
      const actual = legacyDynamicTarget(line);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(`${JSON.stringify(line)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
    }
    expect(mismatches, mismatches.slice(0, 20).join("\n")).toEqual([]);
  });

  it("exposes positional and flag-value shapes", () => {
    expect(legacyDynamicTarget("git checkout ")).toEqual({ kind: "positional", name: "branch" });
    expect(legacyDynamicTarget("git checkout -b ")).toEqual({ kind: "flag-value", flag: "branch" });
    expect(legacyDynamicTarget("git checkout -")).toBeNull();
    expect(legacyDynamicTarget("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// item 形状快照（冻结类型的消费方式锁定）。
// ---------------------------------------------------------------------------

describe("legacyResolve · item shape", () => {
  it("emits CompletionItem with edit bounded by the parser range", () => {
    const response = resolveFor("git ch");
    const checkout = response.items.find((item) => item.label === "checkout");
    expect(checkout).toBeDefined();
    expect(checkout?.edit).toEqual({ text: "checkout ", replaceStart: 4, replaceEnd: 6 });
    expect(checkout?.kind).toBe("subcommand");
    expect(checkout?.description?.length ?? 0).toBeGreaterThan(0);
    const inline = resolveFor("kubectl get --output=j").items[0];
    expect(inline?.edit.text.startsWith("--output=")).toBe(true);
  });

  it("hint rows keep an empty edit text (Tab 透传的根)", () => {
    const response = resolveFor("git checkout ");
    expect(response.items).toHaveLength(1);
    expect(response.items[0].kind).toBe("hint");
    expect(response.items[0].edit.text).toBe("");
    expect(response.items[0].edit.replaceStart).toBe(13);
    expect(response.items[0].edit.replaceEnd).toBe(13);
  });
});
