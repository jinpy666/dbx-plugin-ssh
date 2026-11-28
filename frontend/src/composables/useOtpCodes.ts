import { reactive, ref, type Ref } from "vue";
import { parseGenerateResponse, tickCountdown, type OtpCodeState, type OtpEntryView } from "../lib/otpPanel";

/** OTP 码引擎（自 OtpPanel 纯搬移）：按条目取码、批量取 TOTP、每秒倒计时
 * 与到期自动拉新码、失败指数退避（5s/10s/30s）与 reused 窗口语义。列表刷新
 * 与绑定表由调用方持有（refresh 需同时更新 entries/bindings）。 */
export function useOtpCodes(options: {
  entries: Ref<OtpEntryView[]>;
  showActionError: (cause: unknown) => void;
}) {
  const { entries, showActionError } = options;

  const codes = reactive<Record<string, OtpCodeState>>({});
  /** 正在取码的条目 id（按钮禁用 + 行内 spinner）。 */
  const generating = reactive(new Set<string>());
  // 失败退避：避免每个 tick（1s）都打一次失败 RPC。阶梯递增，成功即清零。
  const RETRY_BACKOFF_STEPS_MS = [5000, 10000, 30000];
  const retryBackoffAt: Record<string, number> = {};
  const retryBackoffStep: Record<string, number> = {};

  async function generateFor(entry: OtpEntryView) {
    if (generating.has(entry.id)) return;
    generating.add(entry.id);
    try {
      const payload = await window.dbxPlugin.invoke("otp/generate", { entryId: entry.id });
      delete retryBackoffAt[entry.id];
      delete retryBackoffStep[entry.id];
      const state = parseGenerateResponse(payload);
      if (!state) return;
      // reused：本窗口已取过码（code 为 null）——保留旧码置灰展示，倒计时走完
      // 新窗口开启后由 tick 自动重新生成。
      codes[entry.id] = state.reused ? { ...state, code: codes[entry.id]?.code ?? "" } : state;
    } catch (cause) {
      const step = Math.min(retryBackoffStep[entry.id] ?? 0, RETRY_BACKOFF_STEPS_MS.length - 1);
      retryBackoffAt[entry.id] = Date.now() + RETRY_BACKOFF_STEPS_MS[step];
      retryBackoffStep[entry.id] = Math.min((retryBackoffStep[entry.id] ?? 0) + 1, RETRY_BACKOFF_STEPS_MS.length - 1);
      showActionError(cause);
    } finally {
      generating.delete(entry.id);
    }
  }

  async function generateAllTotp() {
    for (const entry of entries.value.filter((candidate) => candidate.otpType === "totp")) {
      await generateFor(entry);
    }
  }

  /** 每秒 tick：TOTP 剩余秒递减，归零即拉新码（新窗口）；失败退避期内跳过
   * 自动拉码，等下一次窗口再试。 */
  function tick() {
    const now = Date.now();
    for (const entry of entries.value) {
      const state = codes[entry.id];
      if (!state || entry.otpType !== "totp") continue;
      if (state.remaining > 0) {
        state.remaining = tickCountdown(state.remaining);
        continue;
      }
      if ((retryBackoffAt[entry.id] ?? 0) > now) continue;
      void generateFor(entry);
    }
  }

  /** 删除条目时清理码状态（父层删除成功后调用）。 */
  function forget(id: string) {
    delete codes[id];
  }

  return { codes, generating, RETRY_BACKOFF_STEPS_MS, generateFor, generateAllTotp, tick, forget };
}
