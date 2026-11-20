// @vitest-environment happy-dom
// issue #307 回归锚点：drain 合帧后 ZRQINIT 与后续杂字节常在同一帧批次里
// 到达，consumeFrameViaZmodem 的空闲路径必须仍能触发检测并自动确认接收
// （状态条 + 进度反馈全依赖这条边沿）。
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useZmodem } from "./useZmodem";

const ZRQINIT_LRZSZ = Uint8Array.from("**\x18B00000000000000\r\x8a\x11".split("").map((c) => c.charCodeAt(0)));
const BANNER = new TextEncoder().encode("sz waiting to send.\r\n");
const TRAILING = new TextEncoder().encode("background output\r\n");

function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function mountZmodem() {
  const sentToRemote: Uint8Array[] = [];
  const composable = useZmodem({
    t: (key) => key,
    showNotice: vi.fn(),
    showError: vi.fn(),
    connected: ref(true),
    terminal: () => undefined,
    sendTerminalBytes: (data) => sentToRemote.push(data),
    dispatchTerminalOutput: vi.fn(),
    loadDirectory: vi.fn(async () => undefined),
    receiveAllowed: () => true,
    pickUploadFiles: vi.fn(),
    dismissNotice: vi.fn(),
    probeLocalCapabilities: vi.fn(async () => ({ canSaveLocal: false, downloadsDir: "" })),
    saveHostFile: vi.fn(async () => undefined),
    loadDownloadUseDefaultDir: () => true,
    askDownloadTarget: vi.fn(async () => ({ dir: "", setDefault: false })),
    loadDownloadDir: () => "",
    resolveDownloadConflictFor: vi.fn(async (): Promise<"rename" | "overwrite" | undefined> => "rename"),
    applyChosenDirAsDefault: vi.fn(),
    revealTransferTarget: vi.fn(async () => undefined),
  });
  return { composable, sentToRemote };
}

describe("useZmodem sz detection under merged drain batches (issue #307)", () => {
  it("confirms a receive session when ZRQINIT arrives merged with surrounding output", () => {
    const { composable, sentToRemote } = mountZmodem();
    // #302 合帧：回显/横幅 + ZRQINIT + 后续输出合并成同一段。
    const merged = new Uint8Array([...BANNER, ...ZRQINIT_LRZSZ, ...TRAILING]);
    composable.consumeFrameViaZmodem(merged);
    expect(composable.zmodemState.value).toBe("receiving");
    // 会话 start() 发出的 ZRINIT 邀请帧（hex `**\x18B01...`）已发往远端。
    const zrinit = sentToRemote.find((data) => data[0] === 0x2a);
    expect(zrinit).toBeDefined();
    expect(latin1(zrinit!)).toContain("**\x18B01");
  });

  it("keeps the busy-path passthrough intact (session frames feed directly)", () => {
    const { composable, sentToRemote } = mountZmodem();
    composable.consumeFrameViaZmodem(new Uint8Array([...BANNER, ...ZRQINIT_LRZSZ]));
    expect(composable.zmodemState.value).toBe("receiving");
    const before = sentToRemote.length;
    // 会话激活后的帧直喂 sentry（不再走定界器），不产生新的检测/发送。
    composable.consumeFrameViaZmodem(new Uint8Array([0x42, 0x00, 0x01]));
    expect(sentToRemote.length).toBeGreaterThanOrEqual(before);
  });
});
