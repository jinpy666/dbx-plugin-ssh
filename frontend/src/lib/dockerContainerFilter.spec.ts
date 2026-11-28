import { describe, expect, it } from "vitest";
import {
  dockerQueryTokens,
  filterDockerContainers,
  searchDockerContainers,
  visibleDockerContainers,
  type DockerContainerFilterable,
} from "./dockerContainerFilter";

function row(overrides: Partial<DockerContainerFilterable> = {}): DockerContainerFilterable {
  return {
    id: "3f2a1b4c5d6e",
    name: "web-1",
    image: "nginx:1.27",
    state: "running",
    ports: "0.0.0.0:8080->80/tcp",
    ...overrides,
  };
}

const rows = [
  row(),
  row({ id: "9c8b7a6f5e4d", name: "db-1", image: "postgres:16", state: "exited", ports: "" }),
  row({ id: "112233aabbcc", name: "cache", image: "redis:7", state: "paused", ports: "6379/tcp" }),
];

describe("filterDockerContainers", () => {
  it("returns a copy for the all filter", () => {
    const out = filterDockerContainers(rows, "all");
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("keeps only running containers", () => {
    expect(filterDockerContainers(rows, "running").map((r) => r.name)).toEqual(["web-1"]);
  });

  it("treats every non-running state as stopped", () => {
    expect(filterDockerContainers(rows, "stopped").map((r) => r.name)).toEqual(["db-1", "cache"]);
  });

  it("accepts an empty list", () => {
    expect(filterDockerContainers([], "running")).toEqual([]);
  });
});

describe("dockerQueryTokens", () => {
  it("lowercases and splits on whitespace", () => {
    expect(dockerQueryTokens("  Web  RUNNING ")).toEqual(["web", "running"]);
    expect(dockerQueryTokens("")).toEqual([]);
  });
});

describe("searchDockerContainers", () => {
  it("returns a copy for an empty query", () => {
    const out = searchDockerContainers(rows, "   ");
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("matches name, image, state and ports case-insensitively", () => {
    expect(searchDockerContainers(rows, "WEB")).toHaveLength(1);
    expect(searchDockerContainers(rows, "postgres")).toHaveLength(1);
    expect(searchDockerContainers(rows, "paused").map((r) => r.name)).toEqual(["cache"]);
    expect(searchDockerContainers(rows, "8080")).toHaveLength(1);
  });

  it("requires every whitespace token to match", () => {
    expect(searchDockerContainers(rows, "db postgres")).toHaveLength(1);
    expect(searchDockerContainers(rows, "db nginx")).toEqual([]);
  });

  it("supports subsequence matching on identifier fields", () => {
    // 3f2a1b4c5d6e 的中间片段，子串匹配不成立，子序列成立。
    expect(searchDockerContainers(rows, "3a1b4")).toHaveLength(1);
    expect(searchDockerContainers(rows, "wb1").map((r) => r.name)).toEqual(["web-1"]);
  });

  it("returns nothing for an unmatched query", () => {
    expect(searchDockerContainers(rows, "nothing-here")).toEqual([]);
  });
});

describe("visibleDockerContainers", () => {
  it("applies the state filter before the search", () => {
    expect(visibleDockerContainers(rows, "stopped", "redis")).toHaveLength(1);
    expect(visibleDockerContainers(rows, "running", "redis")).toEqual([]);
  });
});
