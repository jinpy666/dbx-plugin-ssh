import { describe, expect, it } from "vitest";
import { classifyConnectError, connectErrorKey } from "./connectError";

describe("classifyConnectError", () => {
  it("classifies sidecar auth failures as auth", () => {
    expect(classifyConnectError("SSH password authentication failed: Disconnect")).toBe("auth");
    expect(classifyConnectError("SSH private-key authentication was rejected")).toBe("auth");
    expect(classifyConnectError("SSH server did not advertise password or keyboard-interactive authentication; refusing to send the password")).toBe("auth");
    expect(classifyConnectError("Permission denied (publickey)")).toBeNull(); // gated: no connect-domain marker
    expect(classifyConnectError("SSH connection failed: Permission denied (publickey)")).toBe("auth");
  });

  it("prefers auth over timeout when both match", () => {
    expect(classifyConnectError("SSH password authentication timed out")).toBe("auth");
    expect(classifyConnectError("SSH keyboard-interactive authentication timed out")).toBe("auth");
  });

  it("classifies transport failures", () => {
    expect(classifyConnectError("SSH connection failed: Connection refused (os error 61)")).toBe("refused");
    expect(classifyConnectError("SSH connection to dbx-ssh-test:22 timed out")).toBe("timeout");
    expect(classifyConnectError("SSH connection failed: No route to host (os error 113)")).toBe("network");
    expect(classifyConnectError("SSH connection failed: failed to lookup address information: Name or service not known")).toBe("dns");
  });

  it("classifies host key problems before auth", () => {
    expect(classifyConnectError("SSH connection failed: UnknownKey")).toBe("hostKey");
    expect(classifyConnectError("SSH handshake completed without presenting a host key")).toBe("hostKey");
  });

  it("leaves non-connect-domain errors untouched", () => {
    expect(classifyConnectError("Command not run: approval timed out waiting for the user")).toBeNull();
    expect(classifyConnectError("SFTP upload rejected: file exists")).toBeNull();
    expect(classifyConnectError("")).toBeNull();
    expect(classifyConnectError(String(undefined))).toBeNull();
  });

  it("maps every kind to a connectError i18n key", () => {
    expect(connectErrorKey("dns")).toBe("connectError.dns");
    expect(connectErrorKey("refused")).toBe("connectError.refused");
    expect(connectErrorKey("hostKey")).toBe("connectError.hostKey");
    expect(connectErrorKey("auth")).toBe("connectError.auth");
    expect(connectErrorKey("timeout")).toBe("connectError.timeout");
    expect(connectErrorKey("network")).toBe("connectError.network");
  });
});
