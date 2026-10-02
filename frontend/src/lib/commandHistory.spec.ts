import { describe, expect, it } from "vitest";
import { commandInputAction, mergeShellHistory, parseShellHistoryText, persistableCommandHistoryBuckets, pushCommandHistory, sanitizeCommandHistoryBuckets } from "./commandHistory";

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

describe("parseShellHistoryText", () => {
  it("keeps plain bash history lines in file order (oldest on top)", () => {
    expect(parseShellHistoryText("ls -la\nkubectl get pods\n")).toEqual(["ls -la", "kubectl get pods"]);
  });

  it("strips zsh EXTENDED_HISTORY metadata prefixes", () => {
    expect(parseShellHistoryText(": 1700000000:0;vim /etc/nginx.conf\n: 1700000005:3;systemctl restart nginx")).toEqual([
      "vim /etc/nginx.conf",
      "systemctl restart nginx",
    ]);
  });

  it("joins backslash continuation lines into one command", () => {
    expect(parseShellHistoryText("tail -n 100 /var/log/syslog \\\n  | grep -i error\ndone-cmd")).toEqual([
      "tail -n 100 /var/log/syslog   | grep -i error",
      "done-cmd",
    ]);
  });

  it("keeps literal double-backslash tails and drops empty lines", () => {
    expect(parseShellHistoryText('echo "path\\\\" \n\n   \nnext')).toEqual(['echo "path\\\\"', "next"]);
  });
});

describe("mergeShellHistory", () => {
  it("appends unseen remote history after the session ring, newest of the two at the front", () => {
    const merged = mergeShellHistory(["git status"], ["old-cmd", "newer-cmd"]);
    expect(merged).toEqual(["git status", "newer-cmd", "old-cmd"]);
  });

  it("skips commands already in the ring, secrets and over-long lines", () => {
    const secret = "mysql -u root --password=hunter2";
    const merged = mergeShellHistory(["git status", "old-cmd"], ["old-cmd", secret, "x".repeat(250), "keep-me"]);
    // keep-me 是远端补充,插在环尾(更旧端)。
    expect(merged).toEqual(["git status", "old-cmd", "keep-me"]);
  });

  it("caps the merged ring at the limit", () => {
    const current = ["a", "b"];
    const remote = Array.from({ length: 120 }, (_, i) => `remote-${i}`);
    const merged = mergeShellHistory(current, remote, 100);
    expect(merged).toHaveLength(100);
    expect(merged[0]).toBe("a");
    // 远端补充按新旧插在环尾:最旧的被截掉(122 条截到 100,丢 r0..r21)。
    expect(merged[99]).toBe("remote-22");
  });
});

describe("sanitizeCommandHistoryBuckets", () => {
  it("migrates the legacy global ring into the legacy scope", () => {
    expect(sanitizeCommandHistoryBuckets(["echo a", "echo b"], { legacyScope: "local" })).toEqual({ local: ["echo a", "echo b"] });
  });

  it("drops junk and empty legacy rings", () => {
    expect(sanitizeCommandHistoryBuckets(null, { legacyScope: "local" })).toEqual({});
    expect(sanitizeCommandHistoryBuckets("not an array", { legacyScope: "local" })).toEqual({});
    expect(sanitizeCommandHistoryBuckets(["", "   "], { legacyScope: "local" })).toEqual({});
  });

  it("sanitizes each scope bucket independently", () => {
    const raw = {
      "conn-1": ["kubectl get pods", "x".repeat(250)],
      "conn-2": "junk",
      "": ["dropped-empty-scope"],
    };
    expect(sanitizeCommandHistoryBuckets(raw, { legacyScope: "local" })).toEqual({ "conn-1": ["kubectl get pods"] });
  });
});

describe("persistableCommandHistoryBuckets", () => {
  it("filters secret-like and over-long commands per bucket and drops empty buckets", () => {
    const secret = "mysql -u root --password=hunter2";
    const buckets = {
      "conn-1": ["keep-me", secret, "x".repeat(250)],
      "conn-2": [secret],
    };
    expect(persistableCommandHistoryBuckets(buckets)).toEqual({ "conn-1": ["keep-me"] });
  });
});
