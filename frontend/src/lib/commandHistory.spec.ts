import { describe, expect, it } from "vitest";
import { mergeShellHistory, parseShellHistoryText, persistableCommandHistoryBuckets, pushCommandHistory, sanitizeCommandHistoryBuckets, sanitizeCommandHistoryLimit, trimCommandHistoryBuckets } from "./commandHistory";

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

// —— 历史条数可配置（issue #192）：环上限归一化 + 收紧时逐桶裁剪 + 环/合并
// 按上限截断。默认保持 100（COMMAND_HISTORY_LIMIT）不变。
describe("sanitizeCommandHistoryLimit (issue #192)", () => {
  it("defaults to 100 on garbage input", () => {
    expect(sanitizeCommandHistoryLimit(undefined)).toBe(100);
    expect(sanitizeCommandHistoryLimit(null)).toBe(100);
    expect(sanitizeCommandHistoryLimit("abc")).toBe(100);
    expect(sanitizeCommandHistoryLimit(Number.NaN)).toBe(100);
  });

  it("accepts numeric strings and clamps to the configured bounds", () => {
    expect(sanitizeCommandHistoryLimit("250")).toBe(250);
    expect(sanitizeCommandHistoryLimit(500)).toBe(500);
    expect(sanitizeCommandHistoryLimit(3)).toBe(10);
    expect(sanitizeCommandHistoryLimit("0")).toBe(10);
    expect(sanitizeCommandHistoryLimit(99999)).toBe(1000);
    expect(sanitizeCommandHistoryLimit(12.9)).toBe(12);
  });
});

describe("trimCommandHistoryBuckets (issue #192)", () => {
  it("trims each bucket to the new limit from the oldest tail and drops emptied buckets", () => {
    const buckets = {
      "conn-1": ["newest", "mid", "oldest"],
      "conn-2": ["only"],
    };
    expect(trimCommandHistoryBuckets(buckets, 2)).toEqual({ "conn-1": ["newest", "mid"], "conn-2": ["only"] });
    expect(trimCommandHistoryBuckets(buckets, 0)).toEqual({});
  });

  it("leaves buckets untouched when the limit grows", () => {
    const buckets = { "conn-1": ["a", "b"] };
    expect(trimCommandHistoryBuckets(buckets, 100)).toEqual(buckets);
  });
});

describe("configurable limit threading (issue #192)", () => {
  it("pushCommandHistory truncates to the configured limit", () => {
    const history = pushCommandHistory(["b", "a"], "c", 2);
    expect(history).toEqual(["c", "b"]);
  });

  it("sanitizeCommandHistoryBuckets truncates hydrated buckets to the configured limit", () => {
    const raw = { "conn-1": ["a", "b", "c"] };
    expect(sanitizeCommandHistoryBuckets(raw, { legacyScope: "local" }, 2)).toEqual({ "conn-1": ["a", "b"] });
  });

  it("mergeShellHistory truncates the merged ring to the configured limit", () => {
    // shellLines 旧→新；合并后新命令靠前（["z", "c", "b", "a"]），截断丢最旧的 "a"。
    const merged = mergeShellHistory(["z"], ["a", "b", "c"], 3);
    expect(merged).toEqual(["z", "c", "b"]);
  });
});
