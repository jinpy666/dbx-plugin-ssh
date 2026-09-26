// @vitest-environment happy-dom
// QuickCommandsSection 组件测试（M32-A3）：管理视图三态（列表/编辑器/导入）、
// 保存载荷上抛、删除 confirm 门、导入预览 → accepted 条目上抛。
import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import QuickCommandsSection from "./QuickCommandsSection.vue";
import { workbenchMessage } from "../lib/i18n";
import type { QuickCommand } from "../lib/quickCommands";

const t = (key: string, values?: Record<string, string | number>) => workbenchMessage("zh-CN", key, values);

const commands: QuickCommand[] = [
  { id: "q1", name: "disk free", command: "df -h" },
  { id: "q2", name: "ports", command: "ss -tlnp" },
];

function mountSection(props: { commands?: QuickCommand[]; saving?: boolean; importing?: boolean } = {}) {
  return mount(QuickCommandsSection, {
    props: {
      commands: props.commands ?? commands,
      saving: props.saving ?? false,
      importing: props.importing ?? false,
      limit: 20,
      t,
    },
  });
}

async function click(wrapper: ReturnType<typeof mountSection>, selector: string, text?: string) {
  const candidates = wrapper.findAll(selector);
  const target = text ? candidates.find((node) => node.text().includes(text)) : candidates[0];
  expect(target, `点击目标存在: ${selector} ${text ?? ""}`).toBeTruthy();
  await target!.trigger("click");
  await flushPromises();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("QuickCommandsSection", () => {
  it("lists commands with edit/delete actions and emits delete after confirm", async () => {
    const wrapper = mountSection();
    expect(wrapper.findAll(".quick-manage-list li")).toHaveLength(2);
    // happy-dom 无 window.confirm：直接替换实现模拟"取消/确认"两档。
    const originalConfirm = window.confirm;
    window.confirm = () => false;
    await click(wrapper, '.quick-manage-list li button[title="删除"]');
    expect(wrapper.emitted("delete")).toBeUndefined();
    window.confirm = () => true;
    await click(wrapper, '.quick-manage-list li button[title="删除"]');
    expect(wrapper.emitted("delete")![0][0]).toBe("q1");
    window.confirm = originalConfirm;
  });

  it("creates a command through the editor view and emits the trimmed payload", async () => {
    const wrapper = mountSection();
    await click(wrapper, ".quick-manage-actions .link-button", "新建");
    const name = wrapper.find(".quick-command-editor input");
    const command = wrapper.find(".quick-command-editor textarea");
    await name.setValue("uptime");
    await command.setValue("  uptime  ");
    await wrapper.find(".quick-command-editor-actions .primary-button").trigger("click");
    expect(wrapper.emitted("save")![0][0]).toEqual({ id: undefined, name: "uptime", command: "uptime" });
    // 数据面在 App：保存成功 = commands 数组整体替换，编辑器随之收口。
    await wrapper.setProps({ commands: [...commands, { id: "q3", name: "uptime", command: "uptime" }] });
    expect(wrapper.find(".quick-command-editor").exists()).toBe(false);
  });

  it("previews pasted JSON and emits only accepted items on import confirm", async () => {
    const wrapper = mountSection();
    await click(wrapper, ".quick-manage-actions .link-button", "导入");
    const textarea = wrapper.find(".quick-command-editor textarea");
    await textarea.setValue(JSON.stringify([{ name: "disk free", command: "df -h" }, { name: "who", command: "who" }]));
    // 同名跳过（disk free 已存在）→ 预览汇总只接受 who（计数口径）。
    await flushPromises();
    expect(wrapper.text()).toContain("可导入 1 条");
    expect(wrapper.text()).toContain("跳过同名 1");
    await click(wrapper, ".quick-command-editor-actions .primary-button");
    expect(wrapper.emitted("import")![0][0]).toEqual([{ name: "who", command: "who" }]);
    await wrapper.setProps({ commands: [...commands, { id: "q3", name: "who", command: "who" }] });
    expect(wrapper.find(".quick-import-file").exists()).toBe(false);
  });
});
