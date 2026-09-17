import { describe, expect, it } from "vitest";
import { bridgeBinaryBytes } from "../../../shared/frontend/binaryEvent";

const decodeBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

describe("bridgeBinaryBytes", () => {
  it("prefers the zero-copy bytes delivered by the current host bridge", () => {
    const data = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1, 104, 105]);
    expect(
      Array.from(bridgeBinaryBytes({ channel: "ssh/terminal/out/s-1", data }, decodeBase64)),
    ).toEqual(Array.from(data));
  });

  it("falls back to base64 for the legacy host bridge", () => {
    expect(
      Array.from(bridgeBinaryBytes({ channel: "ssh/terminal/out/s-1", dataBase64: btoa("hello") }, decodeBase64)),
    ).toEqual(Array.from(new TextEncoder().encode("hello")));
  });

  it("yields empty bytes when neither shape carries a payload", () => {
    expect(bridgeBinaryBytes({ channel: "ssh/terminal/out/s-1" }, decodeBase64).byteLength).toBe(0);
  });
});
