// issue #77 回归守卫：非安全上下文（局域网 HTTP / Docker 部署）里
// `crypto.randomUUID` 是 undefined，直接调用会让插件视图一启动就抛
// `TypeError: crypto.randomUUID is not a function`。
//
// 这个修复**已经回归过一次**——issue #77 的正文明确指出 0.7.0 发布分支在合并主
// 分支时把带保护的调用覆盖回了原始写法，`6c96c1fe` 才把 fallbackWorkbenchId 重
// 新接回 shim（同族 #104）。两次都靠人眼在 review 里发现，没有任何自动检查兜住。
//
// 本 spec 补上那道检查：扫描真实发布的源码，任何绕过 lib/uuid 的裸
// `crypto.randomUUID()` / `globalThis.crypto.randomUUID()` 调用都判失败。唯一
// 合法调用点是 shim 自身（lib/uuid.ts 内的特性检测透传）。
//
// 源码经 Vite 的 `?raw` 内联，测试无需文件系统访问，跑在默认 node 环境
// （与 i18nKeyReferences.spec.ts 同一手法）。
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../**/*.{vue,ts}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** shim 自身：这里正是"原生 API 可用时透传"的实现，裸调用合法。 */
const SHIM_SUFFIX = "/uuid.ts";

/** glob 的键是相对本 spec 所在目录（src/lib）的路径，如 "./uuid.ts"、"../App.vue"。 */
function shimSource(): string {
  const key = Object.keys(SOURCES).find((path) => path.endsWith(SHIM_SUFFIX));
  return key ? SOURCES[key] : "";
}

/**
 * 裸 randomUUID 调用：`crypto.randomUUID(...)` 或 `globalThis.crypto.randomUUID(...)`。
 *
 * 只匹配"调用"而非提及——注释、`typeof crypto.randomUUID === "function"` 这类
 * 特性检测（后面不是左括号）都不算违规，shim 自己的检测写法因此天然通过。
 */
const BARE_CALL = /(?:\bglobalThis\s*\.\s*)?\bcrypto\s*\.\s*randomUUID\s*\(/g;

interface BareCall {
  file: string;
  line: number;
  text: string;
}

function collectBareCalls(): BareCall[] {
  const calls: BareCall[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path.endsWith(SHIM_SUFFIX)) continue;
    for (const match of source.matchAll(BARE_CALL)) {
      const index = match.index ?? 0;
      calls.push({
        file: path,
        line: source.slice(0, index).split("\n").length,
        text: match[0],
      });
    }
  }
  return calls;
}

const CALLS = collectBareCalls();

describe("crypto.randomUUID stays behind the lib/uuid shim (issue #77)", () => {
  it("scans the shipped sources rather than an empty set", () => {
    // 防 glob 写坏后整个检查变成"永远通过"。
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((path) => path.endsWith("App.vue"))).toBe(true);
    expect(files.some((path) => path.endsWith(SHIM_SUFFIX))).toBe(true);
  });

  it("never calls crypto.randomUUID directly outside the shim", () => {
    const report = CALLS.map((call) => `${call.file}:${call.line} -> ${call.text}()`);
    expect(
      report,
      `bare crypto.randomUUID calls break the plugin on plain HTTP (issue #77); route them through lib/uuid:\n${report.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the shim's own feature detection intact", () => {
    // 守卫的有效性依赖 shim 里存在特性检测；若 shim 被改成裸调用，上面的白名单
    // 就会变成漏网通道，这里把该前提钉住。
    const shim = shimSource();
    expect(shim).toContain("randomUUID");
    expect(shim).toContain("typeof");
    expect(shim).toContain("getRandomValues");
  });

  it("keeps App.vue importing the shim rather than the global", () => {
    // App.vue 是 issue #77 实际爆掉的入口（fallbackWorkbenchId 在启动期求值）。
    const app = Object.keys(SOURCES)
      .filter((path) => path.endsWith("App.vue"))
      .map((path) => SOURCES[path])
      .join("\n");
    expect(app).toMatch(/import\s*{[^}]*\brandomUUID\b[^}]*}\s*from\s*"\.\/lib\/uuid"/);
  });
});
