import { describe, expect, it } from "vitest";
import { friendlySftpError } from "./sftpErrors";

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
