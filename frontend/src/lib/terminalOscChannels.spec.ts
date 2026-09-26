import { describe, expect, it } from "vitest";
import {
  OSC_NOTIFY_BODY_MAX,
  USER_VAR_NAME_MAX,
  USER_VAR_PAYLOAD_MAX,
  USER_VAR_VALUE_MAX,
  cwdFromUserVar,
  parseOsc1337SetUserVar,
  parseOsc777Notify,
  parseOsc9Notification,
  shouldOsc7FollowOverrideUserVarCwd,
} from "./terminalOscChannels";

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("parseOsc777Notify", () => {
  it("splits notify;title;body", () => {
    expect(parseOsc777Notify("notify;Build;done in 3s")).toEqual({ title: "Build", body: "done in 3s" });
  });

  it("keeps a body-only form (kitty fallback) with empty title", () => {
    expect(parseOsc777Notify("notify;finished")).toEqual({ title: "", body: "finished" });
  });

  it("ignores non-notify kinds (whitelist semantics)", () => {
    expect(parseOsc777Notify("progress;50")).toBeNull();
    expect(parseOsc777Notify("")).toBeNull();
    expect(parseOsc777Notify("notify;")).toBeNull();
    expect(parseOsc777Notify("notify;;")).toBeNull();
  });

  it("collapses newlines and truncates overlong title/body instead of dropping", () => {
    // 无第二个分号 → body-only 形态（标题留空），换行压成空格。
    const multi = parseOsc777Notify("notify;a\nb\rc\nd");
    expect(multi).toEqual({ title: "", body: "a b c d" });
    const longBody = parseOsc777Notify(`notify;t;${"x".repeat(OSC_NOTIFY_BODY_MAX + 10)}`);
    expect(longBody?.body.length).toBe(OSC_NOTIFY_BODY_MAX + 1); // +1 = 省略号
    expect(longBody?.body.endsWith("…")).toBe(true);
  });
});

describe("parseOsc9Notification", () => {
  it("wraps the payload as a title-less body", () => {
    expect(parseOsc9Notification("job 42 finished")).toEqual({ title: "", body: "job 42 finished" });
  });

  it("rejects empty/whitespace payloads and truncates", () => {
    expect(parseOsc9Notification("")).toBeNull();
    expect(parseOsc9Notification("  \n ")).toBeNull();
    const long = parseOsc9Notification("y".repeat(OSC_NOTIFY_BODY_MAX + 5));
    expect(long?.body.endsWith("…")).toBe(true);
    expect(long && long.body.length <= OSC_NOTIFY_BODY_MAX + 1).toBe(true);
  });
});

describe("parseOsc1337SetUserVar", () => {
  it("round-trips the iTerm2 SetUserVar form", () => {
    expect(parseOsc1337SetUserVar(`SetUserVar=cwd=${b64("/home/u/我的 项目")}`)).toEqual({
      name: "cwd",
      value: "/home/u/我的 项目",
    });
  });

  it("tolerates whitespace inside the base64 payload", () => {
    const wrapped = b64("/tmp/x").replace(/(.{4})/g, "$1\n");
    expect(parseOsc1337SetUserVar(`SetUserVar=cwd=${wrapped}`)?.value).toBe("/tmp/x");
  });

  it("returns null for foreign 1337 payloads so they fall through", () => {
    // 内联图像（ImageAddon 通道）与 iTerm2 直通 CurrentDir 都不是 SetUserVar。
    expect(parseOsc1337SetUserVar("File=name=a.gif;size=2;inline=1:AAAA")).toBeNull();
    expect(parseOsc1337SetUserVar("CurrentDir=/tmp")).toBeNull();
    expect(parseOsc1337SetUserVar("")).toBeNull();
  });

  it("rejects malformed or oversized payloads defensively", () => {
    expect(parseOsc1337SetUserVar("SetUserVar=no-separator")).toBeNull();
    expect(parseOsc1337SetUserVar(`SetUserVar=${b64("x")}`)).toBeNull(); // 空名
    expect(parseOsc1337SetUserVar(`SetUserVar=${"n".repeat(USER_VAR_NAME_MAX + 1)}=${b64("x")}`)).toBeNull();
    expect(parseOsc1337SetUserVar(`SetUserVar=cwd=${"A".repeat(USER_VAR_PAYLOAD_MAX + 1)}`)).toBeNull();
    expect(parseOsc1337SetUserVar("SetUserVar=cwd=!!!not-base64!!!")).toBeNull();
    // 解码后超限整体忽略
    const big = b64("/" + "d".repeat(USER_VAR_VALUE_MAX));
    expect(big.length).toBeLessThanOrEqual(USER_VAR_PAYLOAD_MAX);
    expect(parseOsc1337SetUserVar(`SetUserVar=cwd=${big}`)).toBeNull();
  });
});

describe("cwdFromUserVar", () => {
  it("accepts the common shell-integration names with POSIX absolute paths", () => {
    expect(cwdFromUserVar("cwd", "/var/log")).toBe("/var/log");
    expect(cwdFromUserVar("CurrentDir", "/srv")).toBe("/srv");
    expect(cwdFromUserVar("currentdir", "/srv")).toBe("/srv");
    expect(cwdFromUserVar("cwd", "  /srv/app  ")).toBe("/srv/app");
  });

  it("rejects foreign names, relative paths and control characters", () => {
    expect(cwdFromUserVar("host", "/srv")).toBeNull();
    expect(cwdFromUserVar("cwd", "relative/path")).toBeNull();
    expect(cwdFromUserVar("cwd", "C:\\Users")).toBeNull();
    expect(cwdFromUserVar("cwd", "/a\nb")).toBeNull();
    expect(cwdFromUserVar("cwd", "/a\0b")).toBeNull();
    expect(cwdFromUserVar("cwd", "")).toBeNull();
  });
});

describe("shouldOsc7FollowOverrideUserVarCwd", () => {
  const userVar = { path: "/a", at: 1000 };

  it("follows OSC 7 when no user-var channel exists (fallback unchanged)", () => {
    expect(shouldOsc7FollowOverrideUserVarCwd(null, "/b", 999)).toBe(true);
  });

  it("follows OSC 7 when both channels agree", () => {
    expect(shouldOsc7FollowOverrideUserVarCwd(userVar, "/a", 0)).toBe(true);
  });

  it("defers to the fresher event on disagreement", () => {
    // SetUserVar 刚在 cd 时上报（先于提示符 OSC 7）：OSC 7 的旧值不得回踩。
    expect(shouldOsc7FollowOverrideUserVarCwd(userVar, "/old", 900)).toBe(false);
    // 提示符时刻的 OSC 7 更晚：提示符真实 cwd 胜出（回落生效）。
    expect(shouldOsc7FollowOverrideUserVarCwd(userVar, "/old", 1000)).toBe(true);
  });
});
