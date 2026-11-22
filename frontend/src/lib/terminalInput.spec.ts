import { describe, expect, it } from "vitest";
import {
  normalizeTerminalInputBytes,
  normalizeTerminalInputText,
  shellKindFromProgramName,
  terminalLineEraseSequence,
} from "./terminalInput";

describe("normalizeTerminalInputText", () => {
  it("keeps backslash continuations while converting every newline to PTY Enter", () => {
    const command = [
      "llamafactory-cli api \\",
      "--model_name_or_path ~/.cache/modelscope/hub/models/Qwen/Qwen3/ \\",
      "--adapter_name_or_path ./saves/Qwen3/lora/train_2026-09-16-15-00-42 \\",
      "--finetuning_type lora \\",
      "--template qwen3",
    ].join("\n");

    expect(normalizeTerminalInputText(command)).toBe(command.replaceAll("\n", "\r"));
    expect(normalizeTerminalInputText("a\r\nb\rc\nd")).toBe("a\rb\rc\rd");
  });
});

describe("normalizeTerminalInputBytes", () => {
  it("normalizes pasted newlines without decoding terminal bytes", () => {
    const input = Uint8Array.from([0x1b, 0x5b, 0x41, 0x0d, 0x0a, 0x78, 0x0a, 0xff]);
    expect(Array.from(normalizeTerminalInputBytes(input))).toEqual([
      0x1b, 0x5b, 0x41, 0x0d, 0x78, 0x0d, 0xff,
    ]);
  });
});

describe("terminalLineEraseSequence", () => {
  it("keeps the Ctrl+U erase for POSIX/unknown shells", () => {
    expect(terminalLineEraseSequence(null, 4)).toBe("\u0015");
  });

  it("uses Ctrl+Home/Ctrl+End for PowerShell whose PSReadLine does not bind Ctrl+U", () => {
    // issue #317：PSReadLine Windows 编辑模式默认不绑定 Ctrl+U，\u0015 清行
    // 是 no-op，回填文本变成追加。Ctrl+Home→行首 + Ctrl+End→删到行尾
    // （Windows 模式默认绑定 BackwardDeleteLine/ForwardDeleteLine）。
    expect(terminalLineEraseSequence("powershell", 4)).toBe("\u001b[1;5H\u001b[1;5F");
  });

  it("erases the tracked model with backspaces for cmd", () => {
    expect(terminalLineEraseSequence("cmd", 4)).toBe("\b\b\b\b");
    expect(terminalLineEraseSequence("cmd", 0)).toBe("");
  });
});

describe("shellKindFromProgramName", () => {
  it("maps Windows shell program paths to line-erase capability kinds", () => {
    expect(shellKindFromProgramName("pwsh.exe")).toBe("powershell");
    expect(shellKindFromProgramName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
    expect(shellKindFromProgramName("powershell.exe")).toBe("powershell");
    expect(shellKindFromProgramName("C:\\Windows\\system32\\cmd.exe")).toBe("cmd");
    expect(shellKindFromProgramName("/bin/zsh")).toBe(null);
    expect(shellKindFromProgramName(undefined)).toBe(null);
  });
});
