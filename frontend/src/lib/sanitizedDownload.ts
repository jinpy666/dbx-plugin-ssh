export interface SanitizedDownloadEnvironment {
  self: unknown;
  top: unknown;
  frameElement: { hasAttribute(name: string): boolean } | null;
  dbxPlugin: Pick<DbxPluginApi, "saveFile" | "fileTransfer">;
  Blob: typeof Blob;
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  document: Pick<Document, "body" | "createElement">;
}

function isTopLevelUnsandboxed(env: SanitizedDownloadEnvironment): boolean {
  if (env.self !== env.top) return false;
  return !env.frameElement?.hasAttribute("sandbox");
}

/**
 * Saves a pre-sanitized export without relying on host APIs introduced after
 * Host API 1.0. `saveFile` and `fileTransfer` remain preferred because a
 * sandboxed workbench must not attempt a browser download (issue #93).
 */
function browserDownloadEnvironment(): SanitizedDownloadEnvironment {
  return {
    self: window.self,
    top: window.top,
    frameElement: window.frameElement,
    dbxPlugin: window.dbxPlugin,
    Blob,
    URL,
    document,
  };
}

export async function exportSanitizedJson(
  bytes: Uint8Array,
  fileName: string,
  env: SanitizedDownloadEnvironment = browserDownloadEnvironment(),
): Promise<"saved" | "downloaded" | "cancelled"> {
  if (env.dbxPlugin.saveFile) {
    const saved = await env.dbxPlugin.saveFile({ fileName, contentType: "application/json" }, bytes);
    return saved ? "saved" : "cancelled";
  }
  if (env.dbxPlugin.fileTransfer) {
    const transfer = env.dbxPlugin.fileTransfer;
    const target = await transfer.beginSave({ name: fileName, contentType: "application/json", size: bytes.byteLength });
    await transfer.write(target.handleId, 0, bytes);
    await transfer.finish(target.handleId);
    return "saved";
  }
  if (!isTopLevelUnsandboxed(env)) {
    throw new Error("Sanitized export requires Host API saveFile or fileTransfer in a sandboxed workbench. Open it in a top-level browser context or upgrade the host.");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = env.URL.createObjectURL(new env.Blob([copy.buffer], { type: "application/json" }));
  const anchor = env.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  env.document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    env.URL.revokeObjectURL(url);
  }
  return "downloaded";
}
