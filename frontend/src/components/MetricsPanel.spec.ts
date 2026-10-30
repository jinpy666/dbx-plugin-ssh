// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import MetricsPanel from "./MetricsPanel.vue";
import type { ServerMetrics } from "../composables/useMetricsPanel";

const metrics: ServerMetrics = {
  hostname: "web-01.demo.internal",
  uptimeSeconds: 90061,
  cpu: { cores: 8, percent: 23.4, corePercents: [14, 23, 18, 11, 8, 15, 12, 9], load1: 0.42 },
  memory: { totalBytes: 100, availableBytes: 50, usedBytes: 50 },
  disks: [{ filesystem: "/dev/sda", mount: "/data", totalBytes: 100, usedBytes: 87, availableBytes: 13, percentUsed: 87 }],
  network: [{ name: "eth0", rxRate: 1024, txRate: 512, rxTotal: 2048, txTotal: 1024 }],
};

const processRow = { pid: 812, ppid: 1, user: "www-data", cpuPercent: 12.6, memPercent: 3.1, etime: "01:23", state: "S", command: "nginx: worker process", fdCount: 64, listenPorts: [80, 443] };
const otherRow = { ...processRow, pid: 1042, user: "demo", command: "htop", listenPorts: [] };

function mountPanel(overrides: Record<string, unknown> = {}) {
  const wrapper = mount(MetricsPanel, {
    props: {
      locale: "en",
      modelValue: "overview",
      metrics,
      loading: false,
      error: "",
      live: true,
      refreshMs: 5000,
      samples: { rx: [512, 1024], tx: [256, 512], cpu: [10, 23.4], mem: [40, 50] },
      cpuSparkline: "0,18 120,4",
      memSparkline: "0,18 120,8",
      rxSparkline: "0,18 60,2",
      disks: metrics.disks!,
      networks: metrics.network!,
      processesOpen: true,
      processCount: 2,
      totalSortedCount: 2,
      processLoading: false,
      processSortKey: "cpu",
      visibleProcessRows: [processRow, otherRow],
      processCap: 100,
      ...overrides,
    },
    "onUpdate:modelValue": (value: "overview" | "processes" | "disks" | "network" | "docker") => void wrapper.setProps({ modelValue: value }),
  });
  return wrapper;
}

describe("MetricsPanel", () => {
  it("renders real summary data and switches detail tabs", async () => {
    const wrapper = mountPanel();
    expect(wrapper.findAll(".metric-summary-card")).toHaveLength(4);
    expect(wrapper.text()).toContain("web-01.demo.internal");
    expect(wrapper.text()).toContain("23%");
    expect(wrapper.text()).toContain("50%");
    expect(wrapper.text()).toContain("87%");
    expect(wrapper.text()).toContain("1.0 KiB/s");
    expect(wrapper.find(".metrics-overview-disks").text()).toContain("/data");
    expect(wrapper.findAll(".metrics-core-item")).toHaveLength(8);
    expect(wrapper.find(".metrics-core-grid").text()).toContain("23.0%");
    expect(wrapper.find(".metric-memory .metric-area").exists()).toBe(false);
    expect(wrapper.find(".metric-memory-available").text()).toContain("Available");

    await wrapper.findAll(".metrics-tabs button")[2].trigger("mousedown", { button: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".metrics-detail-page").text()).toContain("/data");
    expect(wrapper.find(".dbx-progress").attributes("data-tone")).toBe("danger");

    await wrapper.findAll(".metrics-tabs button")[3].trigger("mousedown", { button: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".metrics-detail-page").text()).toContain("eth0");
    expect(wrapper.find(".metrics-detail-page").text()).toContain("RX 2.0 KiB");
    expect(wrapper.find(".metrics-detail-page .dbx-progress").exists()).toBe(false);
  });

  it("emits real refresh controls", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".metrics-header-actions .icon-button").trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("toggleLive")).toHaveLength(1);

    await wrapper.find(".metrics-interval").trigger("pointerdown", { button: 0, pointerType: "mouse", pageX: 0, pageY: 0 });
    await wrapper.vm.$nextTick();
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((entry) => entry.textContent?.trim() === "1s");
    expect(option).toBeDefined();
    option!.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerType: "mouse" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setRefreshMs")).toEqual([[1000]]);

    await wrapper.find(".metrics-header-actions .icon-button:last-child").trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("filters processes and preserves sort and kill actions", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".metrics-tabs button")[1].trigger("mousedown", { button: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".process-row")).toHaveLength(2);

    await wrapper.find(".metrics-search input").setValue("nginx");
    expect(wrapper.findAll(".process-row")).toHaveLength(1);
    expect(wrapper.find(".process-row").text()).toContain("nginx: worker process");

    await wrapper.find(".proc-sort-select").trigger("pointerdown", { button: 0, pointerType: "mouse", pageX: 0, pageY: 0 });
    await wrapper.vm.$nextTick();
    const pidOption = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((entry) => entry.textContent?.trim() === "PID");
    expect(pidOption).toBeDefined();
    pidOption!.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerType: "mouse" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setProcessSort")).toEqual([["pid"]]);
    await wrapper.find(".proc-kill-group .link-button").trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("kill")?.[0]).toEqual([processRow, 15]);
  });

  it("requests process loading once and hides unavailable accelerator sections", async () => {
    const wrapper = mountPanel({ processesOpen: false });
    expect(wrapper.find(".gpu-npu-section").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Ping");
    await wrapper.findAll(".metrics-tabs button")[1].trigger("mousedown", { button: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("toggleProcesses")).toHaveLength(1);
  });

  it("exposes Docker as a sibling module", async () => {
    const wrapper = mountPanel();
    expect(wrapper.findAll(".metrics-tabs button")).toHaveLength(5);
    await wrapper.findAll(".metrics-tabs button")[4].trigger("mousedown", { button: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["docker"]);
    expect(wrapper.find(".metrics-docker-page").exists()).toBe(true);
  });
});
