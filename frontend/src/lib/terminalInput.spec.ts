import { describe, expect, it } from "vitest";
import { normalizeTerminalInputBytes, normalizeTerminalInputText } from "./terminalInput";

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
