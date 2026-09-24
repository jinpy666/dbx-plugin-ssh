import { describe, expect, it } from "vitest";
import { loadLastConnectParams, persistLastConnectParams } from "./connectLastParams";
import { pluginStore } from "./pluginStore";

describe("connectLastParams", () => {
  it("round-trips primitive params through the plugin store", () => {
    persistLastConnectParams("test-connect-last", { host: "edge.example", port: 23, keep: true });
    expect(loadLastConnectParams("test-connect-last")).toEqual({ host: "edge.example", port: 23, keep: true });
  });

  it("filters non-primitive values on load", () => {
    persistLastConnectParams("test-connect-last", { host: "h", nested: { a: 1 }, list: [1, 2] });
    expect(loadLastConnectParams("test-connect-last")).toEqual({ host: "h" });
  });

  it("returns an empty object on corrupt payloads", () => {
    pluginStore.setItem("test-connect-last", "not-json{");
    expect(loadLastConnectParams("test-connect-last")).toEqual({});
  });

  it("returns an empty object on array payloads", () => {
    pluginStore.setItem("test-connect-last", JSON.stringify(["host"]));
    expect(loadLastConnectParams("test-connect-last")).toEqual({});
  });

  it("returns an empty object for unknown keys", () => {
    expect(loadLastConnectParams("never-written-key")).toEqual({});
  });
});
