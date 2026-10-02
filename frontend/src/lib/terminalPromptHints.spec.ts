// 空提示符快捷键引导条纯逻辑单测：显隐门矩阵（开关/消散旗标/会话在场/行空/
// alternate/命令运行/传输/浮层互斥）与 pluginStore 持久化回环。渲染与定位
// 在 TerminalPromptHints.vue（smoke 走查覆盖）。
import { afterEach, describe, expect, it } from "vitest";
import { choosePromptHintsPlacement, PROMPT_HINTS_FALLBACK_BAR_HEIGHT } from "./terminalPromptHints";
import { pluginStore } from "./pluginStore";
import {
  loadPromptHintsDismissed,
  loadPromptHintsEnabled,
  savePromptHintsDismissed,
  savePromptHintsEnabled,
  isPasswordPromptLine,
  shouldShowPromptHints,
  type PromptHintsGates,
} from "./terminalPromptHints";

const gates = (patch: Partial<PromptHintsGates> = {}): PromptHintsGates => ({
  enabled: true,
  dismissed: false,
  sessionActive: true,
  lineEmpty: true,
  alternateActive: false,
  commandRunning: false,
  transferBusy: false,
  overlayOpen: false,
  aiSearchActive: false,
  outputQuiet: true,
  passwordPromptOnScreen: false,
  ...patch,
});

describe("shouldShowPromptHints", () => {
  it("静置空行且无遮挡时显示", () => {
    expect(shouldShowPromptHints(gates())).toBe(true);
  });

  it("# AI 搜索模式在场即隐藏（该模式字节不进 PTY，lineEmpty 恒真）", () => {
    expect(shouldShowPromptHints(gates({ aiSearchActive: true }))).toBe(false);
  });

  it("输出活跃与凭据提示均抑制（登录刷屏 / Password: 场景）", () => {
    expect(shouldShowPromptHints(gates({ outputQuiet: false }))).toBe(false);
    expect(shouldShowPromptHints(gates({ passwordPromptOnScreen: true }))).toBe(false);
  });

  it("isPasswordPromptLine：password/口令/密码提示命中，空串与普通行不命中", () => {
    expect(isPasswordPromptLine("Password:")).toBe(true);
    expect(isPasswordPromptLine("[sudo] password for jinpy:")).toBe(true);
    expect(isPasswordPromptLine("Enter password:")).toBe(true);
    expect(isPasswordPromptLine("请输入密码：")).toBe(true);
    expect(isPasswordPromptLine("postgres=# select 1;")).toBe(false);
    expect(isPasswordPromptLine("")).toBe(false);
  });

  it("任一门关闭即不显示（逐项验证）", () => {
    expect(shouldShowPromptHints(gates({ enabled: false }))).toBe(false);
    expect(shouldShowPromptHints(gates({ dismissed: true }))).toBe(false);
    expect(shouldShowPromptHints(gates({ sessionActive: false }))).toBe(false);
    expect(shouldShowPromptHints(gates({ lineEmpty: false }))).toBe(false);
    expect(shouldShowPromptHints(gates({ alternateActive: true }))).toBe(false);
    expect(shouldShowPromptHints(gates({ commandRunning: true }))).toBe(false);
    expect(shouldShowPromptHints(gates({ transferBusy: true }))).toBe(false);
    expect(shouldShowPromptHints(gates({ overlayOpen: true }))).toBe(false);
  });

  it("设置关闭压过一切（即便旗标也被清除）", () => {
    expect(shouldShowPromptHints(gates({ enabled: false, dismissed: false }))).toBe(false);
  });
});

describe("pluginStore 持久化回环", () => {
  afterEach(() => {
    pluginStore.removeItem("ssh-terminal-prompt-hints-enabled");
    pluginStore.removeItem("ssh-terminal-prompt-hints-dismissed");
  });

  it("开关默认开、读写回环", () => {
    expect(loadPromptHintsEnabled()).toBe(true);
    savePromptHintsEnabled(false);
    expect(loadPromptHintsEnabled()).toBe(false);
    savePromptHintsEnabled(true);
    expect(loadPromptHintsEnabled()).toBe(true);
  });

  it("消散旗标默认未消散、读写回环", () => {
    expect(loadPromptHintsDismissed()).toBe(false);
    savePromptHintsDismissed(true);
    expect(loadPromptHintsDismissed()).toBe(true);
  });
});


describe("choosePromptHintsPlacement", () => {
  const bar = PROMPT_HINTS_FALLBACK_BAR_HEIGHT;
  const vh = 900;

  it("光标在第一行：上方放不下，翻到下方", () => {
    expect(choosePromptHintsPlacement(0, vh, bar)).toBe("below");
    expect(choosePromptHintsPlacement(bar / 2, vh, bar)).toBe("below");
  });

  it("上方恰好放得下（含 gap）保持上方", () => {
    expect(choosePromptHintsPlacement(bar + 8, vh, bar)).toBe("above");
  });

  it("中部常规位置保持上方（底边贴光标行顶）", () => {
    expect(choosePromptHintsPlacement(400, vh, bar)).toBe("above");
  });

  it("视口/条高不可测时保持上方（调用方 CSS fallback 兜底）", () => {
    expect(choosePromptHintsPlacement(0, 0, bar)).toBe("above");
    expect(choosePromptHintsPlacement(0, vh, 0)).toBe("above");
  });

  it("近顶且视口极矮：仍翻下方（翻转判定只看上方空间，下方不再二次校验）", () => {
    expect(choosePromptHintsPlacement(10, 20, bar)).toBe("below");
  });
});
