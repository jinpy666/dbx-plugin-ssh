import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMN_WIDTHS } from "./sftpEntries";
import { sftpColumnTrack, sftpGridMinWidth, sftpNameTrack } from "./sftpGrid";

describe("responsive SFTP grid", () => {
  it("gives the name column the largest flexible share", () => {
    expect(sftpNameTrack(240)).toBe("minmax(240px, 2.2fr)");
    expect(sftpColumnTrack("modified", 130)).toBe("minmax(130px, 1fr)");
    expect(sftpColumnTrack("size", 80)).toBe("minmax(80px, 0.7fr)");
    expect(sftpColumnTrack("kind", 64)).toBe("minmax(64px, 0.55fr)");
  });

  it("uses the readable minimum when a custom width is too small", () => {
    expect(sftpColumnTrack("modified", 20)).toBe("minmax(72px, 1fr)");
    expect(sftpColumnTrack("kind", 20)).toBe("minmax(60px, 0.55fr)");
  });

  it("computes the horizontal-scroll threshold from tracks and gaps", () => {
    expect(sftpGridMinWidth(240, ["modified", "size", "kind"], DEFAULT_COLUMN_WIDTHS)).toBe(240 + 20 + 130 + 80 + 64 + 48);
  });
});
