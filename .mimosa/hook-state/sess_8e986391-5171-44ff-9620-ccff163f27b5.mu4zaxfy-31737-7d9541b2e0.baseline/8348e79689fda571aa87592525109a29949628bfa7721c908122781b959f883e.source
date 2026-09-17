// 宿主主题令牌 → 插件 CSS 变量桥（四插件共用，唯一实现点）。
//
// 宿主在两个时机维护插件根节点上的全套 `--color-*` / `--radius-*` / `--font-*`
// 令牌：srcdoc 首绘前的 boot 样式（host pluginBootThemeCss）与 init/env 消息
// （SDK applyTheme 写 inline tokens）。插件自有命名空间变量（`--background` 等）
// 此前只能在 init 之后由 JS 逐个回写，首绘到 init 之间落在 CSS 里的暗色默认值，
// 亮色宿主下首绘即不同步；且 JS 只回写 8 个颜色，primary/radius/字体从未跟随。
//
// 本桥把插件变量声明为宿主令牌的 var() 引用并以 <style> 追加到 <head> 末尾
// （晚于插件自身样式表，同名声明以桥为准）：首绘即命中宿主主题，宿主主题
// 变化时随 SDK 的令牌更新自动跟随，无需任何 JS。宿主未提供令牌时（Host API
// 1.0、mock 模式）回退到各插件共同的暗色规范值，行为与既往一致（optional 降级）。

// [插件变量, 宿主令牌, 令牌缺失时的回退值]。回退值与四插件 style.css 的
// `:root` 暗色默认保持一致。
const THEME_BRIDGE_VARS = [
  ["--background", "--color-background", "#131416"],
  ["--foreground", "--color-foreground", "#d7d7db"],
  ["--muted", "--color-muted", "#2a2a2d"],
  ["--muted-foreground", "--color-muted-foreground", "#97989d"],
  ["--accent", "--color-accent", "#2e2f33"],
  ["--accent-foreground", "--color-accent-foreground", "#dddde2"],
  ["--border", "--color-border", "rgb(110 110 114 / 28%)"],
  ["--destructive", "--color-destructive", "#ef4444"],
  ["--primary", "--color-primary", "#3b82f6"],
  ["--primary-foreground", "--color-primary-foreground", "#fff"],
  ["--popover", "--color-popover", "color-mix(in srgb, var(--background) 94%, var(--foreground))"],
  // 语义状态色：宿主 tokens.css 的 success/warning 规范块经全套 --color-*
  // 推送直达插件；令牌缺失（Host API 1.0 / mock）时回退 DBX 暗色规范值，
  // 亮色规范值见 themeBridgeCss 的 light 块。四插件状态徽章/横幅一律引用
  // 这两个变量，禁止再写 #10b981 / #22c55e / #f97316 / #d97706 等散装 hex。
  ["--success", "--color-success", "rgb(74 222 128)"],
  ["--success-bg", "--color-success-bg", "color-mix(in srgb, var(--success) 14%, transparent)"],
  ["--warning", "--color-warning", "rgb(251 191 36)"],
  ["--warning-bg", "--color-warning-bg", "color-mix(in srgb, var(--warning) 14%, transparent)"],
  ["--info", "--color-info", "rgb(96 165 250)"],
  ["--radius", "--radius-md", "6px"],
  ["--ui-font-family", "--font-sans", 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'],
  // ssh 用 --terminal-font-family，其余插件用 --mono-font-family，两个名字都桥。
  ["--mono-font-family", "--font-mono", "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"],
  ["--terminal-font-family", "--font-mono", "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"],
] as const;

export const THEME_BRIDGE_STYLE_ID = "dbx-host-theme-bridge";

/** 生成令牌桥 CSS；`overrides` 可按插件变量名替换回退值。 */
export function themeBridgeCss(overrides?: Partial<Record<string, string>>): string {
  const declarations = THEME_BRIDGE_VARS.map(([pluginVar, token, fallback]) => {
    const value = overrides?.[pluginVar] ?? fallback;
    return `${pluginVar}:var(${token},${value})`;
  });
  // 模态遮罩：亮色统一黑 40%（不依赖 init 时机，首绘即成立）；暗色宿主
  // init 后换成背景 mix。语义状态色在 Host API 1.0 / mock（无 --color-*
  // 令牌）且宿主声明为亮色时回退 DBX 亮色规范值；分支同时匹配宿主 SDK
  // 维护的 data-dbx-theme 与插件 applyAppearance 写的 data-theme，谁先到
  // 都生效。
  // color-scheme 分支同样双属性匹配：Host API 1.0 / mock 下宿主 SDK 不写
  // data-dbx-theme，只有插件 applyAppearance 的 data-theme；漏掉会让 UA 表单
  // 控件（复选框/滚动条）在亮色宿主仍按暗色渲染。
  const scheme = ':root[data-dbx-theme="light"],:root[data-theme="light"]{color-scheme:light}:root[data-dbx-theme="dark"],:root[data-theme="dark"]{color-scheme:dark}';
  const lightStatus = ':root[data-dbx-theme="light"],:root[data-theme="light"]{--success:var(--color-success,rgb(22 163 74));--warning:var(--color-warning,rgb(217 119 6));--info:var(--color-info,rgb(37 99 235))}';
  const darkOverlay = ':root[data-dbx-theme="dark"],:root[data-theme="dark"]{--overlay:color-mix(in srgb, var(--background) 70%, transparent)}';
  return `:root{${declarations.join(";")};--overlay:rgb(0 0 0 / 40%)}${scheme}${lightStatus}${darkOverlay}`;
}

/** 把令牌桥样式装进当前文档（幂等，重复调用更新既有节点）。 */
export function installHostThemeBridge(overrides?: Partial<Record<string, string>>): void {
  if (typeof document === "undefined") return;
  const css = themeBridgeCss(overrides);
  let element = document.getElementById(THEME_BRIDGE_STYLE_ID);
  if (!element) {
    element = document.createElement("style");
    element.id = THEME_BRIDGE_STYLE_ID;
    document.head.appendChild(element);
  }
  element.textContent = css;
}
