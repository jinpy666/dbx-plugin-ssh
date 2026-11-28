import { computed, nextTick, ref, watch, type Ref } from "vue";
import { displayPathToWire } from "../lib/sftpName";
import { normalizeDropTargetDir, resolveDropTargetDir } from "../lib/terminalInteraction";

/** 拖入上传落点询问（自 useUploadChain 纯搬移）：终端 cwd（OSC 7/633）优先，
 * 其次远端主目录，最后兜底面板目录——终端拖拽只在面板关闭时接收，面板目录
 * 此刻不可见，仅作旧 sidecar 兜底。弹窗展示的就是这里的解析结果。
 * 与 askUploadDuplicate 同款单槽互斥（promise 链）：两个拖入批次先后落点
 * 询问时，后问覆盖 resolver 会把先问的 promise 顶成永久挂起（拖入静默
 * 卡死）；串成链后，后到者的询问在先到者结算完成后再占槽。 */
export function useDropUploadTargetPrompt(options: {
  currentPath: Ref<string>;
  sftpHomePath: Ref<string>;
  terminalCwd: Ref<string>;
  sftpNameEncodingState: Ref<string>;
}) {
  const { currentPath, sftpHomePath, terminalCwd, sftpNameEncodingState } = options;

  const dropUploadPrompt = ref<{ files: Array<{ name: string }> }>();
  const dropUploadTarget = ref<"cwd" | "custom">("cwd");

  const dropCwdTarget = computed(() => resolveDropTargetDir({ terminalCwd: terminalCwd.value || undefined, sftpHome: sftpHomePath.value || undefined, fallback: currentPath.value }));
  // M17 增量②：上传落点的 wire 形式（弹窗仍展示 dropCwdTarget 的显示形式）。
  // shell cwd 回读与 sftp home 探测结果是显示文本，latin-1 下经 displayPathToWire
  // 转成 wire 形式（% 自转义、U+0080..FF → %XX、>U+00FF 按 UTF-8 兜底），与本地
  // 文件名 join 后整条符合 sidecar write_path_bytes 的「wire 目录前缀 + 用户新
  // 输入的显示末段」分工；fallback（面板当前目录）本身来自列表链的 wire 形式，
  // 原样透传。已知边界：shell cwd 回读中非 UTF-8 的服务器字节在终端解码层已
  // 丢失（U+FFFD），无法还原为 latin-1 字节（登记，不做恢复）。
  const dropCwdTargetWire = computed(() => resolveDropTargetDir({
    terminalCwd: wireDropDir(terminalCwd.value),
    sftpHome: wireDropDir(sftpHomePath.value),
    fallback: currentPath.value,
  }));

  /** latin-1 显示文本 → wire 形式（拖入上传的手输/shell cwd 目录）；auto 原样。 */
  function wireDropDir(dir: string | undefined): string | undefined {
    if (!dir) return dir;
    return sftpNameEncodingState.value === "latin-1" ? displayPathToWire(dir) : dir;
  }

  const dropUploadPathInput = ref("");
  const dropUploadPathInputEl = ref<HTMLInputElement>();

  let dropUploadResolver: ((choice: "cancel" | "cwd" | { dir: string }) => void) | undefined;
  let dropUploadAskChain: Promise<unknown> = Promise.resolve();

  function askDropUploadTarget(files: Array<{ name: string }>): Promise<"cancel" | "cwd" | { dir: string }> {
    const asked = dropUploadAskChain.then(
      () =>
        new Promise<"cancel" | "cwd" | { dir: string }>((resolve) => {
          dropUploadTarget.value = "cwd";
          dropUploadPathInput.value = "";
          dropUploadResolver = resolve;
          dropUploadPrompt.value = { files };
        }),
    );
    dropUploadAskChain = asked.catch(() => undefined);
    return asked;
  }

  // 选中“指定目录”即聚焦路径输入框（禁用态拿不到焦点，所以不在打开时聚焦）：
  // 键盘流为拖入 → Tab/方向键切到自定义 → 直接输入 → Enter 提交。
  watch(dropUploadTarget, async (target) => {
    if (target !== "custom") return;
    await nextTick();
    dropUploadPathInputEl.value?.focus();
  });

  function confirmDropUpload() {
    if (!dropUploadPrompt.value) return;
    if (dropUploadTarget.value === "custom") {
      const dir = normalizeDropTargetDir(dropUploadPathInput.value);
      if (!dir) return;
      resolveDropUpload({ dir });
      return;
    }
    resolveDropUpload("cwd");
  }

  function resolveDropUpload(choice: "cancel" | "cwd" | { dir: string }) {
    dropUploadPrompt.value = undefined;
    const resolve = dropUploadResolver;
    dropUploadResolver = undefined;
    resolve?.(choice);
  }

  return {
    dropUploadPrompt,
    dropUploadTarget,
    dropCwdTarget,
    dropCwdTargetWire,
    wireDropDir,
    dropUploadPathInput,
    dropUploadPathInputEl,
    askDropUploadTarget,
    confirmDropUpload,
    resolveDropUpload,
  };
}
