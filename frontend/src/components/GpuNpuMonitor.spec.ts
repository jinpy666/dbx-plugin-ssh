// @vitest-environment happy-dom
// GpuNpuMonitor 测试：三态（正常卡片区 / available=false 弱化提示 / 键缺省
// 整区隐藏）+ HBM 文案切换 + 进程按 uuid 关联后的渲染。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import GpuNpuMonitor from "./GpuNpuMonitor.vue";
import type { GpuOverviewView, NpuOverviewView } from "../lib/metricsGpuNpu";

const GPU_FIXTURE: GpuOverviewView = {
  available: true,
  gpus: [
    {
      index: 0,
      uuid: "GPU-5a1b",
      name: "NVIDIA GeForce RTX 3090, 24GB",
      driver: "535.129.03",
      temperature: 45,
      utilization: 12,
      memUtil: 30,
      totalMem: 24_576 * 1024 * 1024,
      usedMem: 8_192 * 1024 * 1024,
      freeMem: 16_384 * 1024 * 1024,
      powerDraw: 65.02,
      powerLimit: 350,
      fan: 60,
      pstate: "P2",
      processes: [
        { uuid: "GPU-5a1b", pid: 4321, mem: 4_096 * 1024 * 1024, name: "python3" },
      ],
    },
  ],
};

const NPU_FIXTURE: NpuOverviewView = {
  available: true,
  cann: "8.0.RC1",
  devices: [
    {
      deviceKey: "ascend:0:0",
      npuIndex: 0,
      chipId: 0,
      name: "910B4",
      health: "OK",
      power: 63.6,
      temperature: 42,
      aicore: 12,
      memoryLabel: "hbm",
      usedMem: 8_192 * 1024 * 1024,
      totalMem: 32_509 * 1024 * 1024,
      processes: [
        { pid: 123456, name: "python3", npuIndex: 0, mem: 4_096 * 1024 * 1024 },
      ],
    },
    {
      deviceKey: "ascend:0:1",
      npuIndex: 0,
      chipId: 1,
      name: "910B4",
      health: "Warning",
      power: 63.6,
      temperature: 42,
      aicore: 0,
      memoryLabel: "hbm",
      usedMem: 0,
      totalMem: 32_509 * 1024 * 1024,
      processes: [],
    },
  ],
};

describe("GpuNpuMonitor", () => {
  it("hides the whole section when the sidecar reports neither key", () => {
    const wrapper = mount(GpuNpuMonitor, { props: { locale: "en" } });
    expect(wrapper.find(".gpu-npu-section").exists()).toBe(false);
  });

  it("renders one card per GPU with memory bar and attached processes", () => {
    const wrapper = mount(GpuNpuMonitor, { props: { locale: "en", gpu: GPU_FIXTURE } });
    expect(wrapper.findAll(".gpu-npu-card")).toHaveLength(1);
    // 引号里带逗号的卡名原样展示。
    expect(wrapper.find(".gpu-npu-card-name").text()).toBe("NVIDIA GeForce RTX 3090, 24GB");
    expect(wrapper.find(".gpu-npu-badge").text()).toBe("P2");
    const bar = wrapper.find(".dbx-progress");
    expect(Number(bar.attributes("aria-valuenow"))).toBeCloseTo(33.33, 1);
    expect(bar.attributes("data-tone")).toBe("info");
    const rows = wrapper.findAll(".gpu-npu-process-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("4321");
    expect(rows[0].text()).toContain("python3");
  });

  it("warns above 85 percent memory usage", () => {
    const hot = { ...GPU_FIXTURE, gpus: [{ ...GPU_FIXTURE.gpus[0], usedMem: 22_000 * 1024 * 1024, processes: [] }] };
    const wrapper = mount(GpuNpuMonitor, { props: { locale: "en", gpu: hot } });
    expect(wrapper.find(".dbx-progress").attributes("data-tone")).toBe("danger");
    // 无进程时落到空态文案。
    expect(wrapper.text()).toContain("No compute processes");
  });

  it("shows muted unavailable text instead of cards when no GPU exists", () => {
    const wrapper = mount(GpuNpuMonitor, {
      props: { locale: "en", gpu: { available: false, gpus: [] } },
    });
    expect(wrapper.findAll(".gpu-npu-card")).toHaveLength(0);
    expect(wrapper.find(".gpu-npu-unavailable").text()).toBe("No NVIDIA GPU detected");
  });

  it("labels NPU memory as HBM and shows the CANN version plus health badges", () => {
    const wrapper = mount(GpuNpuMonitor, {
      props: { locale: "en", gpu: { available: false, gpus: [] }, npu: NPU_FIXTURE },
    });
    expect(wrapper.findAll(".gpu-npu-card")).toHaveLength(2);
    expect(wrapper.text()).toContain("CANN 8.0.RC1");
    const bars = wrapper.findAll(".dbx-progress");
    expect(bars).toHaveLength(2);
    // HBM 列存在时第二张卡的内存行走 HBM 文案。
    const npuSection = wrapper.findAll(".gpu-npu-card")[1];
    expect(npuSection.text()).toContain("HBM");
    // 非 OK 健康态展示警示徽标。
    expect(npuSection.find(".gpu-npu-badge-warn").text()).toBe("Warning");
  });

  it("localizes the muted copy in zh-CN", () => {
    const wrapper = mount(GpuNpuMonitor, {
      props: { locale: "zh-CN", gpu: { available: false, gpus: [] } },
    });
    expect(wrapper.find(".gpu-npu-unavailable").text()).toBe("未检测到 NVIDIA GPU");
  });
});
