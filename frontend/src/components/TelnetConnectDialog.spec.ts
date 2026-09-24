// @vitest-environment happy-dom
// TelnetConnectDialog 组件测试：连接表单语义与两种自动登录形态的互斥提交
//（P0-1 声明式 + 既有 Expect 规则）：
// - 基础字段（host/port/enterMode/backspaceMode）与空表单默认不携带自动登录；
// - Expect 规则 + 密文槽原样随请求下发（回归）；
// - 声明式启用后：凭据/非空正则/重试次数打包进 declarative，规则区被忽略，
//   空白正则不下发（由 sidecar 落内置默认），重试钳到 0..=10；
// - 凭据缺失时阻止提交并显示可读错误。
// Dialog 内容 portal 到 body，按 FolderPickerDialog.spec 的方式直接查询
// document.body。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TelnetConnectDialog from "./TelnetConnectDialog.vue";
import type { TelnetConnectOptions } from "./TelnetConnectDialog.vue";

// 组件内部直接用 workbenchMessage(locale)（无 t prop），断言用 en 文案本身。

async function mountDialog(props: { locale?: string; open?: boolean } = {}) {
  const wrapper = mount(TelnetConnectDialog, {
    props: { locale: "en", open: true, ...props },
    attachTo: document.body,
  });
  // Dialog 内容经 Teleport 挂到 body，等一个 tick 再查询。
  await flushPromises();
  return wrapper;
}

const q = <T extends HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const qa = <T extends HTMLElement>(selector: string) => [...document.body.querySelectorAll<T>(selector)];

async function click(el: Element | null) {
  expect(el, "点击目标存在").toBeTruthy();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  await flushPromises();
}

function setInput(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(input, "输入框存在").toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 声明式区内输入框顺序：用户名/密码/用户名提示正则/密码提示正则/成功/失败/重试。 */
function declInputs() {
  const details = qa("details.telnet-auto-login")[0];
  expect(details, "声明式折叠区存在").toBeTruthy();
  return [...details!.querySelectorAll("input")];
}

async function enableDeclarative() {
  await click(q('button[role="switch"]'));
}

function connectButton() {
  // 组件用真实 i18n（locale=en），主按钮文案为 "Connect"。
  const button = qa("button").find((candidate) => candidate.textContent?.trim() === "Connect");
  expect(button, "连接按钮存在").toBeTruthy();
  return button!;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("TelnetConnectDialog", () => {
  it("submits base fields and no auto-login when everything is blank", async () => {
    const wrapper = await mountDialog();
    setInput(q("input.mono"), "bbs.example");
    await click(connectButton());
    const events = wrapper.emitted<TelnetConnectOptions[]>("connect");
    expect(events).toHaveLength(1);
    expect(events![0][0]).toEqual({ host: "bbs.example", port: 23, enterMode: "crlf", backspaceMode: "del" });
    expect(events![0][0].declarative).toBeUndefined();
    expect(events![0][0].rules).toBeUndefined();
  });

  it("passes Expect rules and secret slots through when declarative is off", async () => {
    const wrapper = await mountDialog();
    setInput(q("input.mono"), "bbs.example");
    const details = qa("details.telnet-auto-login")[1];
    setInput(details!.querySelector<HTMLTextAreaElement>("textarea"), "#!! ExpectPattern1 ogin:");
    const secrets = [
      ...details!.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ];
    setInput(secrets[0], "pw-one");
    setInput(secrets[1], "pw-two");
    await click(connectButton());
    const events = wrapper.emitted<TelnetConnectOptions[]>("connect");
    expect(events![0][0]).toMatchObject({
      rules: "#!! ExpectPattern1 ogin:",
      secret1: "pw-one",
      secret2: "pw-two",
    });
    expect(events![0][0].declarative).toBeUndefined();
  });

  it("packs declarative credentials and drops Expect rules when enabled", async () => {
    const wrapper = await mountDialog();
    setInput(q("input.mono"), "host.local");
    await enableDeclarative();
    const inputs = declInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(7);
    setInput(inputs[0], "dev");
    setInput(inputs[1], "s3cret");
    setInput(inputs[2], "ogin:");
    setInput(inputs[5], "incorrect");
    setInput(inputs[6], "2");
    // Expect 规则区仍填了内容：声明式启用时必须被忽略。
    const details = qa("details.telnet-auto-login")[1];
    setInput(details!.querySelector<HTMLTextAreaElement>("textarea"), "#!! ExpectPattern1 ogin:");
    await click(connectButton());
    const events = wrapper.emitted<TelnetConnectOptions[]>("connect");
    expect(events).toHaveLength(1);
    expect(events![0][0].declarative).toEqual({
      username: "dev",
      password: "s3cret",
      usernamePromptRegex: "ogin:",
      failureRegex: "incorrect",
      maxRetries: 2,
    });
    expect(events![0][0].rules).toBeUndefined();
    expect(events![0][0].secret1).toBeUndefined();
    expect(events![0][0].secret2).toBeUndefined();
  });

  it("omits blank regexes and clamps the retry budget", async () => {
    const wrapper = await mountDialog();
    setInput(q("input.mono"), "host.local");
    await enableDeclarative();
    const inputs = declInputs();
    setInput(inputs[0], "dev");
    setInput(inputs[6], "99");
    await click(connectButton());
    const payload = wrapper.emitted<TelnetConnectOptions[]>("connect")![0][0];
    // 空白正则不下发（sidecar 落内置默认提示词表）；重试钳到上限 10。
    expect(payload.declarative).toEqual({ username: "dev", maxRetries: 10 });
    expect(payload.declarative!.successRegex).toBeUndefined();
    expect(payload.declarative!.failureRegex).toBeUndefined();
  });

  it("blocks submit without credentials and shows the readable error", async () => {
    const wrapper = await mountDialog();
    setInput(q("input.mono"), "host.local");
    await enableDeclarative();
    await click(connectButton());
    expect(wrapper.emitted("connect")).toBeUndefined();
    expect(document.body.textContent).toContain("Fill in at least a username or a password");
    // 补上用户名后可正常提交。
    const inputs = declInputs();
    setInput(inputs[0], "dev");
    await click(connectButton());
    expect(wrapper.emitted<TelnetConnectOptions[]>("connect")).toHaveLength(1);
  });
});
