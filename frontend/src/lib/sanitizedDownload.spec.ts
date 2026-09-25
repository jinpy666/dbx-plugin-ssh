import { describe, expect, it, vi } from "vitest";
import { exportSanitizedJson } from "./sanitizedDownload";

describe("exportSanitizedJson", () => {
  it("downloads a sanitized export with a Blob when Host API 1.0 has no save bridge", async () => {
    const objectUrl = "blob:preview";
    const createObjectUrl = vi.fn(() => objectUrl);
    const revokeObjectUrl = vi.fn();
    const click = vi.fn();
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const anchor = { href: "", download: "", style: { display: "" }, click, remove: removeChild };
    const env = {
      self: {},
      top: undefined as unknown,
      frameElement: null,
      dbxPlugin: {},
      Blob,
      URL: { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl },
      document: {
        body: { appendChild },
        createElement: vi.fn(() => anchor),
      },
    };
    env.top = env.self;

    await expect(exportSanitizedJson(new Uint8Array([1, 2, 3]), "sessions.json", env as unknown as import("./sanitizedDownload").SanitizedDownloadEnvironment)).resolves.toBe("downloaded");

    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("sessions.json");
    expect(anchor.href).toBe(objectUrl);
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(removeChild).toHaveBeenCalledOnce();
  });

  it("rejects Blob download from an iframe with actionable Host API guidance", async () => {
    const env = {
      self: {},
      top: {},
      frameElement: { hasAttribute: vi.fn(() => true) },
      dbxPlugin: {},
      Blob,
      URL,
      document: {
        body: { appendChild: vi.fn() },
        createElement: vi.fn(() => ({ href: "", download: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() })),
      },
    };

    await expect(exportSanitizedJson(new Uint8Array([1]), "sessions.json", env as unknown as import("./sanitizedDownload").SanitizedDownloadEnvironment)).rejects.toThrow(
      "saveFile or fileTransfer",
    );
  });
});
