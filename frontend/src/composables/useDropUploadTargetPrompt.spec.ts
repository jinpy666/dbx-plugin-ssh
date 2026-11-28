// 拖入上传落点询问单测：单槽互斥链、cwd/custom 确认路径与 latin-1 wire
// 形式转换（M17 增量②）。

import { ref } from "vue";
import { describe, expect, it } from "vitest";
import { useDropUploadTargetPrompt } from "./useDropUploadTargetPrompt";

/** 询问链的弹窗赋值发生在微任务里：先刷一拍再做状态断言/确认。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount(encoding: "auto" | "latin-1" = "auto") {
  return useDropUploadTargetPrompt({
    currentPath: ref("/panel"),
    sftpHomePath: ref("/home/sshuser"),
    terminalCwd: ref("/var/www"),
    sftpNameEncodingState: ref(encoding),
  });
}

describe("useDropUploadTargetPrompt ask/resolve", () => {
  it("opens the prompt at the cwd default and resolves the choice", async () => {
    const prompt = mount();
    const pending = prompt.askDropUploadTarget([{ name: "a.bin" }]);
    await flush();
    expect(prompt.dropUploadPrompt.value?.files).toEqual([{ name: "a.bin" }]);
    expect(prompt.dropUploadTarget.value).toBe("cwd");
    expect(prompt.dropUploadPathInput.value).toBe("");
    prompt.resolveDropUpload("cwd");
    await expect(pending).resolves.toBe("cwd");
    expect(prompt.dropUploadPrompt.value).toBeUndefined();
  });

  it("serializes concurrent asks: the later ask occupies the slot only after the first resolves", async () => {
    const prompt = mount();
    const first = prompt.askDropUploadTarget([{ name: "one" }]);
    const second = prompt.askDropUploadTarget([{ name: "two" }]);
    await flush();
    expect(prompt.dropUploadPrompt.value?.files).toEqual([{ name: "one" }]);
    prompt.resolveDropUpload("cancel");
    await expect(first).resolves.toBe("cancel");
    await flush();
    expect(prompt.dropUploadPrompt.value?.files).toEqual([{ name: "two" }]);
    prompt.resolveDropUpload("cwd");
    await expect(second).resolves.toBe("cwd");
  });
});

describe("useDropUploadTargetPrompt confirm", () => {
  it("resolves a normalized custom directory", async () => {
    const prompt = mount();
    const pending = prompt.askDropUploadTarget([{ name: "a.bin" }]);
    await flush();
    prompt.dropUploadTarget.value = "custom";
    prompt.dropUploadPathInput.value = "  /srv/app/  ";
    prompt.confirmDropUpload();
    await expect(pending).resolves.toEqual({ dir: "/srv/app" });
  });

  it("confirms the cwd target when no custom input is set", async () => {
    const prompt = mount();
    const pending = prompt.askDropUploadTarget([{ name: "a.bin" }]);
    await flush();
    prompt.confirmDropUpload();
    await expect(pending).resolves.toBe("cwd");
  });

  it("ignores confirm while no prompt is open", () => {
    const prompt = mount();
    expect(() => prompt.confirmDropUpload()).not.toThrow();
  });
});

describe("useDropUploadTargetPrompt resolution fallbacks", () => {
  it("prefers terminal cwd, then sftp home, then the panel directory", () => {
    expect(mount().dropCwdTarget.value).toBe("/var/www");
    const withoutShellCwd = useDropUploadTargetPrompt({
      currentPath: ref("/panel"),
      sftpHomePath: ref("/home/sshuser"),
      terminalCwd: ref(""),
      sftpNameEncodingState: ref("auto"),
    });
    expect(withoutShellCwd.dropCwdTarget.value).toBe("/home/sshuser");
    const withNothing = useDropUploadTargetPrompt({
      currentPath: ref("/panel"),
      sftpHomePath: ref(""),
      terminalCwd: ref(""),
      sftpNameEncodingState: ref("auto"),
    });
    expect(withNothing.dropCwdTarget.value).toBe("/panel");
  });

  it("converts latin-1 display text to wire form for the wire target", () => {
    const prompt = mount("latin-1");
    expect(prompt.wireDropDir("/café")).toBe("/caf%E9");
    expect(mount("auto").wireDropDir("/café")).toBe("/café");
    expect(prompt.wireDropDir(undefined)).toBeUndefined();
  });
});
