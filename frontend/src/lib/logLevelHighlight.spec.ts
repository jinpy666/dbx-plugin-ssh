// logLevelHighlight 单测（issue #224 第 2 条）：纯函数全覆盖。
// 覆盖 classifyLogLevelLine（级别词/空白容忍/大小写/整词边界）、
// classifyLogLines（堆栈续行继承、空行与顶格普通行的归属规则、行内加重区间）、
// isLogFileName（.log/.out/.err 后缀与反例）。装饰器本身依赖真实 CodeMirror
// 文档对象，数据全部来自 classifyLogLines 纯函数，单测不构造 EditorView。

import { describe, expect, it } from "vitest";
import { classifyLogLevelLine, classifyLogLines, isLogFileName } from "./logLevelHighlight";

describe("classifyLogLevelLine", () => {
  it("maps ERROR/FATAL to error in any case", () => {
    expect(classifyLogLevelLine("ERROR boom")).toBe("error");
    expect(classifyLogLevelLine("error: connection refused")).toBe("error");
    expect(classifyLogLevelLine("Error - something broke")).toBe("error");
    expect(classifyLogLevelLine("FATAL: unrecoverable")).toBe("error");
    expect(classifyLogLevelLine("fatal error")).toBe("error");
    expect(classifyLogLevelLine("FaTaL x")).toBe("error");
  });

  it("maps WARN/WARNING to warn", () => {
    expect(classifyLogLevelLine("WARN disk almost full")).toBe("warn");
    expect(classifyLogLevelLine("WARNING deprecated option")).toBe("warn");
    expect(classifyLogLevelLine("warn")).toBe("warn");
    expect(classifyLogLevelLine("warning")).toBe("warn");
    expect(classifyLogLevelLine("Warning: retrying")).toBe("warn");
  });

  it("maps DEBUG/TRACE to debug", () => {
    expect(classifyLogLevelLine("DEBUG entered handler")).toBe("debug");
    expect(classifyLogLevelLine("trace: sql=select 1")).toBe("debug");
    expect(classifyLogLevelLine("Trace ID 42")).toBe("debug");
    expect(classifyLogLevelLine("debug")).toBe("debug");
  });

  it("maps INFO/NOTICE to info", () => {
    expect(classifyLogLevelLine("INFO server started")).toBe("info");
    expect(classifyLogLevelLine("notice: config reloaded")).toBe("info");
    expect(classifyLogLevelLine("Notice")).toBe("info");
    expect(classifyLogLevelLine("info")).toBe("info");
  });

  it("tolerates leading whitespace including tabs", () => {
    expect(classifyLogLevelLine("   ERROR boom")).toBe("error");
    expect(classifyLogLevelLine("\t\tdebug: x")).toBe("debug");
    expect(classifyLogLevelLine(" \t warn y")).toBe("warn");
  });

  it("accepts common separators after the level token", () => {
    expect(classifyLogLevelLine("ERROR: x")).toBe("error");
    expect(classifyLogLevelLine("ERROR[12345] x")).toBe("error");
    expect(classifyLogLevelLine("warn|svc")).toBe("warn");
  });

  it("returns null for lines without a leading level token", () => {
    expect(classifyLogLevelLine("")).toBe(null);
    expect(classifyLogLevelLine("   ")).toBe(null);
    expect(classifyLogLevelLine("plain message")).toBe(null);
    expect(classifyLogLevelLine("2024-01-01 ERROR late")).toBe(null);
    expect(classifyLogLevelLine("something ERROR mid-line")).toBe(null);
  });

  it("requires the level token to be a whole word", () => {
    expect(classifyLogLevelLine("ERRORX oops")).toBe(null);
    expect(classifyLogLevelLine("errors happened")).toBe(null);
    expect(classifyLogLevelLine("error2024-01-01")).toBe(null);
    expect(classifyLogLevelLine("Informational message")).toBe(null);
    expect(classifyLogLevelLine("warnings detected")).toBe(null);
    expect(classifyLogLevelLine("Traceroute done")).toBe(null);
  });

  it("accepts the token at end of line", () => {
    expect(classifyLogLevelLine("ERROR")).toBe("error");
    expect(classifyLogLevelLine("  info")).toBe("info");
  });
});

