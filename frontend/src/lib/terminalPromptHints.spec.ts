// 空提示符快捷键引导条纯逻辑单测：显隐门矩阵（开关/消散旗标/会话在场/行空/
// alternate/命令运行/传输/浮层互斥）与 pluginStore 持久化回环。渲染与定位
// 在 TerminalPromptHints.vue（smoke 走查覆盖）。
import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  loadPromptHintsDismissed,
  loadPromptHintsEnabled,
  savePromptHintsDismissed,
  savePromptHintsEnabled,
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
  ...patch,
});

describe("shouldShowPromptHints", () => {
  it("静置空行且无遮挡时显示", () => {
    expect(shouldShowPromptHints(gates())).toBe(true);
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
