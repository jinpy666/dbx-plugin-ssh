// @vitest-environment happy-dom
// 终端应答矩阵的实测锚点（WT-2 审计批）：用真实 xterm 内核（@xterm/xterm
// 6.1.0-beta.304）驱动 parser，把 docs/TEST_MATRIX.zh-CN.md「终端应答矩阵」
// 一节里「应答/忽略」的每一行锁成可回归的断言。内核行为一变，这里先红——
// 文档就不至于悄悄失真。终端无需 open()：parser/缓冲在 write 路径即可用。
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

async function feed(terminal: Terminal, data: string): Promise<void> {
  terminal.write(data);
  // write 是异步排空的，等一拍让 parser 跑完、onData 派发完。
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function terminalWithCollector() {
  const replies: string[] = [];
  const terminal = new Terminal({ allowProposedApi: true });
  terminal.onData((data) => replies.push(data));
  return { terminal, replies };
}

describe("xterm core answers (measured, TEST_MATRIX 终端应答矩阵)", () => {
  it("DSR 5 (CSI 5n) answers ESC[0n", async () => {
    const { terminal, replies } = terminalWithCollector();
    await feed(terminal, "\x1b[5n");
    expect(replies).toEqual(["\x1b[0n"]);
  });

  it("DSR 6 (CSI 6n) answers the cursor position ESC[row;colR", async () => {
    const { terminal, replies } = terminalWithCollector();
    await feed(terminal, "\x1b[6n");
    expect(replies).toEqual(["\x1b[1;1R"]);
    replies.length = 0;
    // 移动光标后坐标跟随（真实行/列，1 起）。
    await feed(terminal, "\x1b[3;5H\x1b[6n");
    expect(replies).toEqual(["\x1b[3;5R"]);
  });

  it("Primary DA (CSI c / CSI 0c) answers ESC[?1;2c (VT100+AVO)", async () => {
    const { terminal, replies } = terminalWithCollector();
    await feed(terminal, "\x1b[c");
    await feed(terminal, "\x1b[0c");
    expect(replies).toEqual(["\x1b[?1;2c", "\x1b[?1;2c"]);
  });

  it("Secondary DA (CSI >c) answers; DA3 (CSI =c) stays silent", async () => {
    const { terminal, replies } = terminalWithCollector();
    await feed(terminal, "\x1b[>c");
    expect(replies).toHaveLength(1);
    // 版本号随内核演进变化，锁形状：ESC[>0;<version>;0c
    expect(replies[0]).toMatch(/^\x1b\[>0;\d+;0c$/);
    replies.length = 0;
    await feed(terminal, "\x1b[=c");
    expect(replies).toEqual([]);
  });

  it("kitty CSI ? u gets no core reply (plugin handler in terminalModeQueries answers)", async () => {
    const { terminal, replies } = terminalWithCollector();
    await feed(terminal, "\x1b[?u");
    expect(replies).toEqual([]);
  });
});

describe("SGR colon forms on the shared render path (measured)", () => {
  it("4:3 curliest underline lands in cell attributes and stays zero-width", async () => {
    const { terminal } = terminalWithCollector();
    await feed(terminal, "A\x1b[4:3mB\x1b[0mC");
    const line = terminal.buffer.active.getLine(0)!;
    expect(line.translateToString(true)).toBe("ABC");
    // isUnderline() 实测返回数值位（0/1）而非布尔，按真值断言。
    expect(line.getCell(0)!.isUnderline()).toBeFalsy();
    expect(line.getCell(1)!.isUnderline()).toBeTruthy();
    expect(line.getCell(2)!.isUnderline()).toBeFalsy();
  });

  it("38:2::r:g:b (ITU colon RGB) and legacy 38;2;r;g;b both store true RGB", async () => {
    const { terminal } = terminalWithCollector();
    await feed(terminal, "\x1b[38:2::10:20:30mX\x1b[0m\x1b[38;2;10;20;30mY\x1b[0m");
    const line = terminal.buffer.active.getLine(0)!;
    expect(line.translateToString(true)).toBe("XY");
    // RGB 单元 getFgColor 返回 24bit 打包值（0x0A141E = 10/20/30）。
    const packed = (10 << 16) | (20 << 8) | 30;
    expect(line.getCell(0)!.getFgColor()).toBe(packed);
    expect(line.getCell(1)!.getFgColor()).toBe(packed);
    expect(line.getCell(0)!.getFgColorMode()).toBe(line.getCell(1)!.getFgColorMode());
  });

  it("colon SGR consumes zero columns, so decoration column offsets stay aligned", async () => {
    // 自研绘制路径（关键词高亮/动作链接 decoration）按
    // `buffer.getLine(row).translateToString()` 的纯文本列偏移定位；
    // 这里锁死"冒号 SGR 不占列"这一前提——前提一破，装饰会整体错位。
    const { terminal } = terminalWithCollector();
    await feed(terminal, "\x1b[4:3m\x1b[38:2::1:2:3mERROR\x1b[0m: disk full");
    const text = terminal.buffer.active.getLine(0)!.translateToString(true);
    expect(text).toBe("ERROR: disk full");
    expect(text.indexOf("disk")).toBe(7);
  });
});

describe("8-bit C1 bytes in UTF-8 mode (measured, design stance input)", () => {
  it("a bare 0x9B byte acts as a C1-CSI introducer, not invalid UTF-8", async () => {
    const { terminal } = terminalWithCollector();
    // GBK 堡垒机风险面：内核把 C1 区间字节当控制码解释（0x9B=CSI），
    // `4m` 被整个吞掉且 B 被加下划线——不是按 UTF-8 非法字节回退。
    await feed(terminal, "A\x9b4mB");
    const line = terminal.buffer.active.getLine(0)!;
    expect(line.translateToString(true)).toBe("AB");
    expect(line.getCell(1)!.isUnderline()).toBeTruthy();
  });
});

describe("unhandled OSC 9/777/1337 are consumed silently (measured)", () => {
  it("no visible text, no onData when the plugin registers no handler", async () => {
    const replies: string[] = [];
    const terminal = new Terminal();
    terminal.onData((data) => replies.push(data));
    await feed(terminal, "\x1b]9;hello\x07X\x1b]777;notify;T;Body\x1b\\Y\x1b]1337;SetUserVar=cwd=aGk=\x07Z");
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe("XYZ");
    expect(replies).toEqual([]);
  });
});
