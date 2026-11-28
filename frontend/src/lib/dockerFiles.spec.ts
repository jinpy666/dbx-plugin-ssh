import { describe, expect, it } from "vitest";
import {
  DOCKER_FILES_MAX_ENTRIES,
  DOCKER_FILES_WRITE_MAX_BYTES,
  confirmDockerMutation,
  decodeBase64Bytes,
  decodeFileText,
  encodeFileText,
  filterDockerFileEntries,
  formatFileSize,
  initialDockerMutation,
  isHiddenDockerName,
  joinDockerPath,
  normalizeDockerFilePath,
  parentDockerPath,
  parseDockerFileContent,
  parseDockerFilesListing,
  requestDockerDelete,
  requestDockerWrite,
  settleDockerMutation,
  sortFileEntries,
  utf8ByteLength,
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

describe("dockerFiles write encoding", () => {
  it("encodes UTF-8 text and counts decoded bytes", () => {
    expect(encodeFileText("hello")).toBe("aGVsbG8=");
    expect(encodeFileText("你好")).toBe("5L2g5aW9");
    expect(utf8ByteLength("你好")).toBe(6);
    expect(utf8ByteLength("hello")).toBe(5);
    expect(DOCKER_FILES_WRITE_MAX_BYTES).toBe(65536);
  });

  it("round-trips through the preview decoder", () => {
    const text = "line1\nline2\n";
    expect(decodeFileText(decodeBase64Bytes(encodeFileText(text)))).toBe(text);
  });
});

describe("dockerFiles mutation confirmation state machine", () => {
  it("writes a new file without asking", () => {
    const step = requestDockerWrite(initialDockerMutation(), "/tmp/new.txt", false);
    expect(step.prompt).toBeNull();
    expect(step.request).toEqual({
      kind: "write",
      path: "/tmp/new.txt",
      overwrite: false,
      recursive: false,
    });
    expect(step.state.busy).toBe(true);
  });

  it("asks before overwriting an existing file and applies overwrite on confirm", () => {
    const asked = requestDockerWrite(initialDockerMutation(), "/tmp/old.txt", true);
    expect(asked.request).toBeNull();
    expect(asked.prompt?.overwrite).toBe(true);
    expect(asked.state.pending).toEqual(asked.prompt);

    const confirmed = confirmDockerMutation(asked.state, true);
    expect(confirmed.request).toEqual({
      kind: "write",
      path: "/tmp/old.txt",
      overwrite: true,
      recursive: false,
    });
    expect(confirmed.state.busy).toBe(true);
    expect(confirmed.prompt).toBeNull();
  });

  it("cancels a pending overwrite without executing", () => {
    const asked = requestDockerWrite(initialDockerMutation(), "/tmp/old.txt", true);
    const cancelled = confirmDockerMutation(asked.state, false);
    expect(cancelled.request).toBeNull();
    expect(cancelled.state).toEqual({ pending: null, busy: false });
  });

  it("always confirms deletes and keeps the recursive flag", () => {
    const file = requestDockerDelete(initialDockerMutation(), "/tmp/a.txt", false);
    expect(file.request).toBeNull();
    expect(file.prompt).toEqual({
      kind: "delete",
      path: "/tmp/a.txt",
      overwrite: false,
      recursive: false,
    });
    expect(confirmDockerMutation(file.state, true).request?.recursive).toBe(false);

    const folder = requestDockerDelete(initialDockerMutation(), "/tmp/tree", true);
    expect(folder.prompt?.recursive).toBe(true);
    expect(confirmDockerMutation(folder.state, true).request).toEqual({
      kind: "delete",
      path: "/tmp/tree",
      overwrite: false,
      recursive: true,
    });
  });

  it("ignores new requests while busy or while a prompt is pending", () => {
    const busy = requestDockerWrite(initialDockerMutation(), "/tmp/new.txt", false).state;
    expect(requestDockerWrite(busy, "/tmp/other.txt", false).request).toBeNull();
    expect(requestDockerDelete(busy, "/tmp/a.txt", false).prompt).toBeNull();

    const pending = requestDockerWrite(initialDockerMutation(), "/tmp/old.txt", true).state;
    expect(requestDockerDelete(pending, "/tmp/a.txt", false).prompt).toBeNull();
  });

  it("settles back to idle after an RPC", () => {
    expect(settleDockerMutation().state).toEqual({ pending: null, busy: false });
  });
});

describe("dockerFiles search", () => {
  const entries = [
    entry("app.conf", "file"),
    entry("app.log", "file"),
    entry("backup.tar.gz", "file"),
    entry("AppDir", "dir"),
  ];

  it("returns a copy and keeps order for an empty query", () => {
    const out = filterDockerFileEntries(entries, "  ");
    expect(out).toEqual(entries);
    expect(out).not.toBe(entries);
  });

  it("matches name substrings case-insensitively", () => {
    expect(filterDockerFileEntries(entries, "APP").map((item) => item.name)).toEqual([
      "app.conf",
      "app.log",
      "AppDir",
    ]);
    expect(filterDockerFileEntries(entries, ".tar").map((item) => item.name)).toEqual(["backup.tar.gz"]);
  });

  it("requires every whitespace token to match", () => {
    expect(filterDockerFileEntries(entries, "app log").map((item) => item.name)).toEqual(["app.log"]);
    expect(filterDockerFileEntries(entries, "app tar")).toEqual([]);
  });
});
