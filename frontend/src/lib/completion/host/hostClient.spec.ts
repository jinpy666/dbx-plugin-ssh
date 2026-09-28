import { describe, expect, it, vi } from "vitest";
import {
  COMPLETION_BRIDGE_TIMEOUT_MARGIN_MS,
  COMPLETION_DEFAULT_MAX_OUTPUT_BYTES,
  COMPLETION_DEFAULT_TIMEOUT_MS,
  COMPLETION_EXECUTE_METHOD,
  clampCompletionMaxOutputBytes,
  clampCompletionTimeoutMs,
  createCompletionHostClient,
} from "./hostClient";
import type { CompletionExecuteRequest, CompletionExecuteResult } from "./protocol";

const validRequest: CompletionExecuteRequest = {
  target: { kind: "ssh", sessionId: "session-1" },
  command: "git",
  args: ["branch", "--format=%(refname:short)"],
  cwd: "/repo",
  timeoutMs: 1200,
  maxOutputBytes: 262_144,
  mode: "completion-generator",
};

const validResult: CompletionExecuteResult = {
  exitCode: 0,
  stdout: "main\nmaster\n",
  stderr: "",
  truncated: false,
  timedOut: false,
};

function fakeInvoke(result: unknown) {
  return vi.fn(async (_method: string, _params?: unknown, _options?: { timeoutMs?: number }) => result);
}

describe("createCompletionHostClient（注入式 Fake 桥）", () => {
  it("happy path：方法名/规范化请求/桥超时余量正确，结果透传", async () => {
    const invoke = vi.fn(async () => validResult);
    const client = createCompletionHostClient(invoke);
    await expect(client.execute(validRequest)).resolves.toEqual(validResult);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      COMPLETION_EXECUTE_METHOD,
      validRequest,
      { timeoutMs: 1200 + COMPLETION_BRIDGE_TIMEOUT_MARGIN_MS },
    );
  });

  it("默认值：timeoutMs/maxOutputBytes/cwd 缺省收敛为 1200 / 256KiB / null", async () => {
    const invoke = fakeInvoke(validResult);
    const client = createCompletionHostClient(invoke);
    await client.execute({
      target: { kind: "local", sessionId: "s" },
      command: "printf",
      args: ["hi"],
      cwd: undefined,
      timeoutMs: undefined as unknown as number,
      maxOutputBytes: undefined as unknown as number,
      mode: "completion-generator",
    });
    const [, params] = invoke.mock.calls[0]!;
    expect(params).toMatchObject({
      cwd: null,
      timeoutMs: COMPLETION_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: COMPLETION_DEFAULT_MAX_OUTPUT_BYTES,
    });
  });

  it("clamp：timeoutMs 越界收紧到 [200, 3000]，非有限数取缺省", async () => {
    expect(clampCompletionTimeoutMs(undefined)).toBe(1200);
    expect(clampCompletionTimeoutMs(null)).toBe(1200);
    expect(clampCompletionTimeoutMs(Number.NaN)).toBe(1200);
    expect(clampCompletionTimeoutMs(50)).toBe(200);
    expect(clampCompletionTimeoutMs(200)).toBe(200);
    expect(clampCompletionTimeoutMs(3000)).toBe(3000);
    expect(clampCompletionTimeoutMs(5000)).toBe(3000);

    const invoke = fakeInvoke(validResult);
    const client = createCompletionHostClient(invoke);
    await client.execute({ ...validRequest, timeoutMs: 50, maxOutputBytes: 1 });
    const [, params] = invoke.mock.calls[0]!;
    expect(params).toMatchObject({ timeoutMs: 200, maxOutputBytes: 1 });
  });

  it("clamp：maxOutputBytes 非正/超上限收敛；1024 保留", () => {
    expect(clampCompletionMaxOutputBytes(undefined)).toBe(COMPLETION_DEFAULT_MAX_OUTPUT_BYTES);
    expect(clampCompletionMaxOutputBytes(Number.NaN)).toBe(COMPLETION_DEFAULT_MAX_OUTPUT_BYTES);
    expect(clampCompletionMaxOutputBytes(0)).toBe(COMPLETION_DEFAULT_MAX_OUTPUT_BYTES);
    expect(clampCompletionMaxOutputBytes(-5)).toBe(COMPLETION_DEFAULT_MAX_OUTPUT_BYTES);
    expect(clampCompletionMaxOutputBytes(1024)).toBe(1024);
    expect(clampCompletionMaxOutputBytes(1024 ** 3)).toBe(COMPLETION_DEFAULT_MAX_OUTPUT_BYTES);
    expect(clampCompletionMaxOutputBytes(100.9)).toBe(100);
  });

  it("mode 恒覆写为 completion-generator", async () => {
    const invoke = fakeInvoke(validResult);
    const client = createCompletionHostClient(invoke);
    await client.execute({ ...validRequest, mode: "evil" as unknown as "completion-generator" });
    const [, params] = invoke.mock.calls[0]!;
    expect((params as CompletionExecuteRequest).mode).toBe("completion-generator");
  });

  it("请求畸形（target/command/args 不合法）→ null 且不触桥", async () => {
    const invoke = vi.fn(async () => validResult);
    const client = createCompletionHostClient(invoke);
    await expect(
      client.execute({ ...validRequest, target: { kind: "wsl", sessionId: "s" } as never }),
    ).resolves.toBeNull();
    await expect(client.execute({ ...validRequest, command: "  " })).resolves.toBeNull();
    await expect(client.execute({ ...validRequest, args: [1] as unknown as string[] })).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("桥 reject / 同步 throw → null 降级，绝不 throw", async () => {
    const rejecting = createCompletionHostClient(async () => {
      throw new Error("bridge gone");
    });
    await expect(rejecting.execute(validRequest)).resolves.toBeNull();

    const throwing = createCompletionHostClient(() => {
      throw new Error("sync boom");
    });
    await expect(throwing.execute(validRequest)).resolves.toBeNull();
  });

  it("无注入且环境无宿主桥（node 测试环境 window.dbxPlugin 缺失）→ null", async () => {
    const client = createCompletionHostClient();
    await expect(client.execute(validRequest)).resolves.toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["字符串", "main"],
    ["空对象", {}],
    ["缺 stdout", { exitCode: 0, stderr: "", truncated: false, timedOut: false }],
    ["exitCode 类型错", { exitCode: "0", stdout: "", stderr: "", truncated: false, timedOut: false }],
    ["truncated 类型错", { exitCode: 0, stdout: "", stderr: "", truncated: 1, timedOut: false }],
    ["timedOut 缺失", { exitCode: null, stdout: "", stderr: "", truncated: false }],
  ])("返回畸形（%s）→ null", async (_name, raw) => {
    const client = createCompletionHostClient(fakeInvoke(raw));
    await expect(client.execute(validRequest)).resolves.toBeNull();
  });

  it("timedOut 语义保留：结构合法的超时结果原样返回，null 判定交给上层", async () => {
    const timedOut: CompletionExecuteResult = {
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: true,
    };
    const client = createCompletionHostClient(fakeInvoke(timedOut));
    await expect(client.execute(validRequest)).resolves.toEqual(timedOut);
  });
});
