// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { confirmDialog, resolveConfirmDialog, useConfirmDialogHost } from "./confirmDialog";

// SSH-H1 守卫：window.confirm 在宿主沙箱恒 false，危险确认必须走应用内弹窗。
// 这里锁定 Promise 原语的结算语义（接受/取消/未决替换/空结算幂等）。
describe("confirmDialog primitive", () => {
  it("resolves true on accept and false on cancel, clearing the pending request", async () => {
    const first = confirmDialog("overwrite?");
    const { pendingConfirmDialog } = useConfirmDialogHost();
    expect(pendingConfirmDialog.value?.message).toBe("overwrite?");
    expect(pendingConfirmDialog.value?.danger).toBe(true);
    resolveConfirmDialog(true);
    await expect(first).resolves.toBe(true);
    expect(pendingConfirmDialog.value).toBeUndefined();

    const second = confirmDialog("delete?", { danger: false });
    expect(pendingConfirmDialog.value?.danger).toBe(false);
    resolveConfirmDialog(false);
    await expect(second).resolves.toBe(false);
    expect(pendingConfirmDialog.value).toBeUndefined();
  });

  it("settles a superseded request as cancelled before installing the next one", async () => {
    const stale = confirmDialog("stale?");
    const fresh = confirmDialog("fresh?");
    await expect(stale).resolves.toBe(false);
    const { pendingConfirmDialog } = useConfirmDialogHost();
    expect(pendingConfirmDialog.value?.message).toBe("fresh?");
    resolveConfirmDialog(true);
    await expect(fresh).resolves.toBe(true);
  });

  it("is a no-op when settling with no pending request", () => {
    expect(() => resolveConfirmDialog(true)).not.toThrow();
  });
});
