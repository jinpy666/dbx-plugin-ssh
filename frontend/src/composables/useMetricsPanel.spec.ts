// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";
import { useMetricsPanel } from "./useMetricsPanel";

afterEach(() => {
  vi.useRealTimers();
});

describe("useMetricsPanel refresh controls", () => {
  it("pauses, resumes, changes interval and stops polling on close", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async (method: string) => method === "ssh/metrics/history" ? { samples: [] } : { cpu: { percent: 10 } });
    (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { invoke };
    let panel!: ReturnType<typeof useMetricsPanel>;
    const wrapper = mount(defineComponent({
      setup() {
        panel = useMetricsPanel({
          t: (key) => key,
          showNotice: vi.fn(),
          showError: vi.fn(),
          session: ref({ sessionId: "s-1" }),
          transferPanelOpen: ref(false),
          recordingsOpen: ref(false),
        });
        return () => null;
      },
    }));
    const metricCalls = () => invoke.mock.calls.filter(([method]) => method === "ssh/metrics").length;

    panel.toggleMetrics();
    await Promise.resolve();
    await Promise.resolve();
    expect(metricCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(metricCalls()).toBe(2);

    panel.setMetricsRefreshMs(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(metricCalls()).toBe(3);

    panel.toggleMetricsLive();
    expect(panel.metricsLive.value).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(metricCalls()).toBe(3);

    panel.toggleMetricsLive();
    await Promise.resolve();
    expect(panel.metricsLive.value).toBe(true);
    expect(metricCalls()).toBe(4);

    panel.closeMetrics();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(metricCalls()).toBe(4);
    wrapper.unmount();
  });

  it("subtracts collection time instead of skipping the next one-second tick", async () => {
    vi.useFakeTimers();
    let resolveMetrics!: (value: { cpu: { percent: number } }) => void;
    const invoke = vi.fn((method: string) => method === "ssh/metrics/history"
      ? Promise.resolve({ samples: [] })
      : new Promise<{ cpu: { percent: number } }>((resolve) => { resolveMetrics = resolve; }));
    (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { invoke };
    let panel!: ReturnType<typeof useMetricsPanel>;
    const wrapper = mount(defineComponent({
      setup() {
        panel = useMetricsPanel({
          t: (key) => key,
          showNotice: vi.fn(),
          showError: vi.fn(),
          session: ref({ sessionId: "s-1" }),
          transferPanelOpen: ref(false),
          recordingsOpen: ref(false),
        });
        return () => null;
      },
    }));
    const metricCalls = () => invoke.mock.calls.filter(([method]) => method === "ssh/metrics").length;

    panel.toggleMetrics();
    panel.setMetricsRefreshMs(1000);
    expect(metricCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    resolveMetrics({ cpu: { percent: 10 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(metricCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(599);
    expect(metricCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(metricCalls()).toBe(2);
    panel.closeMetrics();
    wrapper.unmount();
  });

  it("uses the same visible interfaces for network rate samples", () => {
    (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { invoke: vi.fn() };
    let panel!: ReturnType<typeof useMetricsPanel>;
    const wrapper = mount(defineComponent({
      setup() {
        panel = useMetricsPanel({
          t: (key) => key,
          showNotice: vi.fn(),
          showError: vi.fn(),
          session: ref({ sessionId: "s-1" }),
          transferPanelOpen: ref(false),
          recordingsOpen: ref(false),
        });
        return () => null;
      },
    }));
    panel.metrics.value = { network: [
      { name: "eth0", rxRate: 100, txRate: 50, rxTotal: 0, txTotal: 0 },
      { name: "docker0", rxRate: 0, txRate: 0, rxTotal: 0, txTotal: 0 },
      { name: "veth-busy", rxRate: 25, txRate: 25, rxTotal: 0, txTotal: 0 },
    ] };
    panel.recordMetricSamples();
    expect(panel.metricSamples.rx.at(-1)).toBe(125);
    expect(panel.metricSamples.tx.at(-1)).toBe(75);
    wrapper.unmount();
  });
});
