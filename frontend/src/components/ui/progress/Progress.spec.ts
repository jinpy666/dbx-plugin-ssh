// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { Progress } from ".";

describe("Progress", () => {
  it("renders the real ratio and tone", () => {
    const wrapper = mount(Progress, { props: { value: 72, tone: "warning" } });
    expect(wrapper.attributes("aria-valuenow")).toBe("72");
    expect(wrapper.attributes("data-tone")).toBe("warning");
    expect(wrapper.find(".dbx-progress-indicator").attributes("style")).toContain("width: 72%");
  });

  it("clamps values and rejects invalid ratios", () => {
    const wrapper = mount(Progress, { props: { value: 140 } });
    expect(wrapper.find(".dbx-progress-indicator").attributes("style")).toContain("width: 100%");
    const invalid = mount(Progress, { props: { value: Number.NaN } });
    expect(invalid.find(".dbx-progress-indicator").attributes("style")).toContain("width: 0%");
  });
});
