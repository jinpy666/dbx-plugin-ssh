import { describe, expect, it } from "vitest";
import {
  buildTranscript,
  formatTranscriptStamp,
  stripAnsiSequences,
  transcriptFileName,
} from "./transcript";

describe("stripAnsiSequences", () => {
  it("strips SGR color sequences but keeps the text", () => {
    expect(stripAnsiSequences("\x1b[31mERROR\x1b[0m: boom")).toBe("ERROR: boom");
  });

  it("strips OSC sequences with BEL and ST terminators", () => {
    expect(stripAnsiSequences("\x1b]0;title\x07keep")).toBe("keep");
    expect(stripAnsiSequences("\x1b]8;;http://x\x1b\\link")).toBe("link");
  });

  it("drops CR and lone escapes without eating following text", () => {
    expect(stripAnsiSequences("a\rb")).toBe("ab");
    expect(stripAnsiSequences("a\x1bZb")).toBe("ab");
    expect(stripAnsiSequences("tail\x1b")).toBe("tail");
  });

  it("passes plain text through untouched", () => {
    expect(stripAnsiSequences("hello\nworld")).toBe("hello\nworld");
    expect(stripAnsiSequences("")).toBe("");
  });
});

describe("formatTranscriptStamp", () => {
  it("formats seconds as [h:mm:ss]", () => {
    expect(formatTranscriptStamp(0)).toBe("[0:00:00]");
    expect(formatTranscriptStamp(754.7)).toBe("[0:12:34]");
    expect(formatTranscriptStamp(3661)).toBe("[1:01:01]");
    expect(formatTranscriptStamp(-3)).toBe("[0:00:00]");
  });
});

describe("buildTranscript", () => {
  it("concatenates stdout chunks preserving the terminal line layout", () => {
    const events = [
      { time: 0, type: "o", data: "user@host:~$ ls\r\n" },
      { time: 1, type: "o", data: "a.txt  b.log\r\n" },
      { time: 2, type: "o", data: "user@host:~$ " },
    ];
    // 内容按终端原样保留（含提示符尾随空格），仅补末尾换行。
    expect(buildTranscript(events)).toBe("user@host:~$ ls\na.txt  b.log\nuser@host:~$ \n");
  });

  it("skips non-output events and empty recordings stay empty", () => {
    expect(buildTranscript([{ time: 1, type: "i", data: "typed" }])).toBe("");
    expect(buildTranscript([])).toBe("");
  });

  it("strips escapes so hidden text still reads cleanly", () => {
    const events = [{ time: 0, type: "o", data: "\x1b[1;32mSUCCESS\x1b[0m\r\n" }];
    expect(buildTranscript(events)).toBe("SUCCESS\n");
  });

  it("timestamps each new line when requested", () => {
    const events = [
      { time: 0, type: "o", data: "first\r\n" },
      { time: 5.4, type: "o", data: "second" },
    ];
    expect(buildTranscript(events, { timestamps: true })).toBe(
      "[0:00:00]first\n[0:00:05]second\n",
    );
  });
});

describe("transcriptFileName", () => {
  it("derives a .txt name from the recording id", () => {
    expect(transcriptFileName("rec-1")).toBe("rec-1.txt");
    expect(transcriptFileName("")).toBe("session.txt");
  });
});