describe("classifyLogLines", () => {
  it("assigns each level to its own line", () => {
    const levels = classifyLogLines([
      "INFO starting",
      "DEBUG details",
      "WARN slow query",
      "ERROR failed",
      "plain line",
    ]).map((entry) => entry.level);
    expect(levels).toEqual(["info", "debug", "warn", "error", null]);
  });

  it("inherits the previous level for indented stack frames after an error", () => {
    const classified = classifyLogLines([
      "ERROR unhandled exception",
      "\tat com.example.Service.run(Service.java:12)",
      "        at com.example.Main.main(Main.java:5)",
      "INFO shutdown",
    ]);
    expect(classified.map((entry) => entry.level)).toEqual(["error", "error", "error", "info"]);
  });

  it("inherits the previous level for python-style tracebacks", () => {
    const classified = classifyLogLines([
      "INFO boot",
      "ERROR Traceback (most recent call last):",
      '  File "app.py", line 10, in <module>',
      "    raise ValueError(x)",
    ]);
    expect(classified.map((entry) => entry.level)).toEqual(["info", "error", "error", "error"]);
  });

  it("inherits warn and debug levels for continuations too", () => {
    expect(classifyLogLines(["warning w", "    at x"]).map((entry) => entry.level)).toEqual(["warn", "warn"]);
    expect(classifyLogLines(["TRACE t", "  details..."]).map((entry) => entry.level)).toEqual(["debug", "debug"]);
  });

  it("keeps inheritance across blank lines but does not decorate them", () => {
    const classified = classifyLogLines(["ERROR a", "", "\tat b"]);
    expect(classified.map((entry) => entry.level)).toEqual(["error", null, "error"]);
  });

  it("stops inheritance at a column-0 line without a level token", () => {
    const classified = classifyLogLines(["ERROR a", "plain reset line", "\tat b"]);
    expect(classified.map((entry) => entry.level)).toEqual(["error", null, null]);
  });

  it("leaves leading continuations uncolored before any level line", () => {
    expect(classifyLogLines(["  orphan frame", "INFO x"]).map((entry) => entry.level)).toEqual([null, "info"]);
  });

  it("restarts inheritance at a new level token inside an indented block", () => {
    const classified = classifyLogLines(["ERROR outer", "\tCaused by FATAL inner", "\tmore of fatal"]);
    // "\tCaused by FATAL inner" 行首即级别词（空白容忍）→ error；
    // 下一续行继承 error。
    expect(classified.map((entry) => entry.level)).toEqual(["error", "error", "error"]);
  });

  it("marks the leading token on error lines at its absolute offsets", () => {
    expect(classifyLogLines(["ERROR bad"]).map((entry) => entry.marks)).toEqual([[{ start: 0, end: 5 }]]);
    expect(classifyLogLines(["  error bad"]).map((entry) => entry.marks)).toEqual([[{ start: 2, end: 7 }]]);
    expect(classifyLogLevelLine("\tFATAL x")).toBe("error");
    expect(classifyLogLines(["\tFATAL x"]).map((entry) => entry.marks)).toEqual([[{ start: 1, end: 6 }]]);
  });

  it("marks uppercase ERROR/FATAL words on non-error lines without recoloring them", () => {
    const classified = classifyLogLines(["INFO saw ERROR 500 upstream", "notice FATAL in module"]);
    expect(classified[0].level).toBe("info");
    expect(classified[0].marks).toEqual([{ start: 9, end: 14 }]);
    expect(classified[1].level).toBe("info");
    expect(classified[1].marks).toEqual([{ start: 7, end: 12 }]);
  });

  it("does not mark lowercase or partial keywords", () => {
    const classified = classifyLogLines(["info: the error happened", "plain errory text"]);
    expect(classified[0].marks).toEqual([]);
    expect(classified[1].marks).toEqual([]);
  });

  it("keeps the leading-token mark when it is already uppercase", () => {
    // 行首大写 ERROR：行首词与全行扫描命中同一区间，只留一个 mark。
    const marks = classifyLogLines(["ERROR: duplicated"])[0].marks;
    expect(marks).toEqual([{ start: 0, end: 5 }]);
  });

  it("marks keywords on continuation lines", () => {
    const classified = classifyLogLines(["ERROR outer", "\tat FATAL depth"]);
    expect(classified[1].level).toBe("error");
    expect(classified[1].marks).toEqual([{ start: 4, end: 9 }]);
  });

  it("collects multiple marks per line in order", () => {
    const marks = classifyLogLines(["plain ERROR then FATAL end"])[0].marks;
    expect(marks).toEqual([
      { start: 6, end: 11 },
      { start: 17, end: 22 },
    ]);
  });
});

describe("isLogFileName", () => {
  it("accepts .log/.out/.err in any case", () => {
    expect(isLogFileName("app.log")).toBe(true);
    expect(isLogFileName("APP.LOG")).toBe(true);
    expect(isLogFileName("build.Out")).toBe(true);
    expect(isLogFileName("stderr.eRR")).toBe(true);
    expect(isLogFileName("nohup.out")).toBe(true);
  });

  it("accepts names inside POSIX and Windows paths", () => {
    expect(isLogFileName("/var/log/sys.log")).toBe(true);
    expect(isLogFileName("logs/audit.err")).toBe(true);
    expect(isLogFileName("C:\\logs\\app.LOG")).toBe(true);
  });

  it("rejects non-log extensions and extension-less names", () => {
    expect(isLogFileName("")).toBe(false);
    expect(isLogFileName("app.txt")).toBe(false);
    expect(isLogFileName("app")).toBe(false);
    expect(isLogFileName("logfile")).toBe(false);
    expect(isLogFileName("log")).toBe(false);
    expect(isLogFileName("a.errx")).toBe(false);
  });

  it("only honors the last extension segment", () => {
    expect(isLogFileName("app.log.1")).toBe(false);
    expect(isLogFileName("app.log.bak")).toBe(false);
    expect(isLogFileName("out.txt.log")).toBe(true);
  });

  it("does not treat a bare hidden name as an extension", () => {
    expect(isLogFileName(".log")).toBe(false);
    expect(isLogFileName(".out")).toBe(false);
  });
});
