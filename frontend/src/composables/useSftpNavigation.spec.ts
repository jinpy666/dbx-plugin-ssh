// @vitest-environment happy-dom
// Issue #209：目录跟随（fromTerminal=true）与连接后自动首拉（quiet）失败的
// 安静化——不再走全局错误横幅（sftpError Toast，8s 自动消失），只设面板内
// 软错误态（sftpSoftError）；手动导航失败保持既有全局横幅语义；软条上的
// 重试按手动导航语义重载（再失败落横幅），成功即清软态。
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { SftpColumn, SftpEntryKind } from "../lib/sftpEntries";
import { useSftpNavigation } from "./useSftpNavigation";

type ListingEntry = { uri: string; name: string; kind: SftpEntryKind };

/** 组装最小依赖桩：invoke 可编程应答，横幅/通知/软错误三路 sink 全量暴露。 */
function setupHarness() {
  const invoke = vi.fn<(cmd: string, args: Record<string, unknown>) => Promise<unknown>>();
  (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };

  const session = ref<{ sessionId?: string } | undefined>({ sessionId: "s1" });
  const sudoMode = ref(false);
  const connected = ref(true);
  const canWrite = ref(true);
  const currentPath = ref("/home/user");
  const entries = ref<ListingEntry[]>([]);
  const loadingFiles = ref(false);
  const sftpError = ref("");
  const sftpErrorOpen = ref(false);
  const sftpErrorKey = ref(0);
  const sftpHomePath = ref("");
  const visibleColumns = ref<SftpColumn[]>([]);
  const followDirectory = ref(true);
  const selectedPath = ref("");
  const directoryTrackingSupported = ref<boolean | undefined>(undefined);
  const notices: string[] = [];
  const showError = vi.fn();
  const openPathBarFile = vi.fn();

  const nav = useSftpNavigation({
    t: (key, values) => (values?.path !== undefined ? `${key}:${values.path}` : key),
    showNotice: (message) => { notices.push(message); },
    showError,
    session,
    sudoMode,
    connected,
    canWrite,
    currentPath,
    entries,
    loadingFiles,
    sftpError,
    sftpErrorOpen,
    sftpErrorKey,
    sftpHomePath,
    visibleColumns,
    followDirectory,
    directoryParser: { reset: () => undefined },
    selectedPath,
    directoryTrackingSupported,
    clearRowSelection: () => undefined,
    parentPath: (path) => (path === "/" ? "/" : path.slice(0, path.lastIndexOf("/")) || "/"),
    normalizeRemotePath: (path) => path,
    getPendingTerminalInput: () => "",
    persistState: () => undefined,
    refreshDiskUsage: () => undefined,
    persistDirectoryFollowPref: () => undefined,
    resetLinkTargets: () => undefined,
    hydrateLinkTargets: () => undefined,
    rememberPathHistory: () => undefined,
    closePathHistoryMenu: () => undefined,
    openPathBarFile: openPathBarFile,
  });

  return {
    nav, invoke, notices, showError, sudoMode,
    sftpSoftError: nav.sftpSoftError,
    sftpError, sftpErrorOpen, sftpErrorKey,
    entries, loadingFiles,
    currentPath, openPathBarFile,
  };
}

