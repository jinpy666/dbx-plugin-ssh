import { describe, expect, it } from "vitest";
import {
  DOCKER_FILES_MAX_ENTRIES,
  decodeBase64Bytes,
  decodeFileText,
  formatFileSize,
  isHiddenDockerName,
  joinDockerPath,
  normalizeDockerFilePath,
  parentDockerPath,
  parseDockerFileContent,
  parseDockerFilesListing,
  sortFileEntries,
  type DockerFileEntry,
} from "./dockerFiles";

function entry(name: string, kind: DockerFileEntry["kind"], size = 0): DockerFileEntry {
  return { name, kind, size, path: `/tmp/${name}` };
}

describe("dockerFiles path helpers", () => {
  it("normalizes trailing slashes and missing root", () => {
    expect(normalizeDockerFilePath("/etc/")).toBe("/etc");
    expect(normalizeDockerFilePath("etc")).toBe("/etc");
    expect(normalizeDockerFilePath("/")).toBe("/");
    expect(normalizeDockerFilePath("  /var//log/  ")).toBe("/var//log");
    expect(normalizeDockerFilePath("")).toBe("/");
  });

  it("computes parent paths without escaping root", () => {
    expect(parentDockerPath("/var/log/nginx")).toBe("/var/log");
    expect(parentDockerPath("/var")).toBe("/");
    expect(parentDockerPath("/")).toBe("/");
  });

  it("joins names onto directories", () => {
    expect(joinDockerPath("/", "etc")).toBe("/etc");
    expect(joinDockerPath("/var", "log")).toBe("/var/log");
    expect(joinDockerPath("/var/", "log/")).toBe("/var/log");
    expect(joinDockerPath("/var", "")).toBe("/var");
  });

  it("detects hidden names", () => {
    expect(isHiddenDockerName(".env")).toBe(true);
    expect(isHiddenDockerName("env")).toBe(false);
  });
});

describe("dockerFiles formatting and sorting", () => {
  it("formats byte sizes with IEC units", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KiB");
    expect(formatFileSize(1536)).toBe("1.5 KiB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatFileSize(-4)).toBe("0 B");
  });

  it("sorts directories first, then names naturally", () => {
    const sorted = sortFileEntries([
      entry("file10", "file"),
      entry("zeta", "dir"),
      entry("file2", "file"),
      entry("link", "link"),
      entry("Alpha", "dir"),
    ]);
    expect(sorted.map((item) => item.name)).toEqual([
      "Alpha",
      "zeta",
      "file2",
      "file10",
      "link",
    ]);
  });
});

describe("dockerFiles payload parsing", () => {
  it("normalizes a listing and caps entries", () => {
    const payload = {
      path: "/srv/",
      entries: [
        { name: "logs", path: "/srv/logs", kind: "dir", size: 99 },
        { name: "app.log", path: "/srv/app.log", kind: "file", size: 12 },
        { name: "bad/name", path: "/srv/bad/name", kind: "file", size: 1 },
        { name: "socket", path: "/srv/socket", kind: "socket", size: 3 },
      ],
      truncated: false,
    };
    const listing = parseDockerFilesListing(payload);
    expect(listing.path).toBe("/srv");
    expect(listing.entries.map((item) => item.name)).toEqual(["logs", "app.log", "socket"]);
    expect(listing.entries[0].size).toBe(0);
    expect(listing.entries[1].size).toBe(12);
    expect(listing.entries[2].kind).toBe("other");
    expect(listing.entries[2].size).toBe(0);
  });

  it("marks listings over the cap as truncated", () => {
    const entries = Array.from({ length: DOCKER_FILES_MAX_ENTRIES + 1 }, (_, index) => ({
      name: `f${index}`,
      path: `/tmp/f${index}`,
      kind: "file",
      size: index,
    }));
    const listing = parseDockerFilesListing({ path: "/tmp", entries, truncated: false });
    expect(listing.entries).toHaveLength(DOCKER_FILES_MAX_ENTRIES);
    expect(listing.truncated).toBe(true);
  });

  it("normalizes read payloads", () => {
    expect(parseDockerFileContent({ path: "/tmp/a", dataBase64: "aGk=", size: 2, truncated: true }))
      .toEqual({ path: "/tmp/a", dataBase64: "aGk=", size: 2, truncated: true });
    expect(parseDockerFileContent(null)).toEqual({
      path: "/",
      dataBase64: "",
      size: 0,
      truncated: false,
    });
  });
});

describe("dockerFiles base64 decoding", () => {
  it("decodes text and rejects binary", () => {
    const bytes = decodeBase64Bytes("aGVsbG8=");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
    expect(decodeFileText(bytes)).toBe("hello");
    expect(decodeFileText(new Uint8Array([104, 0, 105]))).toBeNull();
    expect(decodeBase64Bytes("not base64 %%")).toEqual(new Uint8Array());
  });

  it("decodes UTF-8 multibyte content", () => {
    expect(decodeFileText(decodeBase64Bytes("5L2g5aW9"))).toBe("你好");
  });
});
