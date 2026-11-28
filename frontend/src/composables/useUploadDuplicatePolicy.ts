import { ref, type Ref } from "vue";

/** 上传重复弹窗的最小结构（App.vue 的 UploadDuplicatePrompt 为局部接口，
 * 按消费字段收敛）。 */
interface UploadDuplicatePromptState {
  fileName: string;
  path: string;
  resolve: (choice: "overwrite" | "rename" | undefined) => void;
}

/** 上传重复目标策略（自 useUploadChain 纯搬移，P1-5）：预检 + 重命名/覆盖/
 * 询问「应用到全部」。批量决策（uploadDuplicateBatchDecision）是「每批次
 * 开头清 undefined」的契约——调用方经 resetBatchDecision 落实，残留的
 * 「应用到全部=覆盖」会让本批归档撞名时静默放行（解包恒覆盖，属破坏性
 * 结果）。单槽弹窗互斥（promise 链）：runTransfers 以批次上限并发跑上传，
 * 两个并发任务同时撞名时，后问直接覆盖弹窗会把先问的 resolve 顶掉——该
 * worker 永久 await、批次挂死、并发槽泄漏。串成链后，后到者的询问在先到
 * 者结算完成后再占槽；弹窗 UI 保持一次只问一个。 */
export function useUploadDuplicatePolicy(options: {
  session: Ref<{ sessionId?: string } | undefined>;
  transferDuplicateState: Ref<"rename" | "ask" | "overwrite">;
  sudoUpload: () => boolean;
  joinRemote: (parent: string, name: string) => string;
}) {
  const { session, transferDuplicateState, sudoUpload, joinRemote } = options;

  let uploadDuplicateBatchDecision: "overwrite" | "rename" | undefined;

  /** 批次开头清批量决策（每批次一次，见上方契约）。 */
  function resetBatchDecision() {
    uploadDuplicateBatchDecision = undefined;
  }

  const uploadDuplicatePrompt = ref<UploadDuplicatePromptState | null>(null);
  const uploadDuplicateApplyAll = ref(false);

  function resolveUploadDuplicate(choice: "overwrite" | "rename" | undefined) {
    if (choice !== undefined && uploadDuplicateApplyAll.value) uploadDuplicateBatchDecision = choice;
    uploadDuplicatePrompt.value?.resolve(choice);
    uploadDuplicatePrompt.value = null;
    uploadDuplicateApplyAll.value = false;
  }

  let uploadDuplicateAskChain: Promise<unknown> = Promise.resolve();

  function askUploadDuplicate(fileName: string, path: string): Promise<"overwrite" | "rename" | undefined> {
    const asked = uploadDuplicateAskChain.then(
      () =>
        new Promise<"overwrite" | "rename" | undefined>((resolve) => {
          uploadDuplicatePrompt.value = { fileName, path, resolve };
        }),
    );
    uploadDuplicateAskChain = asked.catch(() => undefined);
    return asked;
  }

  /**
   * 解析上传的最终远端文件名：目标已存在时按策略返回 proceed=false（放弃）或
   * 调整后的名字（rename 经后端 sftp/rename-unique 探测 name(1)..name(999)）。
   * 预检/重命名失败不阻断上传，回落现有覆盖语义。
   */
  async function resolveUploadDuplicateName(name: string, targetDir: string): Promise<{ name: string; proceed: boolean }> {
    const sessionId = session.value?.sessionId;
    if (!sessionId) return { name, proceed: true };
    const policy = transferDuplicateState.value;
    // issue #284：覆盖策略下 exists 探测不影响结果——目标存不存在都按原名下发，
    // 却让每个文件白付一次 stat 往返。小文件批量覆盖上传时这笔开销按文件数
    // 放大，公网 RTT 下就是「首传 1 分钟、覆盖十几分钟」的一部分。ask 模式
    // 已批量选了覆盖时同理（探测结果同样不可能改变本次解析结果）。
    if (policy === "overwrite") return { name, proceed: true };
    if (policy === "ask" && uploadDuplicateBatchDecision === "overwrite") return { name, proceed: true };
    const targetPath = joinRemote(targetDir, name);
    let exists = false;
    try {
      // sudo 车道预检换 sudo/exists（目标目录不可读时 sftp/exists 恒 false）。
      const existsMethod = sudoUpload() ? "sudo/exists" : "sftp/exists";
      const probe = await window.dbxPlugin.invoke<{ exists: boolean }>(existsMethod, { sessionId, path: targetPath });
      exists = probe.exists === true;
    } catch {
      // 预检不可用时保持原语义直接下发。
      return { name, proceed: true };
    }
    if (!exists) return { name, proceed: true };
    if (policy === "ask" && uploadDuplicateBatchDecision === undefined) {
      const choice = await askUploadDuplicate(name, targetPath);
      if (!choice) return { name, proceed: false };
      uploadDuplicateBatchDecision = choice;
    }
    if (policy === "ask" && uploadDuplicateBatchDecision === "overwrite") return { name, proceed: true };
    // rename（或 ask 选了重命名）：后端探测不冲突新名；旧 sidecar 无该方法时
    // 回落原名覆盖。sudo 车道带 sudo 标记（后端改走 sudo test -e 探测）。
    try {
      const result = await window.dbxPlugin.invoke<{ name: string }>("sftp/rename-unique", { sessionId, dir: targetDir, name, sudo: sudoUpload() });
      return { name: result.name || name, proceed: true };
    } catch {
      return { name, proceed: true };
    }
  }

  return { uploadDuplicatePrompt, uploadDuplicateApplyAll, resolveUploadDuplicate, resolveUploadDuplicateName, resetBatchDecision };
}
