import { ref } from "vue";

// 通用应用内确认弹窗（SSH-H1 收口）：宿主沙箱 iframe 无 allow-modals，
// window.confirm 恒返回 false——覆盖确认/删除确认/进程强杀等在真机上曾全部
// 静默失效。模块级单例状态由 App.vue 渲染弹窗（useConfirmDialogHost），任意
// 组件经 confirmDialog() 请求确认（Promise 原语，同终端粘贴确认模式）。

interface PendingConfirmDialog {
  message: string;
  danger: boolean;
  resolve: (accepted: boolean) => void;
}

const pendingConfirmDialog = ref<PendingConfirmDialog>();
let pendingConfirmDialogResolver: ((accepted: boolean) => void) | undefined;

export function confirmDialog(message: string, options?: { danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    // 已有未决确认时先按取消结算，避免弹窗叠加后丢失前一个 resolver。
    resolveConfirmDialog(false);
    pendingConfirmDialogResolver = resolve;
    pendingConfirmDialog.value = { message, danger: options?.danger ?? true, resolve };
  });
}

export function resolveConfirmDialog(accepted: boolean) {
  if (!pendingConfirmDialog.value) return;
  pendingConfirmDialog.value = undefined;
  const resolve = pendingConfirmDialogResolver;
  pendingConfirmDialogResolver = undefined;
  resolve?.(accepted);
}

// App.vue 渲染弹窗用：未决请求（模板 v-if/文案）与结算入口（按钮/关框/Esc）。
export function useConfirmDialogHost() {
  return { pendingConfirmDialog, resolveConfirmDialog };
}
