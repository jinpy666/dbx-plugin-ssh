import { describe, expect, it } from "vitest";
import {
  applyForwardState,
  findForwardConflict,
  formatForwardBytes,
  formatForwardRoute,
  forwardStartParams,
  parseForwards,
  parseInterfaces,
  listenHostOptions,
  validateForwardForm,
  type ForwardFormDraft,
  type PortForward,
} from "./portForward";

const row = (overrides: Partial<PortForward>): PortForward => ({
  id: "fwd-1",
  sessionId: "s-1",
  connectionId: "conn-1",
  kind: "local",
  listenHost: "127.0.0.1",
  listenPort: 8080,
  boundPort: 8080,
  targetHost: "db.internal",
  targetPort: 5432,
  state: "active",
  connectionsTotal: 3,
  connectionsActive: 1,
  bytesUp: 100,
  bytesDown: 200,
  ...overrides,
});

describe("parseForwards", () => {
  it("parses a list payload and drops invalid rows", () => {
    const forwards = parseForwards({
      forwards: [
        row({}),
        { id: "" },
        null,
        row({ id: "fwd-2", kind: "remote", boundPort: 31234, listenPort: 0, state: "active" }),
      ],
    });
    expect(forwards.map((f) => f.id)).toEqual(["fwd-1", "fwd-2"]);
    expect(forwards[1]).toMatchObject({ kind: "remote", listenPort: 0, boundPort: 31234 });
  });

  it("parses a single start payload and defaults listen host", () => {
    const forwards = parseForwards({ forward: row({ listenHost: "" }) });
    expect(forwards).toHaveLength(1);
    expect(forwards[0].listenHost).toBe("127.0.0.1");
  });

  it("returns an empty list for junk payloads", () => {
    expect(parseForwards(null)).toEqual([]);
    expect(parseForwards({ junk: true })).toEqual([]);
  });
});

describe("applyForwardState", () => {
  it("updates the matching row state and error in place", () => {
    const next = applyForwardState([row({}), row({ id: "fwd-2" })], {
      id: "fwd-1",
      state: "error",
      error: "Server refused",
    });
    expect(next[0].state).toBe("error");
    expect(next[0].error).toBe("Server refused");
    expect(next[1].state).toBe("active");
  });

  it("ignores events without a usable id", () => {
    const rows = [row({})];
    expect(applyForwardState(rows, { state: "stopped" })).toBe(rows);
  });
});

describe("validateForwardForm", () => {
  const draft = (overrides: Partial<ForwardFormDraft>): ForwardFormDraft => ({
    kind: "local",
    listenHost: "127.0.0.1",
    listenPort: "8080",
    targetHost: "db.internal",
    targetPort: "5432",
    ...overrides,
  });

  it("accepts complete forms, loopback default and server-picked ports", () => {
    expect(validateForwardForm(draft({}))).toBeNull();
    expect(validateForwardForm(draft({ listenHost: "", listenPort: "0", targetPort: "65535" }))).toBeNull();
    expect(validateForwardForm(draft({ kind: "dynamic", targetHost: "", targetPort: "" }))).toBeNull();
  });

  it("accepts IPv4, IPv6 (bracketed) and hostname targets", () => {
    expect(validateForwardForm(draft({ targetHost: "192.168.1.10" }))).toBeNull();
    expect(validateForwardForm(draft({ targetHost: "[FE80::1]" }))).toBeNull();
    expect(validateForwardForm(draft({ targetHost: "::1" }))).toBeNull();
    expect(validateForwardForm(draft({ listenHost: "10.0.0.5:8080" }))).toBe("listenHost");
    expect(validateForwardForm(draft({ targetHost: "http://db" }))).toBe("targetHost");
    expect(validateForwardForm(draft({ targetHost: "999.1.1.1" }))).toBe("targetHost");
    expect(validateForwardForm(draft({ targetHost: "bad host" }))).toBe("targetHost");
  });

  it("allows the wildcard listen host only for remote mappings", () => {
    expect(validateForwardForm(draft({ kind: "remote", listenHost: "*" }))).toBeNull();
    expect(validateForwardForm(draft({ kind: "local", listenHost: "*" }))).toBe("listenHost");
  });

  it("rejects a missing target host and bad ports", () => {
    expect(validateForwardForm(draft({ targetHost: "  " }))).toBe("targetHost");
    expect(validateForwardForm(draft({ listenPort: "" }))).toBe("port");
    expect(validateForwardForm(draft({ listenPort: "abc" }))).toBe("port");
    expect(validateForwardForm(draft({ targetPort: "-1" }))).toBe("port");
    expect(validateForwardForm(draft({ targetPort: "65536" }))).toBe("port");
  });
});

