// 输出脱敏/截断/ANSI 剥离单测（Warp AI 对齐批）：对抗样例钉死脱敏面，
// 快照管线的隐私承诺（IMPL_PLAN_WARP_AI_TERMINAL §4.3）靠这组用例守。
import { describe, expect, it } from "vitest";
import { AI_OUTPUT_MAX_CHARS, AI_OUTPUT_MAX_LINES, prepareAiOutputSnapshot, redactTerminalOutput, stripAnsiEscapes, truncateTail } from "./outputRedaction";

describe("truncateTail", () => {
  it("行数超限取尾部", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
    const out = truncateTail(text);
    expect(out.split("\n")).toHaveLength(AI_OUTPUT_MAX_LINES);
    expect(out).toContain("line-299");
    expect(out).not.toContain("line-0\n");
  });

  it("字符超限取尾部且不超上限", () => {
    const text = "x".repeat(40_000);
    expect(truncateTail(text).length).toBeLessThanOrEqual(AI_OUTPUT_MAX_CHARS);
    expect(truncateTail("ab".repeat(AI_OUTPUT_MAX_CHARS))).toHaveLength(AI_OUTPUT_MAX_CHARS);
  });

  it("空串原样返回", () => {
    expect(truncateTail("")).toBe("");
  });
});

describe("redactTerminalOutput", () => {
  it("键值对抹值留键名（shell 导出/YAML/日志形）", () => {
    expect(redactTerminalOutput("export DB_PASSWORD=hunter2")).toBe("export DB_PASSWORD=***");
    expect(redactTerminalOutput('password: "s3cret"')).toBe('password: ***');
    expect(redactTerminalOutput("api_key=abc123def456")).toBe("api_key=***");
    expect(redactTerminalOutput("clientSecret: very-quiet")).toBe("clientSecret: ***");
  });

  it("独立令牌整段替换", () => {
    expect(redactTerminalOutput("Authorization: Bearer eyJhbGci.abc.def")).toBe("Authorization: ***");
    expect(redactTerminalOutput("AKIAIOSFODNN7EXAMPLE")).toBe("***");
    expect(redactTerminalOutput("token: ghp_" + "a".repeat(36))).toBe("token: ***");
    expect(redactTerminalOutput("OPENAI_API_KEY=sk-" + "x".repeat(30))).toContain("***");
    expect(redactTerminalOutput("xoxb-123456-abcdef")).toBe("***");
  });

  it("PEM 私钥整块抹掉（含换行）", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nmore\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactTerminalOutput(`before\n${pem}\nafter`)).toBe("before\n***\nafter");
  });

  it("URL 内嵌凭据保留 scheme 抹 user:pass", () => {
    expect(redactTerminalOutput("clone https://alice:s3cret@github.com/x/y.git")).toBe("clone https://***@github.com/x/y.git");
  });

  it("普通命令与输出不受影响（无误伤）", () => {
    const plain = "total 48\ndrwxr-xr-x 5 root root 4096 Oct 1 12:00 .\n-rw-r--r-- 1 root root 220 Jan 6 token\n";
    expect(redactTerminalOutput(plain)).toBe(plain);
  });

  it("幂等：*** 不再命中任何模式", () => {
    const once = redactTerminalOutput("password=hunter2 Bearer abc.def");
    expect(redactTerminalOutput(once)).toBe(once);
  });
});

describe("stripAnsiEscapes", () => {
  it("剥 OSC 响（633 帧）与 CSI 序列，折叠 \\r", () => {
    const noisy = "\u001b]633;D;2\u0007\u001b[0m$ \u001b[1;32m✓\u001b[0m ok\r\nnext";
    expect(stripAnsiEscapes(noisy)).toBe("$ ✓ ok\nnext");
  });

  it("剥 BEL 与 ST 两种 OSC 终止形", () => {
    expect(stripAnsiEscapes("\u001b]633;E;cmd\u0007out")).toBe("out");
    expect(stripAnsiEscapes("\u001b]633;E;cmd\u001b\\out")).toBe("out");
  });
});

describe("prepareAiOutputSnapshot", () => {
  it("先截断后脱敏（组合语义）", () => {
    const long = Array.from({ length: 300 }, (_, i) => (i === 299 ? "password=zoh" : `row-${i}`)).join("\n");
    const out = prepareAiOutputSnapshot(long);
    expect(out.split("\n")).toHaveLength(AI_OUTPUT_MAX_LINES);
    expect(out).toContain("password=***");
    expect(out).not.toContain("zoh");
  });
});
