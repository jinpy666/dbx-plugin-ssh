import type { TerminalAppearanceState } from "../lib/terminalAppearance";
import type { TerminalFontOverride } from "../lib/terminalFont";
import type { TerminalWriteThrottle } from "../lib/terminalWriteThrottle";
import type { TerminalSyncOutput } from "../lib/terminalModeQueries";
import { computed, type Ref, onBeforeUnmount } from "vue";
import { applyAppearanceColorVars } from "../../../shared/frontend/hostThemeRuntime";
import { DBX_POPOVER, resolveAppearance, TERMINAL_ANSI, type DbxPluginAppearanceInput } from "../lib/appearance";
import { applySchemeToTerminalTheme, CUSTOM_SCHEME_LIMIT, CUSTOM_THEME_LIMIT, persistTerminalAppearance, sanitizeAppearanceSettings, terminalOptionPatch, terminalPaddingVars, type TerminalAppearanceProfile, type TerminalAppearanceSettings } from "../lib/terminalAppearance";
import { sanitizeTerminalBackground } from "../lib/terminalBackground";
import { registerTerminalModeQueryHandlers } from "../lib/terminalModeQueries";
import { handleTerminalColorQuery } from "../lib/terminalOsc";
import { schemeIdFromName, schemeTone, uniqueSchemeId, type TerminalColorScheme, type TerminalThemeLike } from "../lib/terminalScheme";
import { X } from "@lucide/vue";
import type { Terminal } from "@xterm/xterm";

/** 终端外观/主题/字体跟随：宿主基底 + 用户配色方案合成生效主题，CSS 变量
 * 下发（内边距/底色）、xterm 选项落地、OSC 10/11 颜色查询应答与 CSI 模式
 * 查询应答重挂、宿主字体令牌跟随（MutationObserver）。主题快照的保存/删除/
 * 导入亦在此。createTerminal 与 hostFont observe 仍是生命周期根，留在 App.vue。 */
