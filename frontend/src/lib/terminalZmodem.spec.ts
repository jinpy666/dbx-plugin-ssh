import { describe, expect, it, vi } from "vitest";
import {
  createZmodemDetectionFeeder,
  createZmodemSentry,
  decideZmodemDetection,
  mergeZmodemChunks,
  receiveZmodemSession,
  sanitizeZmodemFileName,
  sendZmodemFiles,
  validTransferOffset,
  type ZmodemSentryHandlers,
} from "./terminalZmodem";

function stubDetection(role: string) {
  return {
    get_session_role: () => role,
    deny: vi.fn(),
    confirm: vi.fn(),
  };
}

describe("zmodem detection decision", () => {
  it("confirms a send-role session while an upload is pending", () => {
    const decision = decideZmodemDetection(stubDetection("send"), true);
    expect(decision).toEqual({ action: "confirm", role: "send" });
  });

  it("confirms a receive-role session when downloads are allowed (sz auto-receive)", () => {
    const decision = decideZmodemDetection(stubDetection("receive"), false, true);
    expect(decision).toEqual({ action: "confirm", role: "receive" });
  });

  it("prompts instead of denying a send-role session with no pending files when peer-rz prompts are on (issue #171)", () => {
    // 经典 lrzsz rz：远端手敲 rz → 完整 hex ZRINIT → send 角色检测；无待传
    // 文件时不再立即 deny，改为提示用户 opt-in。
    expect(decideZmodemDetection(stubDetection("send"), false, true, { promptPeerRz: true })).toEqual({ action: "prompt-upload" });
    // 关闭提示恢复既有语义。
    expect(decideZmodemDetection(stubDetection("send"), false, true)).toEqual({ action: "deny", reason: "roleMismatch" });
    // 已有待传文件时提示开关不影响既有路径。
    expect(decideZmodemDetection(stubDetection("send"), true, true, { promptPeerRz: true })).toEqual({ action: "confirm", role: "send" });
  });

  it("denies a receive-role session while an upload is pending (upload owns the stream)", () => {
    const detection = stubDetection("receive");
    const decision = decideZmodemDetection(detection, true, true);
    expect(decision).toEqual({ action: "deny", reason: "uploadPending" });
    // The decision is pure; the caller must invoke deny() so the peer's sz
    // terminates via the abort sequence instead of hanging the wire.
    expect(detection.deny).not.toHaveBeenCalled();
  });

  it("denies a receive-role session when downloads are unavailable (trzsz owns the stream)", () => {
    expect(decideZmodemDetection(stubDetection("receive"), false, false)).toEqual({ action: "deny", reason: "roleMismatch" });
  });

  it("denies a send-role offer when nothing is queued locally (unrequested rz)", () => {
    const decision = decideZmodemDetection(stubDetection("send"), false);
    expect(decision).toEqual({ action: "deny", reason: "roleMismatch" });
  });

  it("classifies unrecognized roles against the same table", () => {
    // zmodem.js may surface roles other than the canonical send/receive pair
    // (e.g. "unknown" on a half-opened session, or differently cased text).
    // Only the exact canonical roles may ever be confirmed.
    expect(decideZmodemDetection(stubDetection("unknown"), true)).toEqual({ action: "deny", reason: "uploadPending" });
    expect(decideZmodemDetection(stubDetection("unknown"), false)).toEqual({ action: "deny", reason: "roleMismatch" });
    expect(decideZmodemDetection(stubDetection(""), true)).toEqual({ action: "deny", reason: "uploadPending" });
    expect(decideZmodemDetection(stubDetection("Send"), true)).toEqual({ action: "deny", reason: "uploadPending" });
  });
});

