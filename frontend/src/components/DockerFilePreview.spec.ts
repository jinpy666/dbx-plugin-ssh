// @vitest-environment happy-dom
// DockerFilePreview 是纯呈现组件：只验证「状态 → 界面」与草稿/save 事件，
// 读取、可编辑判定与上限计算由 DockerFilesPane 的测试职责覆盖。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DockerFilePreview from "./DockerFilePreview.vue";
import type { DockerFileContent, DockerFileEntry } from "../lib/dockerFiles";

const t = (key: string) => key;

const entry: DockerFileEntry = { name: "app.conf", path: "/etc/app.conf", kind: "file", size: 12 };
const content: DockerFileContent = { path: "/etc/app.conf", dataBase64: "", size: 12, truncated: false };

function mountPreview(overrides: Record<string, unknown> = {}) {
  return mount(DockerFilePreview, {
    props: {
      t,
      entry: null,
      content: null,
      loading: false,
      error: "",
      canEdit: false,
      previewText: null,
      previewTruncated: false,
      dirty: false,
      tooLarge: false,
      saving: false,
      draft: "",
      ...overrides,
    },
  });
}

describe("DockerFilePreview", () => {
  it("asks for a file when nothing is selected", () => {
    const wrapper = mountPreview();
    expect(wrapper.text()).toContain("docker.filesSelectFile");
    expect(wrapper.find("section").attributes("aria-label")).toBe("docker.filesPreview");
  });

  it("shows the loading hint before the content arrives", () => {
    const wrapper = mountPreview({ entry, loading: true });
    expect(wrapper.text()).toContain("docker.filesLoading");
  });

  it("renders read-only text when editing is unavailable", () => {
    const wrapper = mountPreview({ entry, content, previewText: "hello" });
    expect(wrapper.find("pre").text()).toBe("hello");
    expect(wrapper.find("textarea").exists()).toBe(false);
  });

  it("falls back to the binary hint when there is no preview text", () => {
    const wrapper = mountPreview({ entry, content });
    expect(wrapper.text()).toContain("docker.filesBinary");
  });

  it("binds the draft through the textarea", async () => {
    const wrapper = mountPreview({ entry, content, canEdit: true, previewText: "hello", draft: "hello" });
    const textarea = wrapper.find("textarea");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("hello");
    await textarea.setValue("hello world");
    expect(wrapper.emitted("update:draft")?.at(-1)).toEqual(["hello world"]);
  });

  it("keeps save disabled until the draft is dirty and within the limit", async () => {
    const clean = mountPreview({ entry, content, canEdit: true, previewText: "hello" });
    expect(clean.find("button").attributes("disabled")).toBeDefined();

    const dirty = mountPreview({ entry, content, canEdit: true, previewText: "hello", dirty: true });
    const button = dirty.find("button");
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    expect(dirty.emitted("save")).toHaveLength(1);
  });

  it("disables save while saving or when the draft is too large", () => {
    for (const flags of [{ saving: true }, { tooLarge: true }]) {
      const wrapper = mountPreview({ entry, content, canEdit: true, previewText: "hello", dirty: true, ...flags });
      expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    }
  });

  it("explains why saving is unavailable", () => {
    const truncated = mountPreview({ entry, content, previewTruncated: true });
    expect(truncated.text()).toContain("docker.filesPreviewTruncated");

    const tooLarge = mountPreview({ entry, content, canEdit: true, dirty: true, tooLarge: true });
    expect(tooLarge.findAll(".docker-files-error").length).toBe(1);
  });
});
