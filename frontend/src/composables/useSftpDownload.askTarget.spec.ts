// @vitest-environment happy-dom
// issue #303：右键「下载到…」一次性目录覆盖入口。已有能力（「使用默认地址」
// 关闭时每次询问目录）藏在设置里；本入口对该次下载强制走目录询问，无需翻转
// 全局开关。start 抛错即中止——测试只关心询问是否发生、选择目录是否随 start
// 下发，不需要完整跑通分块管线。
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useSftpDownload } from "./useSftpDownload";

function mountDownload(handlers: Record<string, (...args: unknown[]) => Promise<unknown>>, overrides?: { useDefaultDir?: boolean; askTarget?: { dir: string; setDefault: boolean } | undefined }) {
  const invoke = vi.fn((method: string, ...rest: unknown[]) => {
    const handler = handlers[method];
    if (!handler) return Promise.resolve(undefined);
    return handler(...rest);
  });
  (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
  const askDownloadTarget = vi.fn(async () => overrides?.askTarget);
  const composable = useSftpDownload({
    t: (key) => key,
    showNotice: vi.fn(),
    showError: vi.fn(),
    session: ref({ sessionId: "s1" }),
    entries: ref([]),
    fileMenu: ref(undefined),
    localDownloadDir: ref(""),
    localCanSave: ref(true),
    transferTasks: {},
    cancelledTransferTasks: new Set(),
    downloadChunkWaiters: new Map(),
    waitWhilePaused: () => undefined,
    loadDownloadDir: () => "/default-downloads",
    loadDownloadUseDefaultDir: () => overrides?.useDefaultDir ?? true,
    askDownloadTarget,
    applyChosenDirAsDefault: vi.fn(),
    resolveDownloadConflictFor: async () => "overwrite",
    openTransferPanel: vi.fn(),
    pathFromUri: (uri: string) => uri,
    sudoDownload: () => false,
  });
  return { composable, askDownloadTarget };
}

const abortAtStart = (startParams: Array<Record<string, unknown>>) => ({
  "local/capabilities": async () => ({ canSaveLocal: true, downloadsDir: "/default-downloads" }),
  "sftp/download/start": async (params: unknown) => {
    startParams.push(params as Record<string, unknown>);
    throw new Error("abort-early");
  },
});

describe("downloadEntry 一次性目录覆盖 (#303)", () => {
  it("askTarget=true 时即使全局「使用默认地址」开启也弹目录询问，并把所选目录随 start 下发", async () => {
    const startParams: Array<Record<string, unknown>> = [];
    const { composable, askDownloadTarget } = mountDownload(
      abortAtStart(startParams),
      { useDefaultDir: true, askTarget: { dir: "/chosen/dir", setDefault: false } },
    );
    await composable.downloadEntry({ uri: "/r/a.log", name: "a.log", kind: "file", size: 4 }, false, false, true);
    expect(askDownloadTarget).toHaveBeenCalledTimes(1);
    expect(startParams[0]?.downloadDir).toBe("/chosen/dir");
  });

  it("askTarget=false 且全局开关开启时不询问，沿用默认目录", async () => {
    const startParams: Array<Record<string, unknown>> = [];
    const { composable, askDownloadTarget } = mountDownload(
      abortAtStart(startParams),
      { useDefaultDir: true, askTarget: { dir: "/should-not-be-used", setDefault: false } },
    );
    await composable.downloadEntry({ uri: "/r/a.log", name: "a.log", kind: "file", size: 4 }, false, false, false);
    expect(askDownloadTarget).not.toHaveBeenCalled();
    expect(startParams[0]?.downloadDir).toBe("/default-downloads");
  });
});
