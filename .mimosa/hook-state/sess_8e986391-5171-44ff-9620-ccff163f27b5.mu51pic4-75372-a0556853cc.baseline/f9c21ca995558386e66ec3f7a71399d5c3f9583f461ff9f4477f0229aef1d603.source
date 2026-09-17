import { describe, expect, it } from "vitest";
import { commandInputAction, pushCommandHistory } from "./commandHistory";

describe("command input keyboard behavior", () => {
  const base = {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    selectionStart: 0,
    selectionEnd: 0,
    valueLength: 10,
  };

  it("keeps plain Enter available for multiline commands", () => {
    expect(commandInputAction({ ...base, key: "Enter" })).toBe("none");
    expect(commandInputAction({ ...base, key: "Enter", shiftKey: true })).toBe("none");
  });

  it("uses Ctrl/Cmd+Enter to submit", () => {
    expect(commandInputAction({ ...base, key: "Enter", ctrlKey: true })).toBe("run");
    expect(commandInputAction({ ...base, key: "Enter", metaKey: true })).toBe("run");
    expect(commandInputAction({ ...base, key: "Enter", ctrlKey: true, shiftKey: true })).toBe("none");
  });

  it("only captures history arrows at the editor edges", () => {
    expect(commandInputAction({ ...base, key: "ArrowUp" })).toBe("history-up");
    expect(commandInputAction({ ...base, key: "ArrowDown", selectionStart: 10, selectionEnd: 10 })).toBe("history-down");
    expect(commandInputAction({ ...base, key: "ArrowUp", selectionStart: 4, selectionEnd: 4 })).toBe("none");
    expect(commandInputAction({ ...base, key: "ArrowDown", selectionStart: 4, selectionEnd: 4 })).toBe("none");
    expect(commandInputAction({ ...base, key: "ArrowUp", selectionEnd: 2 })).toBe("none");
  });
});

describe("command history", () => {
  it("keeps multiline commands intact for in-session reruns", () => {
    const command = ["llamafactory-cli api \\", "--model_name_or_path ~/.cache/modelscope/hub/models/Qwen/Qwen3/"].join("\n");
    expect(pushCommandHistory([], command)).toEqual([command]);
  });
});
