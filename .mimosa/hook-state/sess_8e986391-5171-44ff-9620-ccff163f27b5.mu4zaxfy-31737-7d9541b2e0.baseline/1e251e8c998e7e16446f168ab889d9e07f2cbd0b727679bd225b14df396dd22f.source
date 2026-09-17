// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { filesFromClipboard, type ClipboardFileItemLike } from "./clipboardFiles";

function file(name: string, body = "data") {
  return new File([body], name, { type: "text/plain" });
}

describe("filesFromClipboard", () => {
  it("prefers the native FileList exposed by a paste event", () => {
    const direct = file("from-finder.txt");
    const item = file("duplicate-item.txt");
    expect(filesFromClipboard({ files: [direct], items: [{ kind: "file", getAsFile: () => item }] })).toEqual([direct]);
  });

  it("falls back to file DataTransferItems", () => {
    const pasted = file("screenshot.png", "png");
    const items: ClipboardFileItemLike[] = [
      { kind: "string", getAsFile: () => file("ignored.txt") },
      { kind: "file", getAsFile: () => pasted },
      { kind: "file", getAsFile: () => null },
    ];
    expect(filesFromClipboard({ files: [], items })).toEqual([pasted]);
  });

  it("returns an empty list for text-only or unavailable clipboard data", () => {
    expect(filesFromClipboard(undefined)).toEqual([]);
    expect(filesFromClipboard({ items: [{ kind: "string" }] })).toEqual([]);
  });
});
