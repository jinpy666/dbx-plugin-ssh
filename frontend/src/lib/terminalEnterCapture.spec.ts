// 回车行兜底采集的纯判定测试：门过滤（空行/整屏程序/传输占用/命令运行中）
// 与回显对照（关回显的凭据输入绝不放行；屏幕含模型行才放行；屏幕不可测放行）
// 及回显提取（issue #169：Tab 补全后的真实命令以屏幕为准）。
// 对应 App.vue trackPendingInput 回车分支 → captureEnterLine 的接线。
import { describe, expect, it } from "vitest";
import { canCaptureEnterLine, echoConfirmsLine, extractEchoedCommand, type EnterCaptureGates } from "./terminalEnterCapture";

const openGates: EnterCaptureGates = { alternateActive: false, transferBusy: false, shellCommandActive: false };

describe("canCaptureEnterLine", () => {
  it("accepts a normal typed command at the prompt", () => {
    expect(canCaptureEnterLine("kubectl get pods", openGates)).toBe(true);
  });

  it("rejects blank lines (enter on an empty prompt)", () => {
    expect(canCaptureEnterLine("", openGates)).toBe(false);
    expect(canCaptureEnterLine("   ", openGates)).toBe(false);
  });

  it("rejects alternate-buffer programs (vim/tmux/htop own the enter key)", () => {
    expect(canCaptureEnterLine(":wq", { ...openGates, alternateActive: true })).toBe(false);
  });

  it("rejects while a transfer owns the input stream", () => {
    expect(canCaptureEnterLine("ls", { ...openGates, transferBusy: true })).toBe(false);
  });

  it("rejects while shell integration reports a running command (E..D frames)", () => {
    expect(canCaptureEnterLine("y", { ...openGates, shellCommandActive: true })).toBe(false);
  });
});

describe("echoConfirmsLine", () => {
  it("passes through when the screen is unreadable (conservative fallback)", () => {
    expect(echoConfirmsLine(null, "ls -la")).toBe(true);
  });

  it("accepts when the screen echoes the model line inside the prompt line", () => {
    expect(echoConfirmsLine("user@host:~$ kubectl get pods", "kubectl get pods")).toBe(true);
  });

  it("accepts tab-completion lines: the screen extends the typed prefix", () => {
    expect(echoConfirmsLine("user@host:~$ ls file.txt", "ls ")).toBe(true);
  });

  it("accepts wrapped commands: the logical line collects continuation rows", () => {
    expect(echoConfirmsLine("echo 'long command ' + 'continues here'", "echo 'long command ' + 'continues here'")).toBe(true);
  });

  it("rejects hidden-input prompts (sudo/ssh password never echoes)", () => {
    expect(echoConfirmsLine("[sudo] password for jin:", "MyS3cret!")).toBe(false);
    expect(echoConfirmsLine("jin@host's password:", "hunter2")).toBe(false);
  });

  it("rejects blank model lines even when the screen has text", () => {
    expect(echoConfirmsLine("user@host:~$ ", "")).toBe(false);
  });
});

describe("extractEchoedCommand (issue #169: capture what the shell actually runs)", () => {
  it("returns the completed command, not the typed prefix", () => {
    // 键入 `cd blen` + Tab：模型停在 `cd blen`，屏幕上已是补全结果。
    expect(extractEchoedCommand("user@host:~$ cd blender/", "cd blen")).toBe("cd blender/");
  });

  it("returns the model line as-is when nothing extended it", () => {
    expect(extractEchoedCommand("user@host:~$ kubectl get pods", "kubectl get pods")).toBe("kubectl get pods");
  });

  it("anchors at the first occurrence so prompt text before the command is dropped", () => {
    expect(extractEchoedCommand("user@host:~$ ls file.txt", "ls ")).toBe("ls file.txt");
  });

  it("trims trailing whitespace the completion left before the cursor", () => {
    expect(extractEchoedCommand("user@host:~$ git status  ", "git status")).toBe("git status");
  });

  it("falls back to null when the screen is unreadable (caller keeps the model line)", () => {
    expect(extractEchoedCommand(null, "ls -la")).toBeNull();
  });

  it("falls back to null on blank model lines", () => {
    expect(extractEchoedCommand("user@host:~$ ", "")).toBeNull();
    expect(extractEchoedCommand("user@host:~$ ", "   ")).toBeNull();
  });

  it("defensively returns null when the line is not on the screen (gate should have rejected)", () => {
    expect(extractEchoedCommand("user@host:~$ something else", "kubectl get pods")).toBeNull();
  });
});
