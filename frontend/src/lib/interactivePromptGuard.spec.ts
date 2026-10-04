import { describe, expect, it } from "vitest";
import { interactivePromptNearCursor, isAuthChallengeLine, isInteractivePromptLine, isInteractivePromptPending, isSelectionPromptLine } from "./interactivePromptGuard";

describe("isAuthChallengeLine", () => {
  it("matches waiting-for-code prompt lines (colon-terminated keyword lines)", () => {
    for (const line of [
      "[OTP Code]:", // koko 待输入行
      "OTP:",
      "MFA code:",
      "Please enter MFA code:",
      "One-Time Password:",
      "2FA verification code:",
      "Two-factor authentication code:",
      "验证码:",
      "请输入验证码:",
      "动态口令:",
      "动态令牌:",
      "双因子认证:",
    ]) {
      expect(isAuthChallengeLine(line), line).toBe(true);
    }
  });

  it("matches imperative instruction lines without a trailing colon", () => {
    for (const line of ["Please Enter MFA Code.", "Enter the verification code", "enter OTP"]) {
      expect(isAuthChallengeLine(line), line).toBe(true);
    }
  });

  it("ignores trailing whitespace before judging", () => {
    expect(isAuthChallengeLine("[OTP Code]:   ")).toBe(true);
  });

  it("leaves ordinary shell prompts, logs and plain text alone", () => {
    for (const line of [
      "root@bastion:~$",
      "ubuntu@web:~ #",
      "docker ps",
      "kubectl get pods -n prod",
      "config: otp_timeout = 30s", // 冒号后还有正文，不是待输入行
      "MFA is enabled for this account", // 说明性文字，非提示行
      "Total 3 (delta 1), reused 0",
      "",
      "   ",
    ]) {
      expect(isAuthChallengeLine(line), line).toBe(false);
    }
  });
});

describe("isSelectionPromptLine", () => {
  it("matches select/choose prompts and menu input asks", () => {
    for (const line of [
      "Select server:", // 堡垒机服务器菜单
      "Please select a target host:",
      "Choose an option:",
      "pick one:",
      "Enter your choice [1-3]:",
      "请选择要连接的服务器:",
      "请输入服务器编号:",
      "选择:",
      "输入序号:",
    ]) {
      expect(isSelectionPromptLine(line), line).toBe(true);
    }
  });

  it("keeps matching after an answer or echo lands after the colon (bt 菜单实测)", () => {
    for (const line of [
      "请输入命令编号：^[[A", // canonical tty 把 ↑ 回显成字面 caret 记法(#150 反馈)
      "请输入命令编号：^[[A^[[A", // 连按多次,回显叠加
      "请输入命令编号：5", // 已键入应答
      "请输入命令编号：5^[[A", // 应答 + 回显
      "Select server:12",
    ]) {
      expect(isSelectionPromptLine(line), line).toBe(true);
    }
  });

  it("matches y/n confirm brackets at the input position", () => {
    for (const line of ["Continue? (y/n)", "Proceed (yes/no):", "Overwrite? [Y/n]", "[Y]es or [N]o", "[y]"]) {
      expect(isSelectionPromptLine(line), line).toBe(true);
    }
  });

  it("leaves shell prompts, logs and prose alone", () => {
    for (const line of [
      "root@bastion:~$",
      "docker compose ps",
      "selected 3 of 10 rows", // 英文动词过去式，非祈使提示
      " please select the files you want", // 无冒号/问号的叙述句(前导空格也非行首)
      "注意事项：请确认网络连通后重试", // 提示词后无冒号/问号的说明文字
      "total 3 entries",
      "",
    ]) {
      expect(isSelectionPromptLine(line), line).toBe(false);
    }
  });
});

describe("isInteractivePromptLine", () => {
  it("combines dynamic-code, password and selection heuristics", () => {
    expect(isInteractivePromptLine("[OTP Code]:")).toBe(true);
    // 密码/口令输入提示（询问输入）同样属于交互待答——sudo Password 处
    // ↑ 历史与建议一并让位（issue #150 反馈扩展）。
    expect(isInteractivePromptLine("Password:")).toBe(true);
    expect(isInteractivePromptLine("[sudo] password for ops:")).toBe(true);
    expect(isInteractivePromptLine("请输入口令:")).toBe(true);
    expect(isInteractivePromptLine("Select server:")).toBe(true);
  });

  it("strips a trailing caret-echo tail before judging (#150 反馈:回显不吞提示判定)", () => {
    expect(isInteractivePromptLine("请输入命令编号：^[[A")).toBe(true);
    expect(isInteractivePromptLine("Password: ^[[A")).toBe(true);
    expect(isInteractivePromptLine("[OTP Code]: ^[[A")).toBe(true);
  });

  it("stays quiet on an ordinary prompt line", () => {
    expect(isInteractivePromptLine("root@bastion:~$")).toBe(false);
    expect(isInteractivePromptLine("")).toBe(false);
  });
});

describe("interactivePromptNearCursor", () => {
  it("samples the cursor row and the one above it", () => {
    const lines = ["", "Please Enter MFA Code.", "[OTP Code]: "];
    const at = (row: number) => lines[row] ?? "";
    expect(interactivePromptNearCursor(2, at)).toBe(true);
    expect(interactivePromptNearCursor(1, at)).toBe(true);
    // 提示行已滚出两行窗口（如验证码已答、菜单在下发）→ 门放行。
    expect(interactivePromptNearCursor(0, at)).toBe(false);
  });

  it("matches a selection menu right above the cursor row", () => {
    const lines = ["  1  web-01 (10.0.0.1)", "  2  web-02 (10.0.0.2)", "Select server: "];
    expect(interactivePromptNearCursor(2, (row) => lines[row] ?? "")).toBe(true);
  });

  it("stays false on an all-clear screen and clamps at the buffer top", () => {
    const blank = () => "root@host:~$";
    expect(interactivePromptNearCursor(5, blank)).toBe(false);
    expect(interactivePromptNearCursor(0, () => "[OTP Code]:")).toBe(true);
  });
});

describe("isInteractivePromptPending", () => {
  it("pends when either the on-screen prompt line or the challenge dialog is live", () => {
    expect(isInteractivePromptPending({ promptLineOnScreen: false, challengeDialogPending: false })).toBe(false);
    expect(isInteractivePromptPending({ promptLineOnScreen: true, challengeDialogPending: false })).toBe(true);
    expect(isInteractivePromptPending({ promptLineOnScreen: false, challengeDialogPending: true })).toBe(true);
  });
});
