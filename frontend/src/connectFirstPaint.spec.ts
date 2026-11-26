// #326 回归锚点：预览链路（CodeMirror 语言包 + @file-viewer 的 PDF/Office/
// 表格/媒体 renderer，约 11.4MB 产物字节）不得再被 App.vue 静态 import。
//
// 宿主以 <iframe srcdoc> 单文件加载工作台（sandbox="allow-scripts"，见
// host/apps/desktop/src/components/plugins/PluginWorkbenchHost.vue 的 srcdoc
// 绑定），单文件 bundle 里的每个静态 import 都会在「点击连接 → 终端可用」
// 的首屏窗口被解析/求值。改成 defineAsyncComponent + import() 后模块体留在
// 惰性工厂里，首屏只付文本解析成本；本地 Chrome 交替 A/B 实测 UI 首屏
// domContentLoaded 中位 ~565ms → ~533ms、first-paint ~364ms → ~328ms
// （同一 25.1MB 产物，5 对全部变快）。
// 这里直接读 App.vue 锁住形态：谁把它改回静态 import，单测先红。
// @ts-expect-error — Node built-in types are not included in the frontend tsconfig.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.vue", import.meta.url), "utf8");

const lazyPreviewComponents = ["TextPreview", "PreviewPane", "JsonPreviewPanel"];

describe("App.vue 预览组件保持异步装载（#326 首屏）", () => {
  for (const name of lazyPreviewComponents) {
    it(`${name} 通过 defineAsyncComponent 装载`, () => {
      const lazy = new RegExp(
        `const\\s+${name}\\s*=\\s*defineAsyncComponent\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*"\\.\\/components\\/${name}\\.vue"\\s*\\)\\s*\\)`,
      );
      expect(app).toMatch(lazy);
    });

    it(`${name} 没有静态 import 回退`, () => {
      const eager = new RegExp(`^import\\s+${name}\\s+from\\s+"\\.\\/components\\/${name}\\.vue";`, "m");
      expect(app).not.toMatch(eager);
    });
  }
});
