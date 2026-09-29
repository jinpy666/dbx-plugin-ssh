import { describe, expect, it } from "vitest";
import { terminalFlexBasis } from "./paneLayout";

describe("terminalFlexBasis", () => {
  it("gives the terminal the full row when nothing else is open", () => {
    expect(terminalFlexBasis({ sftpOpen: false, splitRatio: 58 })).toBe("100%");
  });

  it("keeps the user split ratio when only SFTP is open", () => {
    expect(terminalFlexBasis({ sftpOpen: true, splitRatio: 62 })).toBe("62%");
  });
});
