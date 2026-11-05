// issue #245 回归守卫：sz/ZMODEM（及 trzsz）下载落盘通道的优先级契约。
// 旧实现「宿主 fileTransfer 存在即抢占」，但 fileTransfer 通道拿不到本机
// 落盘路径，0.7.11 承诺的「收完自动定位落盘目录」在桌面宿主上是死代码
// 路径。新契约与 SFTP 下载链路对齐：本机可落盘 → sidecar（唯一能提供
// 本机路径、下载目录设置与「在文件夹中显示」的通道）；否则 fileTransfer
// （web/docker 流式保存）；两者皆缺 → hostSave 兜底。
import { describe, expect, it, vi } from "vitest";
import { chooseTransferSinkChannel } from "./downloadPrefs";

const localOk = async () => ({ canSaveLocal: true, downloadsDir: "/Users/demo/Downloads" });
const localNo = async () => ({ canSaveLocal: false, downloadsDir: "" });

describe("chooseTransferSinkChannel", () => {
  it("#245：桌面宿主 fileTransfer 在位也优先 sidecar（保住自动定位落盘目录）", async () => {
    await expect(chooseTransferSinkChannel({ hasFileTransfer: true, probeLocalCapabilities: localOk })).resolves.toBe("sidecar");
  });

  it("本机不可落盘 + fileTransfer 在位 → fileTransfer（web/docker 流式保存）", async () => {
    await expect(chooseTransferSinkChannel({ hasFileTransfer: true, probeLocalCapabilities: localNo })).resolves.toBe("fileTransfer");
  });

  it("本机可落盘 + fileTransfer 缺失 → sidecar（沙箱 iframe 形态）", async () => {
    await expect(chooseTransferSinkChannel({ hasFileTransfer: false, probeLocalCapabilities: localOk })).resolves.toBe("sidecar");
  });

  it("两者皆缺 → hostSave 兜底", async () => {
    await expect(chooseTransferSinkChannel({ hasFileTransfer: false, probeLocalCapabilities: localNo })).resolves.toBe("hostSave");
  });

  it("探测抛错按不可落盘降级，不 reject", async () => {
    const boom = vi.fn(async () => {
      throw new Error("sidecar down");
    });
    await expect(chooseTransferSinkChannel({ hasFileTransfer: true, probeLocalCapabilities: boom })).resolves.toBe("fileTransfer");
  });
});
