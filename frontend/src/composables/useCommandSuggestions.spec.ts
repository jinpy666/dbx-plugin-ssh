// @vitest-environment happy-dom
// 结构化补全菜单的按键归属（T1 / §4.1）：本文件不验证「候选数组长什么样」，
// 而是驱动真实 fig 语料 + 真实 composable 键盘处理器，观察最终写入终端的
// 字节与行缓冲——菜单显示 ≠ 键盘所有权，验收只看输入行变成了什么。
import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";
import { useCommandSuggestions } from "./useCommandSuggestions";

interface Harness {
  pending: { value: string };
  written: string[];
  completionOpen: { value: boolean };
  completionItems: { value: Array<{ id: string; label: string; kind: string; edit: unknown }> };
  completionLoading: { value: boolean };
  activationIndex: { value: number };
  openManually: () => void;
  key: (key: string) => boolean;
  setTrusted: (trusted: boolean) => void;
  setLine: (line: string) => void;
}

function harness(): Harness {
  const pending = { value: "" };
  const written: string[] = [];
  let trusted = true;
  const commandRunning = ref(false);
  const terminal = { focus: () => undefined, buffer: { active: { type: "normal" as const } } };
  let api!: ReturnType<typeof useCommandSuggestions>;
  const app = createApp(
    defineComponent({
      setup() {
        api = useCommandSuggestions({
    terminal: () => terminal as never,
    getTerminalHost: () => null,
    sendTerminalBytes: (bytes: Uint8Array) => written.push(new TextDecoder().decode(bytes)),
    getPendingTerminalInput: () => pending.value,
    isInputLineTrusted: () => trusted,
    setPendingTerminalInput: (value: string) => {
      pending.value = value;
    },
    commandRunning,
    isTerminalTransferBusy: () => false,
    commandHistory: ref([]),
    quickCommands: ref([]),
    suggestionsEnabledState: ref(true),
    suggestionMinCharsState: ref(1),
    suggestionMaxCharsState: ref(200),
    terminalCwd: ref(""),
    session: ref(undefined),
    getSessionId: () => "session-a",
    getLocalSessionId: () => undefined,
    persistCommandHistory: () => undefined,
    isHistoryPanelOpen: () => false,
    syncHistoryPanelAnchor: () => undefined,
    updateHistoryPanelFilter: () => undefined,
    pushTerminalCommandHistory: () => undefined,
    inlineGhostActive: () => false,
    isInteractivePromptPending: () => false,
        });
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  return {
    pending,
    written,
    completionOpen: api.completionOpen as unknown as Harness["completionOpen"],
    completionItems: api.completionItems as unknown as Harness["completionItems"],
    completionLoading: api.completionLoading as unknown as Harness["completionLoading"],
    activationIndex: api.completionActiveIndex as unknown as Harness["activationIndex"],
    openManually: api.openCompletionsManually,
    key: (key: string) => api.handleCompletionKey({ type: "keydown", key } as KeyboardEvent),
    setTrusted: (next: boolean) => {
      trusted = next;
    },
    setLine: (line: string) => {
      pending.value = line;
    },
  };
}

describe("completion menu key ownership（字节级）", () => {
  // A01：cd 的本地候选面为空（fig 语料的 `-`/`~` 是 hidden 建议、目录生成器
  // 是 custom 回调），Tab 必须原样交给 shell——此前会写入 `\u0015cd -`。
  it("cd + Tab：无本地候选时不写任何字节，Tab 透传", () => {
    const h = harness();
    h.setLine("cd ");
    h.openManually();

    expect(h.completionOpen.value).toBe(false);
    const consumed = h.key("Tab");

    expect(consumed).toBe(false);
    expect(h.written).toEqual([]);
    expect(h.pending.value).toBe("cd ");
  });

  it("cd pro + Tab：路径前缀同样原样透传", () => {
    const h = harness();
    h.setLine("cd pro");
    h.openManually();

    expect(h.key("Tab")).toBe(false);
    expect(h.written).toEqual([]);
    expect(h.pending.value).toBe("cd pro");
  });

  // A02：相对/绝对/带空格与中文的路径都必须逐字透传，不能被本地候选改写。
  it.each(["cd ./", "cd ../src", "cd /usr/local", "cd 我的 目录", "cd 'a b'"])("%s + Tab：原样透传", (line) => {
    const h = harness();
    h.setLine(line);
    h.openManually();

    expect(h.key("Tab")).toBe(false);
    expect(h.written).toEqual([]);
    expect(h.pending.value).toBe(line);
  });

  // A04：多候选、用户还没选 → 只推进公共前缀；到公共边界后既不填第一项，
  // 也不改行，把选择权留给方向键/点击。
  it("多候选未选择 + Tab：只推进公共前缀，到边界后不再改动输入", () => {
    const h = harness();
    h.setLine("git ch");
    h.openManually();
    expect(h.completionOpen.value).toBe(true);
    expect(h.completionItems.value.length).toBeGreaterThan(1);
    const labels = h.completionItems.value.map((item) => item.label);
    expect(labels).toContain("checkout");
    expect(labels.every((label) => label.startsWith("ch"))).toBe(true);

    // 公共前缀 "che" 比当前 token "ch" 更长 → 只填前缀，菜单保持。
    expect(h.key("Tab")).toBe(true);
    expect(h.written).toEqual(["\u0015git che"]);
    expect(h.pending.value).toBe("git che");
    expect(h.completionOpen.value).toBe(true);

    // 已在公共前缀边界：再按 Tab 不得填空、不得填第一项、不得关闭菜单。
    expect(h.key("Tab")).toBe(true);
    expect(h.written).toEqual(["\u0015git che"]);
    expect(h.pending.value).toBe("git che");
    expect(h.completionOpen.value).toBe(true);
  });

  // A05：方向键是「明确选择」，之后 Tab 接受所选项（而不是公共前缀）。
  it("方向键选中后 Tab：接受所选项并写入整行", () => {
    const h = harness();
    h.setLine("git ch");
    h.openManually();
    const items = h.completionItems.value;

    h.key("ArrowDown");
    const selected = items[h.activationIndex.value];
    expect(h.activationIndex.value).toBe(1);
    expect(selected.label).not.toBe(items[0].label);

    expect(h.key("Tab")).toBe(true);

    expect(h.pending.value).toBe(`git ${selected.label} `);
    expect(h.written).toEqual([`\u0015git ${selected.label} `]);
    // 接受候选不得附带回车。
    expect(h.written.join("")).not.toContain("\r");
  });

  it("唯一候选 + Tab：直接填充（单候选才算唯一）", () => {
    const h = harness();
    h.setLine("git ch");
    h.openManually();
    expect(h.completionOpen.value).toBe(true);
    const only = h.completionItems.value[0];
    h.completionItems.value = [only];

    expect(h.key("Tab")).toBe(true);

    expect(h.pending.value).toBe(`git ${only.label} `);
    expect(h.written).toEqual([`\u0015git ${only.label} `]);
  });

  // A17：模型不可信（原生 Tab/中间编辑后）时不拿旧前缀改写输入行。
  it("输入模型不可信 + Tab：不替换本地候选，Tab 交还 shell", () => {
    const h = harness();
    h.setLine("git ch");
    h.openManually();
    expect(h.completionOpen.value).toBe(true);
    h.setTrusted(false);

    expect(h.key("Tab")).toBe(false);

    expect(h.written).toEqual([]);
    expect(h.pending.value).toBe("git ch");
    expect(h.completionOpen.value).toBe(false);
  });

  it("行已变化（菜单过期）+ Tab：不回填旧行", () => {
    const h = harness();
    h.setLine("git ch");
    h.openManually();
    expect(h.completionOpen.value).toBe(true);
    h.setLine("git ch --");

    expect(h.key("Tab")).toBe(false);

    expect(h.written).toEqual([]);
    expect(h.pending.value).toBe("git ch --");
  });

  it("Escape 关闭菜单不改行；Enter 透传（执行当前行）", () => {
    const h = harness();
    h.setLine("git ch");
    h.openManually();

    expect(h.key("Escape")).toBe(true);
    expect(h.completionOpen.value).toBe(false);
    expect(h.written).toEqual([]);

    h.openManually();
    expect(h.key("Enter")).toBe(false);
    expect(h.written).toEqual([]);
    expect(h.pending.value).toBe("git ch");
  });
});
