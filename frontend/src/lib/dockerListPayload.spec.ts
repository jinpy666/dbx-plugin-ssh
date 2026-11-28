import { describe, expect, it } from "vitest";
import { dockerListPayload } from "./dockerListPayload";

describe("dockerListPayload normalization", () => {
  it("keeps well-formed rows and coerces non-string fields to empty", () => {
    const payload = dockerListPayload({
      available: true,
      needsSudo: false,
      containers: [
        { id: "31b4", name: "web", image: "nginx", state: "running", status: "Up", ports: "80/tcp", createdAt: "2026-01-01" },
        { id: 42, name: "bad" },
        null,
        "junk",
      ],
    });
    expect(payload.available).toBe(true);
    expect(payload.needsSudo).toBe(false);
    expect(payload.containers).toHaveLength(1);
    expect(payload.containers[0]).toEqual({ id: "31b4", name: "web", image: "nginx", state: "running", status: "Up", ports: "80/tcp", createdAt: "2026-01-01" });
  });

  it("drops rows without an id and treats null payloads as unavailable", () => {
    const payload = dockerListPayload({ containers: [{ id: "a" }, { name: "no-id" }] });
    expect(payload.containers.map((row) => row.id)).toEqual(["a"]);
    expect(payload.available).toBe(false);
    expect(payload.needsSudo).toBe(false);
    expect(dockerListPayload(null).available).toBe(false);
    expect(dockerListPayload(null).containers).toEqual([]);
  });

  it("treats a missing containers array as empty", () => {
    expect(dockerListPayload({ available: true }).containers).toEqual([]);
    expect(dockerListPayload({ containers: "nope" }).containers).toEqual([]);
  });
});