describe("useSftpNavigation quiet failure mode (issue #209)", () => {
  it("跟随失败静默：不弹通知/全局横幅，只设面板内软错误", async () => {
    const h = setupHarness();
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));

    await h.nav.loadDirectory("/data/target", true);

    expect(h.notices).toEqual([]);
    expect(h.showError).not.toHaveBeenCalled();
    expect(h.sftpError.value).toBe("");
    expect(h.sftpErrorOpen.value).toBe(false);
    expect(h.sftpSoftError.value).not.toBeNull();
    expect(h.sftpSoftError.value?.path).toBe("/data/target");
    expect(h.sftpSoftError.value?.detail).toBe("SFTP operation failed: No such file");
    expect(h.loadingFiles.value).toBe(false);
  });

  it("自动首拉（quiet）失败同样静默", async () => {
    const h = setupHarness();
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));

    await h.nav.loadDirectory("/srv", false, true);

    expect(h.notices).toEqual([]);
    expect(h.sftpError.value).toBe("");
    expect(h.sftpErrorOpen.value).toBe(false);
    expect(h.sftpSoftError.value?.path).toBe("/srv");
  });

  it("手动导航失败仍走全局错误横幅（既有语义不变）", async () => {
    const h = setupHarness();
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));

    await h.nav.loadDirectory("/other");

    expect(h.sftpError.value).toBe("SFTP operation failed: No such file");
    expect(h.sftpErrorOpen.value).toBe(true);
    expect(h.sftpErrorKey.value).toBe(1);
    expect(h.sftpSoftError.value).toBeNull();
    expect(h.notices).toEqual([]);
  });

  it("软条重试按手动导航语义执行：再失败落全局横幅且软态已清", async () => {
    const h = setupHarness();
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));
    await h.nav.loadDirectory("/data/target", true);
    expect(h.sftpSoftError.value).not.toBeNull();

    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));
    h.sftpSoftError.value?.action.run();
    await vi.waitFor(() => expect(h.loadingFiles.value).toBe(false));

    expect(h.sftpSoftError.value).toBeNull();
    expect(h.sftpError.value).toBe("SFTP operation failed: No such file");
    expect(h.sftpErrorOpen.value).toBe(true);
  });

  it("任一后续加载成功即清除软错误", async () => {
    const h = setupHarness();
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));
    await h.nav.loadDirectory("/data/target", true);
    expect(h.sftpSoftError.value).not.toBeNull();

    h.invoke.mockResolvedValueOnce({ entries: [{ uri: "/ok/a", name: "a", kind: "file" }] });
    await h.nav.loadDirectory("/ok", true);

    expect(h.sftpSoftError.value).toBeNull();
    expect(h.entries.value.map((entry) => entry.name)).toEqual(["a"]);
  });

  it("权限墙仍在软条内给切 sudo 引导：动作切换 sudo 并按手动语义重载", async () => {
    const h = setupHarness();
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: Permission denied"));
    await h.nav.loadDirectory("/root", true);

    expect(h.sftpSoftError.value?.message).toContain("followDirectorySudoHint");
    expect(h.sftpSoftError.value?.action.label).toBe("followDirectorySudoRetry");

    h.invoke.mockResolvedValueOnce({ entries: [] });
    h.sftpSoftError.value?.action.run();
    await vi.waitFor(() => expect(h.loadingFiles.value).toBe(false));

    expect(h.sudoMode.value).toBe(true);
    expect(h.sftpSoftError.value).toBeNull();
    expect(h.notices).toEqual([]);
  });

  it("加载中切换 sudo 模式立即生效，迟到的旧响应不再覆盖列表", async () => {
    const h = setupHarness();
    // 第一次加载永不完成（模拟 sudo 操作卡到 sidecar 超时）。
    let releaseFirst: (value: unknown) => void = () => undefined;
    h.invoke.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = resolve; }),
    );

    const first = h.nav.loadDirectory("/home/user");
    expect(h.loadingFiles.value).toBe(true);

    // 旧请求未返回时切换 sudo：必须立即换 sudo 车道并重载，而不是吞掉开关。
    h.invoke.mockResolvedValueOnce({ entries: [] });
    h.nav.toggleSudoMode();

    expect(h.sudoMode.value).toBe(true);
    expect(h.invoke).toHaveBeenLastCalledWith(
      "sudo/listDir",
      expect.objectContaining({ path: "/home/user" }),
    );
    await vi.waitFor(() => expect(h.loadingFiles.value).toBe(false));
    expect(h.entries.value).toEqual([]);

    // 旧请求迟到：epoch 已失效，不得覆盖新列表或把 loading 打回 false。
    releaseFirst({ entries: [{ uri: "/home/user/stale", name: "stale", kind: "file" }] });
    await first;
    expect(h.entries.value).toEqual([]);
  });
});

// issue #268：路径栏提交的是文件而非目录时——list 对 ENOTDIR 只回笼统的
// "SFTP operation failed: Failure" 原始错误串。提交后补一次 stat：是文件就
// 转双击同款预览入口（清掉横幅）；真是目录（权限拒绝等）或 stat 也失败则
// 维持原横幅不动。
describe("路径栏提交文件路径 (#268)", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("list 失败且 stat 为文件：转预览入口并清横幅", async () => {
    const h = setupHarness();
    h.currentPath.value = "/etc/docker/daemon.json";
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: Failure"));
    h.invoke.mockResolvedValueOnce({ kind: "file" });
    h.invoke.mockResolvedValueOnce({ entries: [] }); // 回退父目录后的重载
    h.nav.submitPathInput();
    await flush();
    await flush();
    expect(h.openPathBarFile).toHaveBeenCalledWith("/etc/docker/daemon.json");
    expect(h.sftpError.value).toBe("");
    expect(h.sftpErrorOpen.value).toBe(false);
  });

  it("stat 为目录（权限拒绝等）：维持原错误横幅", async () => {
    const h = setupHarness();
    h.currentPath.value = "/root/locked";
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: Permission denied"));
    h.invoke.mockResolvedValueOnce({ kind: "directory" });
    h.nav.submitPathInput();
    await flush();
    await flush();
    expect(h.openPathBarFile).not.toHaveBeenCalled();
    expect(h.sftpError.value).toBe("SFTP operation failed: Permission denied");
  });

  it("stat 也失败：维持原错误横幅", async () => {
    const h = setupHarness();
    h.currentPath.value = "/gone";
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: No such file"));
    h.invoke.mockRejectedValueOnce(new Error("stat boom"));
    h.nav.submitPathInput();
    await flush();
    await flush();
    expect(h.openPathBarFile).not.toHaveBeenCalled();
    expect(h.sftpError.value).toBe("SFTP operation failed: No such file");
  });

  // 用户实测反馈（beta.4）：文件提交把 currentPath 置成了文件路径，预览里
  // 编辑保存后的列表刷新拿它继续 list → ENOTDIR "not a directory"。
  // 修复契约：确认是文件后路径栏回退父目录、立即重载父目录列表。
  it("文件提交后回退路径栏到父目录并重载父目录列表", async () => {
    const h = setupHarness();
    h.currentPath.value = "/home/jinpy/test.json";
    h.invoke.mockRejectedValueOnce(new Error("SFTP operation failed: Failure"));
    h.invoke.mockResolvedValueOnce({ kind: "file" });
    h.invoke.mockResolvedValueOnce({ entries: [{ uri: "/home/jinpy/test.json", name: "test.json", kind: "file" }] });
    h.nav.submitPathInput();
    await vi.waitFor(() => expect(h.openPathBarFile).toHaveBeenCalledWith("/home/jinpy/test.json"));
    expect(h.currentPath.value).toBe("/home/jinpy");
    expect(h.sftpError.value).toBe("");
    expect(h.entries.value).toEqual([{ uri: "/home/jinpy/test.json", name: "test.json", kind: "file" }]);
  });
});
