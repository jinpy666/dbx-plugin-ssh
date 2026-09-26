// 终端底色净化（issue #73：DBX 设置背景图片后终端变纯黑，且未完全修复）。
//
// 根因在 xterm 的 ITheme 颜色解析链，不在插件主题合成：
//   - `ThemeService._setTheme` 用内部 `css.toColor()` 解析 `theme.background`，
//     解析抛错时**静默回退内建常量 `#000000`**（xterm.js：`function m(e,t){if
//     (void 0!==e)try{return a.css.toColor(e)}catch{} return t}`，其中
//     t = `css.toColor("#000000")`）；
//   - `css.toColor()` 只可靠处理四类输入：hex（3/4/6/8 位）、**逗号分隔**的
//     rgb()/rgba()、字面 `transparent`（解析成功但 rgba=0），其余全靠 canvas
//     探针；探针遇到无效 `fillStyle`（如 `var(--x)` / `color-mix(...)` 这类
//     必须级联求值、detached 上下文取不到值的形态）会抛 "Unsupported css
//     format"，同样落到黑底；
//   - 字面 `transparent` 虽解析成功，但未开 allowTransparency 时渲染器把
//     alpha=0 压成不透明黑。
//
// 宿主设背景图时下发的 `--color-background` 恰好常落在这两类上（transparent
// 或 color-mix/var 形态），于是「一设背景图终端就全黑」。M29 前的
// `21c66bf2` 只压掉了 viewport 的 `#000` 规则（黑边框那一半来源），主题底色
// 自身仍会落黑——本模块补的是这一半。
//
// 净化口径——只拦「可证明 xterm 拿不到色」的取值，其余一律原样透传，不做等价
// 改写、不误伤可用颜色：
//   1. 非字符串 / 空白                        → 回退；
//   2. 字面 `transparent`（不分大小写）        → 回退（alpha=0 压黑）；
//   3. 需级联求值的函数形态
//      （var / color-mix / light-dark / env / calc）→ 回退（探针必抛错）；
//   4. hex 或 rgb()/rgba() 显式 alpha≤0        → 回退（与「没有颜色」同义）；
//   5. 其余（hex、rgb()/rgba()、hsl()、命名色）→ **原样透传**，交 xterm 自己的
//      解析路径，插件侧绝不改写宿主颜色。
//
// 颜色识别口径与 lib/terminalOsc.ts 的 parseCssColorToRgb 对齐（仓库内 CSS
// 颜色解析的唯一实现点，OSC 10/11 应答同源）。调用点在 App.vue 的
// hostTerminalTheme()——它同时喂给 xterm 的 ITheme 与 --ssh-terminal-background
// 变量，因此两者的取值保持一致；--background 等 UI 变量不经过本模块，仍用宿主
// 原值（浏览器的解析能力远宽于 xterm）。
//
// 不在本模块范围内（登记为后续）：让宿主背景图真正透出终端需要 xterm
// `allowTransparency: true`（连带渲染器与 WebGL 取舍），属独立决策，见
// docs/ISSUE-TRIAGE.zh-CN.md #73 条目。

import { DBX_APPEARANCE_PALETTES } from "./appearance";

/** 需级联上下文才能求值、detached 解析拿不到值的函数形态。 */
const RESOLUTION_REQUIRED = /(?:^|[^\w-])(?:var|color-mix|light-dark|env|calc)\s*\(/i;

const HEX_WITH_ALPHA = /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i;
const FUNCTIONAL_RGB = /^rgba?\(\s*([^)]*)\)$/i;

const TRANSPARENT_KEYWORD = "transparent";

/** 8 位 hex 的 alpha 字节为 00，或 4 位 hex 的 alpha 半字节为 0。 */
function hexAlphaIsZero(value: string): boolean {
  if (!HEX_WITH_ALPHA.test(value)) return false;
  const digits = value.slice(1);
  return digits.length === 8 ? digits.slice(6, 8) === "00" : digits.slice(3, 4) === "0";
}

/** rgb()/rgba() 显式写出的 alpha（逗号第 4 段或 `/` 之后）为 0。 */
function functionalAlphaIsZero(value: string): boolean {
  const match = value.match(FUNCTIONAL_RGB);
  if (!match) return false;
  const body = match[1] ?? "";
  const slashParts = body.split("/");
  const alphaToken = (slashParts.length > 1 ? slashParts[1] : body.split(",")[3])?.trim();
  if (!alphaToken) return false;
  if (alphaToken.endsWith("%")) {
    const percent = Number(alphaToken.slice(0, -1));
    return Number.isFinite(percent) && percent <= 0;
  }
  const alpha = Number(alphaToken);
  return Number.isFinite(alpha) && alpha <= 0;
}

/**
 * 该取值是否「可证明 xterm 拿不到颜色」。
 *
 * 自带 trim，与 {@link sanitizeTerminalBackground} 判定口径一致（前缀空白不该
 * 改变结论）。返回 false 只表示"本模块判不了"，不代表可用——调用方按透传处理，
 * 让 xterm 自己的解析器（含 canvas 探针）去定夺。
 */
export function isUnusableTerminalBackground(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === TRANSPARENT_KEYWORD) return true;
  if (RESOLUTION_REQUIRED.test(trimmed)) return true;
  return hexAlphaIsZero(trimmed) || functionalAlphaIsZero(trimmed);
}

/**
 * 宿主底色 → xterm 可安全消费的底色。
 *
 * 仅当取值可证明 xterm 会落黑（空值 / 全透明 / 需级联求值）时回退到当前明暗的
 * 规范色板底色；其余原样返回，保证宿主颜色保真。
 */
export function sanitizeTerminalBackground(value: unknown, colorScheme: "light" | "dark"): string {
  const fallback = DBX_APPEARANCE_PALETTES[colorScheme].background;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (isUnusableTerminalBackground(trimmed)) return fallback;
  // 其余形态（hex、rgb()/rgba()、hsl()、命名色）一律透传：判不了的不等于坏值，
  // 交 xterm 自己的解析路径定夺，插件侧不改写宿主颜色。
  return trimmed;
}