describe("sanitizeZmodemFileName (path-injection guard)", () => {
  it("strips POSIX and Windows path segments to the final basename", () => {
    expect(sanitizeZmodemFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeZmodemFileName("..\\..\\windows\\system32\\evil.exe")).toBe("evil.exe");
    expect(sanitizeZmodemFileName("/tmp/report.pdf")).toBe("report.pdf");
    expect(sanitizeZmodemFileName("C:\\Users\\x\\data.csv")).toBe("data.csv");
    expect(sanitizeZmodemFileName("a/../b/../../c.txt")).toBe("c.txt");
  });

  it("falls back to a safe name for empty or traversal-only offers", () => {
    expect(sanitizeZmodemFileName("")).toBe("download");
    expect(sanitizeZmodemFileName("..")).toBe("download");
    expect(sanitizeZmodemFileName(".")).toBe("download");
    expect(sanitizeZmodemFileName("///")).toBe("download");
  });

  it("removes control characters and Windows-illegal glyphs", () => {
    expect(sanitizeZmodemFileName("a\u0000b\u001fc.txt")).toBe("abc.txt");
    expect(sanitizeZmodemFileName('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
    expect(sanitizeZmodemFileName("name\u007f.txt")).toBe("name.txt");
  });

  it("neutralizes Windows reserved device names and trailing dots/spaces", () => {
    expect(sanitizeZmodemFileName("con")).toBe("_con");
    expect(sanitizeZmodemFileName("con.txt")).toBe("_con.txt");
    expect(sanitizeZmodemFileName("COM1.tar.gz")).toBe("_COM1.tar.gz");
    expect(sanitizeZmodemFileName("name. ")).toBe("name");
    expect(sanitizeZmodemFileName("normal-name_1.0.tar.bz2")).toBe("normal-name_1.0.tar.bz2");
  });

  it("caps pathological lengths while keeping the result usable", () => {
    const long = `${"a".repeat(500)}.bin`;
    const sanitized = sanitizeZmodemFileName(long);
    expect(sanitized.length).toBeLessThanOrEqual(180);
    expect(sanitized.startsWith("aaa")).toBe(true);
    expect(sanitized).not.toBe("download");
  });
});

describe("receiveZmodemSession", () => {
  function stubSession() {
    const handlers = new Map<string, (...args: never[]) => void>();
    return {
      on: vi.fn((event: string, callback: (...args: never[]) => void) => {
        handlers.set(event, callback);
        return undefined;
      }),
      has_ended: () => false,
      start: vi.fn(() => Promise.resolve()),
      emit: (event: string, ...args: never[]) => handlers.get(event)?.(...args),
    };
  }

  it("starts the session: the ZRINIT invite is emitted by start(), not confirm()", async () => {
    // zmodem.js's Receive.start() is what sends the opening ZRINIT; a receive
    // session that is only confirm()ed stays silent and the remote sz times
    // out. Regression guard for the skipped-start bug found against real
    // lrzsz in the docker smoke.
    const session = stubSession();
    receiveZmodemSession(session as never, vi.fn());
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  it("resolves once the session ends and forwards offers to the handler", async () => {
    const session = stubSession();
    const onOffer = vi.fn();
    const done = receiveZmodemSession(session as never, onOffer);
    session.emit("offer", { get_details: () => ({ name: "x" }) } as never);
    await Promise.resolve();
    expect(onOffer).toHaveBeenCalledTimes(1);
    session.emit("session_end");
    await expect(done).resolves.toEqual({});
  });

  it("resolves with the error when an offer handler throws (wire must not hang)", async () => {
    const session = stubSession();
    const done = receiveZmodemSession(session as never, () => {
      throw new Error("save failed");
    });
    session.emit("offer", {} as never);
    await expect(done).resolves.toEqual({ error: expect.any(Error) });
  });

  it("resolves immediately for a session that already ended", async () => {
    const session = stubSession();
    session.has_ended = () => true;
    await expect(receiveZmodemSession(session as never, vi.fn())).resolves.toEqual({});
  });

  it("waits for the in-flight offer handler before settling session_end (issue #336)", async () => {
    // sz 传完最后一块后 ZFIN/"OO" 两轮往返就触发 session_end，而落盘保存
    // （同步 base64 + local/saveFile IPC）还在途。结算若不等处理器，
    // useZmodem 的完成回调会在 savedFileCount 仍为 0 时读数——进度走完、
    // 文件落盘，但成功提示/自动定位目录被静默跳过（issue #336）。
    const session = stubSession();
    let releaseHandler!: () => void;
    const onOffer = vi.fn(() => new Promise<void>((resolve) => {
      releaseHandler = resolve;
    }));
    const done = receiveZmodemSession(session as never, onOffer);
    session.emit("offer", {} as never);
    await vi.waitFor(() => expect(onOffer).toHaveBeenCalledTimes(1));
    session.emit("session_end");
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    // 处理器未结算前，session_end 不得兑现（旧实现此时已 settle）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseHandler();
    await expect(done).resolves.toEqual({});
  });

  it("resolves with the handler error when a handler rejects after session_end", async () => {
    const session = stubSession();
    let rejectHandler!: (cause: Error) => void;
    const onOffer = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    const done = receiveZmodemSession(session as never, onOffer);
    session.emit("offer", {} as never);
    await vi.waitFor(() => expect(onOffer).toHaveBeenCalledTimes(1));
    session.emit("session_end");
    rejectHandler(new Error("late save failure"));
    await expect(done).resolves.toEqual({ error: expect.any(Error) });
  });
});

describe("mergeZmodemChunks", () => {
  it("concatenates spooled chunks byte-exactly and handles empty spools", () => {
    const merged = mergeZmodemChunks([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3, 4, 5])]);
    expect([...merged]).toEqual([1, 2, 3, 4, 5]);
    expect(mergeZmodemChunks([]).byteLength).toBe(0);
  });
});

describe("validTransferOffset clamping", () => {
  it("accepts in-range offsets and clamps adversarial values to zero", () => {
    expect(validTransferOffset({ get_offset: () => 4096 } as never, 8192)).toBe(4096);
    expect(validTransferOffset({ get_offset: () => 0 } as never, 8192)).toBe(0);
    // Negative offsets (hostile/corrupt peer) never underflow the resume base.
    expect(validTransferOffset({ get_offset: () => -1 } as never, 8192)).toBe(0);
    // Offsets beyond the file size would hang the chunk loop forever.
    expect(validTransferOffset({ get_offset: () => 9000 } as never, 8192)).toBe(0);
    expect(validTransferOffset({ get_offset: () => Number.NaN } as never, 8192)).toBe(0);
    expect(validTransferOffset({ get_offset: () => Number.POSITIVE_INFINITY } as never, 8192)).toBe(0);
  });
});

describe("createZmodemSentry", () => {
  it("returns a usable sentry wired to the caller's handlers", () => {
    const handlers: ZmodemSentryHandlers = {
      send: vi.fn(),
      toTerminal: vi.fn(),
      onDetect: vi.fn(),
      onRetract: vi.fn(),
    };
    const sentry = createZmodemSentry(handlers);
    expect(sentry).toBeDefined();
  });
});

describe("sendZmodemFiles", () => {
  it("rejects when the session is aborted mid-transfer", async () => {
    // The abort check fires inside the chunk loop, i.e. only after the peer
    // accepted the offer: a rejected offer skips the file instead.
    const transfer = {
      get_offset: () => 0,
      send: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      aborted: () => true,
      send_offer: vi.fn().mockResolvedValue(transfer),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    const file = new File([new Uint8Array(8)], "a.bin");
    await expect(sendZmodemFiles(session, [file])).rejects.toThrow("ZMODEM session aborted");
  });

  it("skips a file whose offer was rejected and still closes the session", async () => {
    const session = {
      aborted: () => false,
      send_offer: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    const file = new File([new Uint8Array(4)], "b.bin");
    await sendZmodemFiles(session, [file]);
    expect((session as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });
});


// —— 经典 lrzsz rz 握手检测（issue #171）——
// lrzsz 的首个 ZMODEM 帧恒为 hex 形态（`**` + CAN + 'B' + hex 帧体 + hex CRC16）；
// zmodem.js 的 sentry 以 COMMON_ZM_HEX_START（`**\x18B0`）作门槛后走完整
// 帧解析 + CRC 校验——这里用真实帧字节验证检测分界。

/** CRC-16/CCITT-FALSE（ZMODEM 帧校验：poly 0x1021、init 0、非反射——与
 *  zmodem.js zcrc.js 同款）。 */
function zmodemCrc16(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
  }
  return crc & 0xffff;
}

/** 构造合法（或指定破坏 CRC 的）hex 首帧：type=ZRINIT(0x01)/ZRQINIT(0x00)。 */
function hexFirstFrame(type: number, corruptCrc = false): number[] {
  // 能力位（ZF3=0x03 = CANFDX|CANOVIO）：zmodem.js 的 Send 会话构造校验
  // 全双工/重叠 IO，缺位会直接 throw（lrzsz 真机帧亦带这两个能力位）。
  const raw = [type, 0x00, 0x00, 0x00, 0x03];
  let crc = zmodemCrc16(raw);
  if (corruptCrc) crc ^= 0xffff;
  // CRC 拆高/低两字节再转 hex（合成一个数字会丢前导零 → 奇数位 hex 解析 NaN）。
  const hex = [...raw, (crc >> 8) & 0xff, crc & 0xff].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const bytes: number[] = [0x2a, 0x2a, 0x18, 0x42]; // ** CAN B
  for (const char of hex) bytes.push(char.charCodeAt(0));
  // lrzsz 的 hex 帧以 CR LF 结尾（帧解析以此定界）。
  bytes.push(0x0d, 0x0a);
  return bytes;
}

describe("hex ZRINIT detection (classic lrzsz rz, issue #171)", () => {
  function makeSentry() {
    const onDetect = vi.fn();
    const handlers: ZmodemSentryHandlers = {
      send: vi.fn(),
      toTerminal: vi.fn(),
      onDetect,
      onRetract: vi.fn(),
    };
    return { onDetect, handlers, sentry: createZmodemSentry(handlers) };
  }

  it("detects a real lrzsz rz handshake (hex ZRINIT) as a send-role session", () => {
    const { onDetect, handlers, sentry } = makeSentry();
    // rz 打印横幅后紧跟 hex ZRINIT（同一帧切片内到达）。
    const banner = [...new TextEncoder().encode("rz\r\nrz waiting to receive.\r\n")];
    sentry.consume(new Uint8Array([...banner, ...hexFirstFrame(0x01)]).buffer);
    expect(handlers.onDetect).toHaveBeenCalledTimes(1);
    const detection = onDetect.mock.calls[0][0] as { get_session_role(): string };
    expect(detection.get_session_role()).toBe("send");
  });

  it("detects across fragmented chunks (header split over consecutive frames)", () => {
    const { handlers, sentry } = makeSentry();
    const frame = [...hexFirstFrame(0x01)];
    sentry.consume(new Uint8Array([0x2a, 0x2a, 0x18]).buffer);
    sentry.consume(new Uint8Array(frame.slice(3)).buffer);
    expect(handlers.onDetect).toHaveBeenCalledTimes(1);
  });

  it("does not detect a corrupted-CRC hex frame (宁漏勿误)", () => {
    const { handlers, sentry } = makeSentry();
    sentry.consume(new Uint8Array(hexFirstFrame(0x01, true)).buffer);
    expect(handlers.onDetect).not.toHaveBeenCalled();
  });

  it("does not detect ordinary text that merely contains the ** prefix", () => {
    const { handlers, sentry } = makeSentry();
    const text = [...new TextEncoder().encode("echo '**\x18B0' && ls -la\r\n** random hex 0123456789abcdef\r\n")];
    sentry.consume(new Uint8Array(text).buffer);
    expect(handlers.onDetect).not.toHaveBeenCalled();
  });

  it("keeps the sz direction working: hex ZRQINIT detects as a receive-role session", () => {
    const { onDetect, handlers, sentry } = makeSentry();
    sentry.consume(new Uint8Array(hexFirstFrame(0x00)).buffer);
    expect(handlers.onDetect).toHaveBeenCalledTimes(1);
    const detection = onDetect.mock.calls[0][0] as { get_session_role(): string };
    expect(detection.get_session_role()).toBe("receive");
  });
});

/**
 * 检测定界器（issue #307）：zmodem.js 的会话检测只在「hex 首帧恰为本次
 * consume burst 的末尾」时发出；#302 合帧后尾部杂字节跟在同一 burst 里会让
 * 该次检测永久丢失（首帧字节已从 sentry 缓存剔除、哨兵随之湮灭），远端 sz
 * 就再也收不到 ZRINIT——界面上既无进度也无完成反馈。定界器把完整 hex 首帧
 * 切成独立 burst，恢复逐帧时代的确定性。
 */
describe("createZmodemDetectionFeeder (merged-burst detection guard, issue #307)", () => {
  const BANNER = [...new TextEncoder().encode("sz waiting to send.\r\n")];
  const TRAILING = [...new TextEncoder().encode("background output\r\n")];

  function latin1(bytes: readonly number[] | Uint8Array): string {
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }

  /** 真实接收路径：检测即确认（useZmodem 的 receive 分支同款）。 */
  function makeFeeder() {
    const onDetect = vi.fn((detection: { confirm(): unknown }) => detection.confirm());
    const toTerminal: string[] = [];
    const sentry = createZmodemSentry({
      send: vi.fn(),
      toTerminal: (data) => toTerminal.push(latin1(data)),
      onDetect: onDetect as never,
      onRetract: vi.fn(),
    });
    const feeder = createZmodemDetectionFeeder((chunk) => sentry.consume(chunk.slice().buffer));
    return { onDetect, toTerminal, feeder };
  }

  it("isolates a complete ZRQINIT header so detection survives merged trailing output", () => {
    const { onDetect, toTerminal, feeder } = makeFeeder();
    const merged = [...BANNER, ...hexFirstFrame(0x00), ...TRAILING];
    feeder.feed(new Uint8Array(merged));
    expect(onDetect).toHaveBeenCalledTimes(1);
    const detection = onDetect.mock.calls[0][0] as unknown as { get_session_role(): string };
    expect(detection.get_session_role()).toBe("receive");
    // 哨兵前的显示字节不受影响，照常上屏。
    expect(toTerminal.join("")).toContain("sz waiting to send.");
  });

  it("carries a sentinel split across feed boundaries and still detects", () => {
    const { onDetect, feeder } = makeFeeder();
    const header = hexFirstFrame(0x00);
    feeder.feed(new Uint8Array([...BANNER, 0x2a, 0x2a, 0x18]));
    expect(onDetect).not.toHaveBeenCalled();
    feeder.feed(new Uint8Array([0x42, ...header.slice(4), ...TRAILING]));
    expect(onDetect).toHaveBeenCalledTimes(1);
  });

  it("holds an incomplete header until the next feed completes it", () => {
    const { onDetect, feeder } = makeFeeder();
    const header = hexFirstFrame(0x00);
    feeder.feed(new Uint8Array([...BANNER, ...header.slice(0, 14)]));
    expect(onDetect).not.toHaveBeenCalled();
    feeder.feed(new Uint8Array([...header.slice(14), ...TRAILING]));
    expect(onDetect).toHaveBeenCalledTimes(1);
  });

  it("releases a false sentinel (broken shape) without stalling later output", () => {
    const { onDetect, toTerminal, feeder } = makeFeeder();
    // 文件直出等场景里的假哨兵：`**\x18B` 后不是合法 hex 头。
    const junk = [...new TextEncoder().encode("cat **\x18Bzz.. not a header\r\n")];
    feeder.feed(new Uint8Array(junk));
    expect(onDetect).not.toHaveBeenCalled();
    feeder.feed(new Uint8Array(TRAILING));
    // 假哨兵不得滞留字节：后续输出完整上屏。
    expect(toTerminal.join("")).toContain(latin1(TRAILING));
  });

  it("passes plain display bytes through untouched on the fast path", () => {
    const { onDetect, toTerminal, feeder } = makeFeeder();
    feeder.feed(new Uint8Array([...BANNER]));
    feeder.feed(new Uint8Array([...TRAILING]));
    expect(onDetect).not.toHaveBeenCalled();
    expect(toTerminal.join("")).toBe(latin1([...BANNER, ...TRAILING]));
  });
});
