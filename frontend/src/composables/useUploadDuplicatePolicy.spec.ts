// 重复目标策略（P1-5 / issue #284）单测：ask 弹窗单槽互斥链、批量决策
// 「应用到全部」残留契约与覆盖策略免探测。
// @vitest-environment happy-dom（invoke 桩挂在 window.dbxPlugin 上）

import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useUploadDuplicatePolicy } from "./useUploadDuplicatePolicy";

function mount(handlers: { exists?: boolean; uniqueName?: string } = {}, policyState: "rename" | "ask" | "overwrite" = "ask") {
  const invoke = vi.fn(async (method: string) => {
    if (method === "sftp/exists") return { exists: handlers.exists ?? true };
    if (method === "sftp/rename-unique") return { name: handlers.uniqueName ?? "a(1).bin" };
    return undefined;
  });
  (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
  const policy = useUploadDuplicatePolicy({
    session: ref({ sessionId: "s1" }),
    transferDuplicateState: ref<"rename" | "ask" | "overwrite">(policyState),
    sudoUpload: () => false,
    joinRemote: (parent: string, name: string) => `${parent}/${name}`,
  });
  return { policy, invoke };
}

describe("useUploadDuplicatePolicy ask chain", () => {
  it("ask policy: unresolved prompt returns proceed=false without renaming", async () => {
    const { policy, invoke } = mount({ exists: true });
    const pending = policy.resolveUploadDuplicateName("a.bin", "/root");
    await vi.waitFor(() => expect(policy.uploadDuplicatePrompt.value).not.toBeNull());
    expect(policy.uploadDuplicatePrompt.value?.fileName).toBe("a.bin");
    policy.resolveUploadDuplicate(undefined);
    await expect(pending).resolves.toEqual({ name: "a.bin", proceed: false });
    expect(invoke).toHaveBeenCalledTimes(1); // 只探测，未 rename
  });

  it("applyAll=overwrite persists the batch decision and skips later probes", async () => {
    const { policy, invoke } = mount({ exists: true });
    const first = policy.resolveUploadDuplicateName("a.bin", "/root");
    await vi.waitFor(() => expect(policy.uploadDuplicatePrompt.value).not.toBeNull());
    policy.uploadDuplicateApplyAll.value = true;
    policy.resolveUploadDuplicate("overwrite");
    await expect(first).resolves.toEqual({ name: "a.bin", proceed: true });

    // 批次内第二文件：决策残留 → 直接放行，零探测。
    await expect(policy.resolveUploadDuplicateName("b.bin", "/root")).resolves.toEqual({ name: "b.bin", proceed: true });
    expect(invoke).toHaveBeenCalledTimes(1);

    // 新批次开头清决策 → 重新询问。
    policy.resetBatchDecision();
    const second = policy.resolveUploadDuplicateName("c.bin", "/root");
    await vi.waitFor(() => expect(policy.uploadDuplicatePrompt.value).not.toBeNull());
    policy.resolveUploadDuplicate(undefined);
    await expect(second).resolves.toEqual({ name: "c.bin", proceed: false });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent asks: the later ask occupies the slot only after the first settles", async () => {
    const { policy } = mount({ exists: true, uniqueName: "a(1).bin" });
    const first = policy.resolveUploadDuplicateName("a.bin", "/root");
    const second = policy.resolveUploadDuplicateName("b.bin", "/root");
    await vi.waitFor(() => expect(policy.uploadDuplicatePrompt.value).not.toBeNull());
    expect(policy.uploadDuplicatePrompt.value?.fileName).toBe("a.bin");
    policy.resolveUploadDuplicate("rename");
    await expect(first).resolves.toEqual({ name: "a(1).bin", proceed: true });
    // 先问结算后，后问才占槽（后到者不再顶掉先问的 resolve）。
    await vi.waitFor(() => expect(policy.uploadDuplicatePrompt.value?.fileName).toBe("b.bin"));
    policy.resolveUploadDuplicate(undefined);
    await expect(second).resolves.toEqual({ name: "b.bin", proceed: false });
  });
});

describe("useUploadDuplicatePolicy policy shortcuts", () => {
  it("overwrite policy skips the exists probe entirely (issue #284)", async () => {
    const { policy, invoke } = mount({ exists: true }, "overwrite");
    await expect(policy.resolveUploadDuplicateName("a.bin", "/root")).resolves.toEqual({ name: "a.bin", proceed: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rename policy probes rename-unique on the server", async () => {
    const { policy } = mount({ exists: true, uniqueName: "a(1).bin" }, "rename");
    await expect(policy.resolveUploadDuplicateName("a.bin", "/root")).resolves.toEqual({ name: "a(1).bin", proceed: true });
  });
});

describe("useUploadDuplicatePolicy guards", () => {
  it("passes through without a session", async () => {
    const policy = useUploadDuplicatePolicy({
      session: ref(undefined),
      transferDuplicateState: ref<"rename" | "ask" | "overwrite">("ask"),
      sudoUpload: () => false,
      joinRemote: (parent: string, name: string) => `${parent}/${name}`,
    });
    await expect(policy.resolveUploadDuplicateName("a.bin", "/root")).resolves.toEqual({ name: "a.bin", proceed: true });
  });

  it("passes through when the target does not exist", async () => {
    const { policy, invoke } = mount({ exists: false });
    await expect(policy.resolveUploadDuplicateName("a.bin", "/root")).resolves.toEqual({ name: "a.bin", proceed: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
