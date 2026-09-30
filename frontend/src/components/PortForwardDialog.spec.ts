// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import PortForwardDialog from "./PortForwardDialog.vue";

const { loadProfiles } = vi.hoisted(() => ({ loadProfiles: vi.fn((): unknown[] => []) }));
vi.mock("../lib/tunnelProfiles", () => ({ loadTunnelProfiles: loadProfiles, saveTunnelProfile: vi.fn(), deleteTunnelProfile: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); loadProfiles.mockReturnValue([]); });

describe("independent tunnel manager", () => {
  it("shows a tunnel started from the connection menu while the manager is open", async () => {
    const running = { id: "menu-1", connectionId: "c-1", sessionId: "", kind: "dynamic", listenHost: "127.0.0.1", listenPort: 1080, boundPort: 1080, targetHost: "", targetPort: 0, state: "active" };
    let visible = false;
    let onEvent: ((event: DbxPluginEvent) => void) | undefined;
    const invoke = vi.fn(async (method: string) => method === "ssh/forward/list" ? { forwards: visible ? [running] : [] } : { interfaces: [] });
    vi.stubGlobal("dbxPlugin", { invoke, onEvent: (callback: typeof onEvent) => { onEvent = callback; return () => undefined; } });
    const wrapper = mount(PortForwardDialog, { props: { locale: "en", open: true, connectionId: "c-1", sessionId: null, independent: true, standalone: true } });
    await flushPromises();
    expect(wrapper.findAll(".forwards-body > .forwards-list .forward-row")).toHaveLength(0);

    visible = true;
    onEvent?.({ method: "ssh/forward/state", params: { id: "menu-1", connectionId: "other", state: "active" } } as DbxPluginEvent);
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2); // initial list and interface probe only
    onEvent?.({ method: "ssh/forward/state", params: { id: "menu-1", connectionId: "c-1", state: "active" } } as DbxPluginEvent);
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("ssh/forward/list", { connectionId: "c-1" });
    expect(wrapper.findAll(".forwards-body > .forwards-list .forward-row")).toHaveLength(1);
    expect(wrapper.text()).toContain("127.0.0.1:1080");
    wrapper.unmount();
  });

  it("does not let an older list response erase a tunnel announced by the menu", async () => {
    const running = { id: "menu-2", connectionId: "c-1", sessionId: "", kind: "local", listenHost: "127.0.0.1", listenPort: 8080, boundPort: 8080, targetHost: "example.com", targetPort: 80, state: "active" };
    let finishInitialList!: (value: unknown) => void;
    let onEvent: ((event: DbxPluginEvent) => void) | undefined;
    const invoke = vi.fn((method: string) => method === "ssh/forward/list"
      ? invoke.mock.calls.filter(([name]) => name === "ssh/forward/list").length === 1
        ? new Promise((resolve) => { finishInitialList = resolve; })
        : Promise.resolve({ forwards: [running] })
      : Promise.resolve({ interfaces: [] }));
    vi.stubGlobal("dbxPlugin", { invoke, onEvent: (callback: typeof onEvent) => { onEvent = callback; return () => undefined; } });
    const wrapper = mount(PortForwardDialog, { props: { locale: "en", open: true, connectionId: "c-1", sessionId: null, independent: true, standalone: true } });
    await flushPromises();
    onEvent?.({ method: "ssh/forward/state", params: { id: "menu-2", connectionId: "c-1", state: "active" } } as DbxPluginEvent);
    await flushPromises();
    finishInitialList({ forwards: [] });
    await flushPromises();
    expect(wrapper.findAll(".forwards-body > .forwards-list .forward-row")).toHaveLength(1);
    expect(wrapper.text()).toContain("example.com:80");
    wrapper.unmount();
  });

  it("renders in the workbench without a modal overlay and keeps the saved controls", async () => {
    vi.stubGlobal("dbxPlugin", {
      invoke: vi.fn(async (method: string) => method === "ssh/forward/list" ? { forwards: [] } : { interfaces: [] }),
      onEvent: () => () => undefined,
    });
    const wrapper = mount(PortForwardDialog, { props: { locale: "en", open: true, connectionId: "c-1", sessionId: null, independent: true, standalone: true } });
    await flushPromises();
    expect(wrapper.find("section.forwards-modal--standalone").exists()).toBe(true);
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(wrapper.text()).toContain("Start all saved");
    expect(wrapper.text()).toContain("Save preset");
    wrapper.unmount();
  });

  it("uses the same saved and active mapping manager in the SSH toolbar dialog", async () => {
    vi.stubGlobal("dbxPlugin", {
      invoke: vi.fn(async (method: string) => method === "ssh/forward/list" ? { forwards: [] } : { interfaces: [] }),
      onEvent: () => () => undefined,
    });
    const wrapper = mount(PortForwardDialog, { props: { locale: "en", open: true, connectionId: "c-1", sessionId: null, independent: true } });
    await flushPromises();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Saved port forwards");
    expect(document.body.textContent).toContain("Active port forwards");
    expect(document.body.textContent).toContain("Save preset");
    wrapper.unmount();
  });

  it("stops an already active saved tunnel from the same profile row", async () => {
    loadProfiles.mockReturnValue([{ id: "saved-1", connectionId: "c-1", kind: "dynamic", listenHost: "127.0.0.1", listenPort: "1080", targetHost: "", targetPort: "" }]);
    const invoke = vi.fn(async (method: string) => method === "ssh/forward/list" ? { forwards: [{ id: "live-1", connectionId: "c-1", sessionId: "", kind: "dynamic", listenHost: "127.0.0.1", listenPort: 1080, boundPort: 1080, targetHost: "", targetPort: 0, state: "active" }] } : { success: true });
    vi.stubGlobal("dbxPlugin", { invoke, onEvent: () => () => undefined });
    const wrapper = mount(PortForwardDialog, { props: { locale: "en", open: true, connectionId: "c-1", sessionId: null, independent: true, standalone: true } });
    await flushPromises();
    const profileRow = wrapper.find(".forward-profiles .forward-row");
    expect(profileRow.text()).toContain("Stop");
    await profileRow.find("button.primary-button").trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("ssh/forward/stop", { id: "live-1" });
    wrapper.unmount();
  });
});
