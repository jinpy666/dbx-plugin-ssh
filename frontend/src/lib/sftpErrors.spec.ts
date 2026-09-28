import { describe, expect, it } from "vitest";
import { friendlySftpError, isPermissionDeniedError, shouldOfferSudoRetryAfterFollowFailure } from "./sftpErrors";

const t = (key: string) => `<${key}>`;

describe("friendlySftpError", () => {
  it("maps permission failures to the localized permission message", () => {
    expect(friendlySftpError("SFTP operation failed: Permission denied: Permission denied", t)).toBe("<errors.permissionDenied>");
    expect(friendlySftpError("open failed: Access denied", t)).toBe("<errors.permissionDenied>");
    expect(friendlySftpError("Operation not permitted", t)).toBe("<errors.permissionDenied>");
  });

  it("maps missing remote paths to the localized not-found message", () => {
    expect(friendlySftpError("SFTP operation failed: No such file", t)).toBe("<errors.remoteNotFound>");
    expect(friendlySftpError("stat /tmp/x: The file does not exist", t)).toBe("<errors.remoteNotFound>");
  });

  it("leaves unrecognized errors untouched", () => {
    expect(friendlySftpError("Connection reset by peer", t)).toBeUndefined();
    expect(friendlySftpError("", t)).toBeUndefined();
  });
});

describe("isPermissionDeniedError", () => {
  it("recognizes permission-class failures regardless of phrasing or case", () => {
    expect(isPermissionDeniedError("SFTP operation failed: Permission denied")).toBe(true);
    expect(isPermissionDeniedError("open failed: Access denied")).toBe(true);
    expect(isPermissionDeniedError("Operation not permitted")).toBe(true);
  });

  it("rejects unrelated failures", () => {
    expect(isPermissionDeniedError("SFTP operation failed: No such file")).toBe(false);
    expect(isPermissionDeniedError("Connection reset by peer")).toBe(false);
    expect(isPermissionDeniedError("")).toBe(false);
  });
});

describe("shouldOfferSudoRetryAfterFollowFailure", () => {
  const base = { fromTerminal: true, sudoMode: false, canWrite: true, message: "Permission denied" };

  it("offers the sudo hint when a follow hit a permission wall outside sudo mode", () => {
    expect(shouldOfferSudoRetryAfterFollowFailure(base)).toBe(true);
    expect(shouldOfferSudoRetryAfterFollowFailure({ ...base, message: "list /root: Operation not permitted" })).toBe(true);
  });

  it("does not offer the hint for manual navigation errors", () => {
    expect(shouldOfferSudoRetryAfterFollowFailure({ ...base, fromTerminal: false })).toBe(false);
  });

  it("does not offer the hint when sudo mode is already on", () => {
    expect(shouldOfferSudoRetryAfterFollowFailure({ ...base, sudoMode: true })).toBe(false);
  });

  it("does not offer the hint on read-only connections", () => {
    expect(shouldOfferSudoRetryAfterFollowFailure({ ...base, canWrite: false })).toBe(false);
  });

  it("does not offer the hint for non-permission failures", () => {
    expect(shouldOfferSudoRetryAfterFollowFailure({ ...base, message: "No such file" })).toBe(false);
  });
});
