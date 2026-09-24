// @vitest-environment happy-dom
// SerialUploadDialog 组件测试：文件选择驱动提交可用性、超限提示、协议
// 选择随提交 emit、busy 时禁止再次发起（并发第二次 upload 的前端闸门）。
// 弹窗壳为 reka Dialog（portal 到 document.body），查询走 body 真实 DOM。
import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SerialUploadDialog from "./SerialUploadDialog.vue";

const q = <T extends HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const bodyText = () => document.body.textContent ?? "";

function mountDialog(props: { locale?: string; busy?: boolean } = {}) {
  return mount(SerialUploadDialog, {
    props: { locale: props.locale ?? "zh-CN", open: true, busy: props.busy ?? false },
    attachTo: document.body,
  });
}

function pickFile(wrapper: ReturnType<typeof mountDialog>, file: File) {
  const input = q<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return flushPromises().then(() => wrapper);
}

async function click(el: Element | null) {
  expect(el, "点击目标存在").toBeTruthy();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  await flushPromises();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SerialUploadDialog", () => {
  it("renders seven-language copy via locale and keeps start disabled without a file", async () => {
    const wrapper = mountDialog({ locale: "zh-CN" });
    await flushPromises();
    expect(bodyText()).toContain("串口发送文件");
    const start = q<HTMLButtonElement>(".primary-button")!;
    expect(start.disabled).toBe(true);
    wrapper.unmount();
  });

  it("enables submit after choosing a file and emits file plus protocol", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    await pickFile(wrapper, new File([new Uint8Array(4)], "fw.bin"));
    expect(bodyText()).toContain("fw.bin");
    const start = q<HTMLButtonElement>(".primary-button")!;
    expect(start.disabled).toBe(false);
    await click(start);
    expect(wrapper.emitted("start")).toEqual([[{ file: expect.any(File), protocol: "xmodem" }]]);
    const emitted = wrapper.emitted("start")![0][0] as { file: File };
    expect(emitted.file.name).toBe("fw.bin");
    wrapper.unmount();
  });

  it("follows the protocol select value on submit", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    await pickFile(wrapper, new File([new Uint8Array(1)], "a.bin"));
    const select = q<HTMLSelectElement>("select")!;
    select.value = "zmodem";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();
    await click(q<HTMLButtonElement>(".primary-button"));
    expect(wrapper.emitted("start")![0][0]).toMatchObject({ protocol: "zmodem" });
    wrapper.unmount();
  });

  it("flags files over the 256 MiB serial cap and blocks submit", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const big = new File([new Uint8Array(8)], "big.bin");
    Object.defineProperty(big, "size", { value: 256 * 1024 * 1024 + 1 });
    await pickFile(wrapper, big);
    expect(bodyText()).toContain("超过 256 MiB");
    expect(q<HTMLButtonElement>(".primary-button")!.disabled).toBe(true);
    wrapper.unmount();
  });

  it("keeps start disabled while an upload is already running (busy)", async () => {
    const wrapper = mountDialog({ busy: true });
    await flushPromises();
    await pickFile(wrapper, new File([new Uint8Array(4)], "fw.bin"));
    expect(q<HTMLButtonElement>(".primary-button")!.disabled).toBe(true);
    // busy 下点击也不 emit。
    await click(q<HTMLButtonElement>(".primary-button"));
    expect(wrapper.emitted("start")).toBeUndefined();
    wrapper.unmount();
  });
});
