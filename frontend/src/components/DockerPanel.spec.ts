// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import DockerPanel from "./DockerPanel.vue";
import { DOCKER_ENGINE_STORE_KEY } from "../lib/dockerEngine";
import { pluginStore } from "../lib/pluginStore";

afterEach(() => {
  pluginStore.removeItem(DOCKER_ENGINE_STORE_KEY);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function openPanel(containers: Array<Record<string, unknown>> = []) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  vi.stubGlobal("dbxPlugin", {
    invoke: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "ssh/sessions/list") {
        return { sessions: [{ sessionId: "test-session", connectionId: "test-connection", connected: true }] };
      }
      if (method === "docker/list") return { available: true, containers };
      throw new Error(`Unexpected host call: ${method}`);
    },
    onEvent: () => () => undefined,
    onBinary: () => () => undefined,
  });
  const WorkbenchStub = {
    name: "DockerWorkbench",
    props: ["open", "t", "target", "params", "initialTab"],
    template: `<div class="workbench-stub" :data-open="String(open)" :data-tab="initialTab" :data-target="target?.id ?? ''"></div>`,
  };
  const wrapper = mount(DockerPanel, {
    attachTo: document.body,
    props: { t: (key: string) => key },
    global: { stubs: { DockerWorkbench: WorkbenchStub } },
  });
  await flushPromises();
  return { wrapper, calls };
}

async function clickMenuAction(wrapper: Awaited<ReturnType<typeof openPanel>>["wrapper"], key: string) {
  await wrapper.get(".docker-row-trigger").trigger("click");
  await flushPromises();
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".docker-row-menu-item"))
    .find((item) => item.textContent?.includes(key));
  expect(button, `menu item ${key} must exist`).toBeDefined();
  button!.click();
  await flushPromises();
}

describe("Docker workbench tabs", () => {
  it("opens the terminal tab from the row menu without a window event", async () => {
    const listener = vi.fn();
    window.addEventListener("dbx:docker-open-in-terminal", listener);
    const { wrapper } = await openPanel([{ id: "abc123", name: "test", state: "running" }]);
    try {
      await clickMenuAction(wrapper, "docker.actionTerminal");
      const stub = wrapper.get(".workbench-stub");
      expect(stub.attributes("data-open")).toBe("true");
      expect(stub.attributes("data-tab")).toBe("terminal");
      expect(stub.attributes("data-target")).toBe("abc123");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("dbx:docker-open-in-terminal", listener);
      wrapper.unmount();
    }
  });

  it("opens the files tab from the row menu", async () => {
    const { wrapper } = await openPanel([{ id: "abc123", name: "test", state: "running" }]);
    try {
      await clickMenuAction(wrapper, "docker.actionFiles");
      const stub = wrapper.get(".workbench-stub");
      expect(stub.attributes("data-open")).toBe("true");
      expect(stub.attributes("data-tab")).toBe("files");
    } finally {
      wrapper.unmount();
    }
  });
});

describe("Docker workbench target", () => {
  it("uses local Docker even when another SSH session is connected", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.stubGlobal("dbxPlugin", {
      invoke: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "ssh/sessions/list") {
          return { sessions: [{ sessionId: "other-ssh", connectionId: "other-connection", connected: true }] };
        }
        if (method === "docker/list") return { available: true, containers: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      onEvent: () => () => undefined,
    });
    const wrapper = mount(DockerPanel, {
      attachTo: document.body,
      props: {
        t: (key: string) => key,
        targetMode: "local",
        sessionId: "stale-ssh-session",
        connectionId: "stale-ssh-connection",
      },
    });

    await flushPromises();

    expect(calls.filter((call) => call.method === "ssh/sessions/list")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "docker/list").map((call) => call.params)).toEqual([
      { target: "local" },
    ]);
    wrapper.unmount();
  });

  it("refreshes against the new target when the workbench switches modes", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.stubGlobal("dbxPlugin", {
      invoke: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "ssh/sessions/list") return { sessions: [] };
        if (method === "docker/list") return { available: true, containers: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      onEvent: () => () => undefined,
    });
    const wrapper = mount(DockerPanel, {
      attachTo: document.body,
      props: {
        t: (key: string) => key,
        targetMode: "ssh",
        sessionId: "ssh-session",
        connectionId: "ssh-connection",
      },
    });

    await flushPromises();
    await wrapper.setProps({ targetMode: "local", sessionId: "", connectionId: "" });
    await flushPromises();
    await wrapper.setProps({ targetMode: "ssh", sessionId: "next-ssh-session", connectionId: "next-ssh-connection" });
    await flushPromises();

    expect(calls.filter((call) => call.method === "docker/list").map((call) => call.params)).toEqual([
      { sessionId: "ssh-session" },
      { target: "local" },
      { sessionId: "next-ssh-session" },
    ]);
    wrapper.unmount();
  });
});
