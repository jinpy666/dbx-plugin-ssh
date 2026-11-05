// issue #270：自动重连后恢复原工作目录。断开即销毁会话（ssh.rs 移除
// registry），重连 spawn 的全新 shell 从 home 启动；cwd 的唯一权威来源是
// 终端侧 OSC 7 / OSC 633 / OSC 1337 上报的 terminalCwd（跨重连存活）。
// buildRestoreCwdCommand 把该路径构造成注入新 PTY stdin 的 cd 命令——
// 走与用户键入相同的输入队列。安全守卫：单引号转义（安全红线口径）、
// `-` 开头路径加 ./ 前缀防选项解析（不引入 --，兼容 fish/PowerShell/csh）、
// 控制字符与超长路径直接放弃注入（静默降级为现状行为）。
import { describe, expect, it } from "vitest";
import { buildRestoreCwdCommand } from "./terminalReconnect";

describe("buildRestoreCwdCommand", () => {
  it("普通绝对路径 → 单引号包裹的 cd 命令，尾部带回车", () => {
    expect(buildRestoreCwdCommand("/root/app/service")).toBe("cd '/root/app/service'\r");
  });

  it("含空格路径在单引号内保持字面量", () => {
    expect(buildRestoreCwdCommand("/root/my dir")).toBe("cd '/root/my dir'\r");
  });

  it("含单引号路径按 '\\'' 转义（安全红线口径）", () => {
    expect(buildRestoreCwdCommand("/root/it's")).toBe("cd '/root/it'\\''s'\r");
  });

  it("- 开头路径加 ./ 前缀防被解析为选项", () => {
    expect(buildRestoreCwdCommand("-data")).toBe("cd './-data'\r");
  });

  it("含换行等控制字符 → 放弃注入（返回 null）", () => {
    expect(buildRestoreCwdCommand("/root/a\nb")).toBeNull();
    expect(buildRestoreCwdCommand("/root/a\tb")).toBeNull();
    expect(buildRestoreCwdCommand("/root/a\u0000b")).toBeNull();
  });

  it("空串与超长路径 → 放弃注入（返回 null）", () => {
    expect(buildRestoreCwdCommand("")).toBeNull();
    expect(buildRestoreCwdCommand("   ")).toBeNull();
    expect(buildRestoreCwdCommand("/" + "a".repeat(4096))).toBeNull();
  });
});