export function useTerminalAppearance(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  appearance: Ref<ReturnType<typeof resolveAppearance>>;
  terminalAppearance: Ref<TerminalAppearanceState>;
  terminalFontOverride: Ref<TerminalFontOverride>;
  terminalFontSize: Ref<number>;
  terminalWriteThrottle: TerminalWriteThrottle;
  terminalSyncOutput: TerminalSyncOutput;
  terminal: () => Terminal | undefined;
  scheduleFit: () => void;
  setTerminalFont: (family: string | null, size: number | null) => void;
}) {
  const { terminal: terminalGet, t, showNotice, appearance, terminalAppearance, terminalFontOverride, terminalFontSize, terminalWriteThrottle, terminalSyncOutput, scheduleFit, setTerminalFont } = options;

const OSC_COLOR_FALLBACK = { foreground: "#c9d1d9", background: "#0d1117" };

// OSC 10/11 颜色查询应答 handler（registerOscHandler 的 disposable）：主题切换
// 时重挂，终端销毁时统一释放；OSC 52 只在 createTerminal 挂一次。
let oscColorQueryDisposables: { dispose(): void }[] = [];
// CSI 能力查询应答（kitty 键盘协议 / XTVERSION / DECRQM）：claude code 等
// TUI 启动时探测并等待应答；xterm 内核对 `CSI ? u` 静默吞掉不回、XTVERSION
// 无 handler，TUI 卡在 raw-mode 初始化——表现为"卡住、键盘没反应"。
let modeQueryDisposables: { dispose(): void }[] = [];

function hostTerminalTheme(): TerminalThemeLike {
  const colors = appearance.value.colors;
  // issue #73：宿主设了背景图片时下发的底色常是 transparent 或
  // var()/color-mix() 这类需级联求值的形态，xterm 的 ITheme 颜色解析拿不到值
  // 就静默回退内建默认底 #000（另有 alpha=0 被压成不透明黑）。进 xterm 前净化
  // 一次；净化只覆盖终端底色（含同源的 --ssh-terminal-background 变量），
  // --background 等 UI 变量仍用宿主原值。
  const terminalBackground = sanitizeTerminalBackground(colors.background, appearance.value.colorScheme);
  return {
    background: terminalBackground,
    foreground: colors.foreground,
    cursor: colors.foreground,
    cursorAccent: terminalBackground,
    selectionBackground: appearance.value.colorScheme === "dark" ? "#5f6f8a88" : "#93b4e088",
    ...TERMINAL_ANSI[appearance.value.colorScheme],
  };
}

// 实际生效的主题：宿主基底 + 用户选定方案（未启用方案时原样返回基底）。
function terminalTheme(): TerminalThemeLike {
  return applySchemeToTerminalTheme(
    hostTerminalTheme(),
    terminalAppearance.value.settings,
    terminalAppearance.value.customSchemes,
    appearance.value.colorScheme,
  );
}

// 终端内边距经 CSS 变量下发（style.css 的 .terminal-host .xterm 读取）；
// 未设置的方向删变量，回落内置值（左 10 / 右 0 / 上 5 / 下 8）。
function applyTerminalPaddingVars() {
  const root = document.documentElement;
  const padding = terminalPaddingVars(terminalAppearance.value.settings);
  const entries: Array<[string, string | null]> = [
    ["--ssh-terminal-padding-left", padding.left],
    ["--ssh-terminal-padding-right", padding.right],
    ["--ssh-terminal-padding-top", padding.top],
    ["--ssh-terminal-padding-bottom", padding.bottom],
  ];
  for (const [name, value] of entries) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

/**
 * 外观改动落地：CSS 变量 + xterm 选项 + 主题 + OSC 颜色应答重挂。
 * 行高/字间距/内边距都会改变单元格尺寸，末尾必须 scheduleFit 重算行列。
 */
function applyTerminalAppearance() {
  applyTerminalPaddingVars();
  const theme = terminalTheme();
  document.documentElement.style.setProperty("--ssh-terminal-background", theme.background);
  const term = terminalGet();
  if (!term) return;
  const patch = terminalOptionPatch(terminalAppearance.value.settings);
  term.options.fontWeight = patch.fontWeight;
  term.options.fontWeightBold = patch.fontWeightBold;
  term.options.lineHeight = patch.lineHeight;
  term.options.letterSpacing = patch.letterSpacing;
  term.options.cursorStyle = patch.cursorStyle;
  term.options.cursorBlink = patch.cursorBlink;
  term.options.cursorInactiveStyle = patch.cursorInactiveStyle;
  term.options.drawBoldTextInBrightColors = patch.drawBoldTextInBrightColors;
  term.options.minimumContrastRatio = patch.minimumContrastRatio;
  term.options.theme = theme;
  // 10/11 应答闭包捕获注册时的颜色值：配色切换后重挂，查询才返回新颜色。
  registerOscColorQueryHandlers();
  scheduleFit();
}

/** 外观设置局部更新（设置页控件）：归一化 → 持久化 → 即时应用。 */
function updateTerminalAppearance(patch: Partial<TerminalAppearanceSettings>) {
  terminalAppearance.value = {
    ...terminalAppearance.value,
    settings: sanitizeAppearanceSettings({ ...terminalAppearance.value.settings, ...patch }),
  };
  persistTerminalAppearance(terminalAppearance.value);
  applyTerminalAppearance();
}

/** 套用主题快照：设置 + 字体一起落地（字体走既有 terminalFont 键与链路）。 */
function applyTerminalAppearanceTheme(theme: TerminalAppearanceProfile) {
  terminalAppearance.value = { ...terminalAppearance.value, settings: sanitizeAppearanceSettings(theme.settings) };
  persistTerminalAppearance(terminalAppearance.value);
  // 主题里的字体为 null 表示「跟随宿主」：把字号键一起清掉（null），否则
  // 快照与实际态不一致、主题永远无法高亮。
  setTerminalFont(theme.font.family, theme.font.size);
  applyTerminalAppearance();
  showNotice(t("terminalAppearance.themeApplied", { name: t(theme.name) }));
}

/** 保存当前配置为「我的主题」（字体取缩放链路当前的覆盖态）。 */
function saveTerminalAppearanceTheme(name: string) {
  const theme: TerminalAppearanceProfile = {
    id: uniqueSchemeId(schemeIdFromName(name), terminalAppearance.value.customThemes.map((item) => item.id)),
    name,
    builtin: false,
    settings: sanitizeAppearanceSettings(terminalAppearance.value.settings),
    font: { family: terminalFontOverride.value.fontFamily, size: terminalFontOverride.value.fontSize },
  };
  const customThemes = [...terminalAppearance.value.customThemes, theme].slice(-CUSTOM_THEME_LIMIT);
  terminalAppearance.value = { ...terminalAppearance.value, customThemes };
  persistTerminalAppearance(terminalAppearance.value);
  showNotice(t("terminalAppearance.themeSaved", { name }));
}

function deleteTerminalAppearanceTheme(id: string) {
  terminalAppearance.value = {
    ...terminalAppearance.value,
    customThemes: terminalAppearance.value.customThemes.filter((theme) => theme.id !== id),
  };
  persistTerminalAppearance(terminalAppearance.value);
}

/**
 * 导入外部配色方案（Tabby/iTerm2/Windows Terminal/Xresources）：
 * 分配唯一 id、落盘；单个方案或首个方案按自身亮暗挂到对应槽位并切到
 * 「使用配色方案」——导入的意图通常就是立刻用上，否则用户还要再点一次。
 */
function addImportedSchemes(schemes: Array<Omit<TerminalColorScheme, "id" | "source">>) {
  const existing = terminalAppearance.value.customSchemes;
  const taken = existing.map((scheme) => scheme.id);
  const added: TerminalColorScheme[] = [];
  for (const item of schemes) {
    if (existing.length + added.length >= CUSTOM_SCHEME_LIMIT) break;
    const id = uniqueSchemeId(schemeIdFromName(item.name), taken);
    taken.push(id);
    added.push({ ...item, id, source: "custom" });
  }
  if (!added.length) {
    showNotice(t("terminalAppearance.importEmpty"));
    return;
  }
  const first = added[0];
  const slot = schemeTone(first) === "light" ? "lightSchemeId" : "darkSchemeId";
  terminalAppearance.value = {
    ...terminalAppearance.value,
    customSchemes: [...existing, ...added],
    settings: sanitizeAppearanceSettings({ ...terminalAppearance.value.settings, schemeSource: "custom", [slot]: first.id }),
  };
  persistTerminalAppearance(terminalAppearance.value);
  applyTerminalAppearance();
  showNotice(t("terminalAppearance.importImported", { count: added.length }));
}

/** 删除自定义方案：同时清掉引用它的槽位，避免持久化悬空 id。 */
function removeImportedScheme(id: string) {
  const scheme = terminalAppearance.value.customSchemes.find((item) => item.id === id);
  const settings = terminalAppearance.value.settings;
  terminalAppearance.value = {
    ...terminalAppearance.value,
    customSchemes: terminalAppearance.value.customSchemes.filter((item) => item.id !== id),
    settings: sanitizeAppearanceSettings({
      ...settings,
      darkSchemeId: settings.darkSchemeId === id ? null : settings.darkSchemeId,
      lightSchemeId: settings.lightSchemeId === id ? null : settings.lightSchemeId,
    }),
  };
  persistTerminalAppearance(terminalAppearance.value);
  applyTerminalAppearance();
  if (scheme) showNotice(t("terminalAppearance.schemeRemoved", { name: scheme.name }));
}

// 颜色变量 → 宿主令牌名探测/回退循环收敛到 shared 单点（X-P4，kafka 策略为
// 准）；此处只保留 ssh 特有的终端底色/字体处理。
function applyAppearance(next: DbxPluginAppearanceInput) {
  // 宿主可能缺字段（1.0 或部分下发、1.1 theme 通道只带颜色令牌），按 DBX 规范色板补齐。
  const resolved = resolveAppearance(next);
  appearance.value = resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved.colorScheme;
  root.style.colorScheme = resolved.colorScheme;
  applyAppearanceColorVars(root, resolved.colors);
  root.style.setProperty("--popover", DBX_POPOVER[resolved.colorScheme]);
  // 终端底色：启用配色方案且背景来源为「方案」时取方案底色，否则宿主面板色。
  root.style.setProperty("--ssh-terminal-background", terminalTheme().background);
  followHostFonts(resolved);
  applyTerminalAppearance();
  const term = terminalGet();
  if (term) {
    // 宿主下发的字体大小即缩放基准；外观切换后回到基准值，
    // 但用户单独调过的字号（issue #31 持久化覆盖）优先于宿主基准。
    terminalFontSize.value = terminalFontOverride.value.fontSize ?? resolved.terminal.fontSize;
    term.options.fontSize = terminalFontSize.value;
    scheduleFit();
  }
}

// vim/tmux/neovim 等启动时用 OSC 10/11 查询终端前景/背景色定调色板；xterm 内核
// 不应答，这里按当前主题补答（对标 electerm）。颜色"设置"分支交回内核处理。
function registerOscColorQueryHandlers() {
  for (const disposable of oscColorQueryDisposables) {
    if (disposable.dispose) disposable.dispose();
  }
  oscColorQueryDisposables = [];
  registerModeQueryHandlers();
  const term = terminalGet();
  if (!term) return;
  // 应答当前「生效」主题的前景/背景（宿主基底已被配色方案覆盖时返回方案色），
  // 否则 vim/tmux 会按宿主色板渲染，与屏幕实际底色不一致。
  const theme = terminalTheme();
  oscColorQueryDisposables.push(
    term.parser.registerOscHandler(10, (data) =>
      handleTerminalColorQuery(term, 10, theme.foreground, OSC_COLOR_FALLBACK.foreground, data),
    ),
    term.parser.registerOscHandler(11, (data) =>
      handleTerminalColorQuery(term, 11, theme.background, OSC_COLOR_FALLBACK.background, data),
    ),
  );
}

// CSI 能力查询应答只在终端创建时挂一次：应答与主题无关，无需随外观重挂。
// DECSET 2026 拦截驱动合帧通道的 hold/release；DECRQM 2026 按实时同步态回
// set/reset（其余私有模式维持 reset，不回 0 打扰探测其它模式的 TUI）。
function registerModeQueryHandlers() {
  for (const disposable of modeQueryDisposables) disposable.dispose();
  modeQueryDisposables = [];
  const term = terminalGet();
  if (!term) return;
  const dispose = registerTerminalModeQueryHandlers(term, {
    syncOutput: terminalSyncOutput,
    decRqmState: (mode) => (mode === 2026 ? (terminalWriteThrottle.held ? 1 : 2) : 2),
  });
  modeQueryDisposables.push({ dispose });
}

// 字体始终跟随宿主：不写内联字体变量——内联样式会压过 themeSync 桥样式表里的
// var(--font-sans)/var(--font-mono) 引用（这正是宿主全局字体此前不生效的根因），
// 撤出内联后桥引用直接命中宿主令牌，宿主改字体经 SDK 令牌推送自动跟随。
function followHostFonts(resolved: ReturnType<typeof resolveAppearance>) {
  const root = document.documentElement;
  root.style.removeProperty("--ui-font-family");
  root.style.removeProperty("--terminal-font-family");
  const term = terminalGet();
  if (term) {
    // 用户单独设置过字体族时保持用户值（issue #31），否则跟随宿主。
    term.options.fontFamily = terminalFontOverride.value.fontFamily ?? hostTerminalFontFamily(resolved);
    scheduleFit();
  }
}

// xterm 需要具体字体串（不认 CSS 变量）：取 --terminal-font-family 的计算值
// （桥已把宿主令牌/回退解析好），计算值为空时回退 appearance 解析值。
function hostTerminalFontFamily(resolved: ReturnType<typeof resolveAppearance>): string {
  const computed = getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-family").trim();
  return computed || resolved.terminal.fontFamily;
}

// 宿主字体令牌经 SDK applyTheme 写 :root 内联样式推送（无事件通道）：观察
// style 属性变化，终端字体随之更新；插件自身写颜色令牌也会触发，
// 计算值未变时为空操作。
const hostFontObserver = new MutationObserver(() => {
  const term = terminalGet();
  if (!term) return;
  // 用户单独设置过字体族时不跟随宿主字体变化（issue #31）。
  if (terminalFontOverride.value.fontFamily) return;
  const family = hostTerminalFontFamily(appearance.value);
  if (family !== term.options.fontFamily) {
    term.options.fontFamily = family;
    scheduleFit();
  }
});


  onBeforeUnmount(() => {
    for (const disposable of oscColorQueryDisposables) disposable.dispose();
    oscColorQueryDisposables = [];
    for (const disposable of modeQueryDisposables) disposable.dispose();
    modeQueryDisposables = [];
  });

  return {
    terminalTheme,
    hostTerminalTheme,
    applyTerminalPaddingVars,
    applyTerminalAppearance,
    updateTerminalAppearance,
    applyTerminalAppearanceTheme,
    saveTerminalAppearanceTheme,
    deleteTerminalAppearanceTheme,
    addImportedSchemes,
    removeImportedScheme,
    applyAppearance,
    registerOscColorQueryHandlers,
    hostTerminalFontFamily,
    hostFontObserver,
  };
}
