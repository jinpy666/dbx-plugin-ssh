import { describe, expect, it } from "vitest";
import { rdpExperimentalEnabled } from "./rdpExperimental";

describe("RDP experimental gate", () => {
  it("is disabled unless the persisted preference is exactly true", () => {
    for (const value of [undefined, null, false, "true", 1, {}, []]) {
      expect(rdpExperimentalEnabled(value)).toBe(false);
    }
    expect(rdpExperimentalEnabled(true)).toBe(true);
  });
});
