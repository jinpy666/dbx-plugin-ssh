// @vitest-environment happy-dom
// DockerStatsBar 的趋势线只需验证「有足够采样才画三条线」，数值格式化由
// dockerStats.spec.ts 覆盖。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DockerStatsBar from "./DockerStatsBar.vue";
import type { DockerStatsPoint, DockerStatsSnapshot } from "../lib/dockerStats";

const t = (key: string) => key;

const snapshot: DockerStatsSnapshot = {
  available: true,
  needsSudo: false,
  sampledAt: 2_000,
  stats: [
    {
      containerId: "c1",
      name: "web",
      cpuPercent: 12,
      memBytes: 512,
      memLimitBytes: 1024,
      memPercent: 50,
      netRxBytes: 100,
      netTxBytes: 20,
      netRxRate: 100,
      netTxRate: 20,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      pids: 3,
    },
  ],
};

const history: DockerStatsPoint[] = [
  { at: 1_000, cpuPercent: 5, memPercent: 40, netBytesPerSec: 50 },
  { at: 2_000, cpuPercent: 12, memPercent: 50, netBytesPerSec: 120 },
];

function mountBar(points?: DockerStatsPoint[]) {
  return mount(DockerStatsBar, { props: { t, snapshot, history: points } });
}

describe("DockerStatsBar trends", () => {
  it("hides the sparklines until two samples exist", () => {
    expect(mountBar().findAll(".docker-stats-spark")).toHaveLength(0);
    expect(mountBar(history.slice(0, 1)).findAll(".docker-stats-spark")).toHaveLength(0);
  });

  it("renders one polyline per metric once there are two samples", () => {
    const wrapper = mountBar(history);
    const sparks = wrapper.findAll(".docker-stats-spark");
    expect(sparks).toHaveLength(3);
    for (const spark of sparks) {
      expect(spark.attributes("aria-hidden")).toBe("true");
      expect(spark.find("polyline").attributes("points")).toMatch(/^\d+,\d+ \d+,\d+$/);
    }
    expect(wrapper.find('[data-test="docker-stats-spark-cpu"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="docker-stats-spark-mem"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="docker-stats-spark-net"]').exists()).toBe(true);
  });

  it("keeps the textual values alongside the trend", () => {
    const wrapper = mountBar(history);
    expect(wrapper.text()).toContain("CPU 12.0%");
    expect(wrapper.text()).toContain("PIDs 3");
  });

  it("shows the error hint without drawing trends", () => {
    const wrapper = mount(DockerStatsBar, {
      props: { t, snapshot, history, error: "docker daemon down" },
    });
    expect(wrapper.text()).toContain("docker.statsUnavailable");
    expect(wrapper.findAll(".docker-stats-spark")).toHaveLength(0);
  });
});