describe("findForwardConflict", () => {
  const rows = [
    row({}),
    row({ id: "fwd-2", kind: "remote", listenPort: 31234, boundPort: 31234 }),
  ];

  it("flags the same endpoint and wildcard overlap", () => {
    expect(findForwardConflict(rows, { kind: "local", listenHost: "127.0.0.1", listenPort: "8080" })?.id).toBe("fwd-1");
    expect(findForwardConflict(rows, { kind: "local", listenHost: "0.0.0.0", listenPort: "8080" })?.id).toBe("fwd-1");
    expect(findForwardConflict(rows, { kind: "local", listenHost: "127.0.0.1", listenPort: "8081" })).toBeNull();
    expect(findForwardConflict(rows, { kind: "dynamic", listenHost: "127.0.0.1", listenPort: "8080" })?.id).toBe("fwd-1");
    // Different direction: the same port lives on different machines.
    expect(findForwardConflict(rows, { kind: "remote", listenHost: "127.0.0.1", listenPort: "8080" })).toBeNull();
  });

  it("ignores auto-picked ports and defaults the empty host to loopback", () => {
    expect(findForwardConflict(rows, { kind: "local", listenHost: "127.0.0.1", listenPort: "0" })).toBeNull();
    expect(findForwardConflict(rows, { kind: "local", listenHost: "", listenPort: "8080" })?.id).toBe("fwd-1");
  });
});

describe("parseInterfaces", () => {
  it("parses rows and drops addressless entries", () => {
    const interfaces = parseInterfaces({
      interfaces: [
        { name: "lo0", addr: "127.0.0.1", isLoopback: true },
        { name: "en0", addr: "", isLoopback: false },
        null,
        { addr: "192.168.1.24", isLoopback: false },
      ],
    });
    expect(interfaces).toHaveLength(2);
    expect(interfaces[0]).toMatchObject({ name: "lo0", addr: "127.0.0.1", isLoopback: true });
    expect(interfaces[1]).toMatchObject({ name: "", addr: "192.168.1.24", isLoopback: false });
  });

  it("returns an empty list for junk payloads", () => {
    expect(parseInterfaces(null)).toEqual([]);
    expect(parseInterfaces({})).toEqual([]);
  });
});

describe("listenHostOptions", () => {
  const values = (kind: "local" | "remote") => listenHostOptions(kind).map((option) => option.value);

  it("offers all-interfaces and loopback literals for local binds", () => {
    expect(values("local")).toEqual(["0.0.0.0", "127.0.0.1", "::1"]);
    expect(listenHostOptions("dynamic")).toEqual(listenHostOptions("local"));
  });

  it("defaults remote binds to server-side loopback and wildcard group", () => {
    expect(values("remote")).toEqual(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::", "*"]);
    const labels = listenHostOptions("remote").map((option) => option.labelKey);
    expect(labels).toEqual([
      "forwards.loopback",
      "forwards.loopbackName",
      "forwards.loopback",
      "forwards.allInterfaces",
      "forwards.allInterfacesV6",
      "forwards.wildcardHost",
    ]);
  });

  it("keeps every remote candidate acceptable to validateForwardForm and local free of the wildcard", () => {
    for (const option of listenHostOptions("remote")) {
      expect(
        validateForwardForm({ kind: "remote", listenHost: option.value, listenPort: "8080", targetHost: "db", targetPort: "5432" }),
      ).toBeNull();
    }
    for (const option of listenHostOptions("local")) {
      // 本地候选也必须全量过本地校验（`*` 只允许出现在远程组）。
      expect(
        validateForwardForm({ kind: "local", listenHost: option.value, listenPort: "8080", targetHost: "db", targetPort: "5432" }),
      ).toBeNull();
    }
    expect(values("local")).not.toContain("*");
  });
});

describe("forwardStartParams", () => {
  it("coerces ports to numbers and trims hosts", () => {
    expect(
      forwardStartParams(
        { kind: "remote", listenHost: " 0.0.0.0 ", listenPort: "0", targetHost: " web ", targetPort: "3000" },
        "s-9",
      ),
    ).toEqual({
      sessionId: "s-9",
      kind: "remote",
      listenHost: "0.0.0.0",
      listenPort: 0,
      targetHost: "web",
      targetPort: 3000,
    });
  });
  it("starts independent SOCKS5 mappings without a fixed target", () => {
    expect(forwardStartParams({ kind: "dynamic", listenHost: "127.0.0.1", listenPort: "1080", targetHost: "", targetPort: "" }, "c-1", true)).toEqual({
      connectionId: "c-1", kind: "dynamic", listenHost: "127.0.0.1", listenPort: 1080,
    });
  });
});

describe("formatForwardRoute", () => {
  it("renders both directions with the bound port", () => {
    expect(formatForwardRoute(row({}))).toBe("127.0.0.1:8080 → db.internal:5432");
    expect(
      formatForwardRoute(row({ kind: "remote", listenPort: 0, boundPort: 31234, targetHost: "web", targetPort: 3000 })),
    ).toBe("127.0.0.1:31234 ← web:3000");
    expect(formatForwardRoute(row({ kind: "dynamic", boundPort: 1080 }))).toBe("SOCKS5 127.0.0.1:1080");
  });
});

describe("formatForwardBytes", () => {
  it("scales into readable units", () => {
    expect(formatForwardBytes(0)).toBe("0 B");
    expect(formatForwardBytes(1023)).toBe("1023 B");
    expect(formatForwardBytes(2048)).toBe("2.0 KiB");
    expect(formatForwardBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
