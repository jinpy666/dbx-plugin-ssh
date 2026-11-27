// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { useDockerTerminal } from "./useDockerTerminal";

function outputFrame(sequence: number, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(9 + body.length);
  new DataView(bytes.buffer).setBigUint64(1, BigInt(sequence), false);
  bytes.set(body, 9);
  return bytes;
}

function base64(text: string): string {
  return btoa(text);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("useDockerTerminal", () => {
  it("subscribes before open, routes only its channel, and sends input on its own channel", async () => {
    const binaryListeners: Array<(event: { channel: string; data?: Uint8Array }) => void> = [];
    const eventListeners: Array<(event: { method: string; params?: Record<string, unknown> }) => void> = [];
    const sent: Array<{ channel: string; data: Uint8Array }> = [];
    const invocations: Array<{ method: string; params: Record<string, unknown> }> = [];
    const seen: Uint8Array[] = [];

    const host = {
      invoke: async (method: string, params: Record<string, unknown>) => {
        invocations.push({ method, params });
        if (method === "docker/terminal/open") {
          return {
            terminalId: params.requestedTerminalId,
            containerId: params.containerId,
            shell: "auto",
            cols: 80,
            rows: 24,
            sequence: 0,
            replay: [{ sequence: 1, dataBase64: base64("replay") }],
          };
        }
        return { success: true };
      },
      onBinary: (listener: (event: { channel: string; data?: Uint8Array }) => void) => {
        binaryListeners.push(listener);
        return () => undefined;
      },
      onEvent: (listener: (event: { method: string; params?: Record<string, unknown> }) => void) => {
        eventListeners.push(listener);
        return () => undefined;
      },
      sendBinary: async (channel: string, data: Uint8Array) => {
        sent.push({ channel, data });
      },
      decodeBase64: (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
    } as unknown as typeof window.dbxPlugin;

    const scope = effectScope();
    const handle = scope.run(() =>
      useDockerTerminal({
        onData: (data) => seen.push(data),
        api: () => host,
        invoke: (method, params) => host.invoke(method, params),
      }),
    )!;

    const opened = await handle.open({ target: "local", containerId: "d4a7c9f1e2b3", shell: "auto" });
    expect(opened).toBe(true);
    const requested = handle.terminalId.value;
    expect(requested.startsWith("docker-term-")).toBe(true);
    expect(invocations[0].method).toBe("docker/terminal/open");
    expect(invocations[0].params.requestedTerminalId).toBe(requested);

    // 订阅先于 RPC：监听器在 open 返回前就已登记。
    expect(binaryListeners).toHaveLength(1);

    // 容器帧生效；ssh 通道帧被丢弃。
    binaryListeners[0]({ channel: `docker/terminal/out/${requested}`, data: outputFrame(2, "live") });
    binaryListeners[0]({ channel: "ssh/terminal/out/visual-session", data: outputFrame(3, "ssh") });
    await settle();
    const text = seen.map((data) => new TextDecoder().decode(data)).join("");
    expect(text).toBe("replaylive");

    // 键入只发 docker/terminal/in/{id}，并带 8 字节序号。
    handle.sendInput(new TextEncoder().encode("echo ok\r"));
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(`docker/terminal/in/${requested}`);
    expect(new DataView(sent[0].data.buffer, sent[0].data.byteOffset, 8).getBigUint64(0, false)).toBe(1n);
    expect(new TextDecoder().decode(sent[0].data.slice(8))).toBe("echo ok\r");

    // end 后不再接收帧。
    eventListeners[0]({
      method: "docker/terminal/end",
      params: { terminalId: requested, reason: "exited", exitCode: 0 },
    });
    expect(handle.active.value).toBe(false);
    expect(handle.endedReason.value).toBe("exited");
    expect(handle.exitCode.value).toBe(0);
    binaryListeners[0]({ channel: `docker/terminal/out/${requested}`, data: outputFrame(4, "late") });
    await settle();
    expect(seen.map((data) => new TextDecoder().decode(data)).join("")).toBe("replaylive");

    await handle.close();
    scope.stop();
  });
});
