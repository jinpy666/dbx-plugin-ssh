import { createApp } from "vue";
import App from "./App.vue";
import TunnelManager from "./TunnelManager.vue";
import { isTunnelManagerContext } from "./lib/pluginContext";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import "./styles/tailwind.css";
import { installHostThemeBridge } from "../../shared/frontend/themeSync";
import { pluginStore } from "./lib/pluginStore";
import { watchPopupReveal } from "./lib/popupReveal";

let openedContributionId = "";
document.addEventListener("dbx-plugin-init", (event) => {
  const detail = (event as CustomEvent<{ contributionId?: unknown }>).detail;
  if (typeof detail?.contributionId === "string") openedContributionId = detail.contributionId;
});

async function waitForHostApi(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!window.dbxPlugin && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return window.dbxPlugin;
}

// 宿主令牌 → 插件变量桥：首绘即命中宿主主题，主题变化经 SDK 令牌更新自动跟随。
// 字体回退值覆盖为插件规范链（UI 字体补 CJK 回退，与 style.css :root 一致；
// 终端字体保持等宽链，与既有默认一致）。
installHostThemeBridge({
  "--ui-font-family": 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  "--terminal-font-family": '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
});

/**
 * 给宿主握手 Promise 套一层超时：`api.ready` 一旦永不落定（宿主与 sidecar
 * 握手没走完、或老宿主不推 ready），`await` 会把整个 boot 卡死 → 工作台永久
 * 白屏（无任何 JS 报错，现场只能看到空白面板）。空 context 挂载仍是完整的
 * 工作台（连接表单/工具条照常可用），比白屏好得多；真正的 context 若随后到达
 * 仍会经 SDK 的 context/appearance 推送补齐。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[boot] ${label} timed out after ${ms}ms; mounting with partial context`);
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** 宿主握手超时上限：正常宿主在数百 ms 内落定，留足慢机余量但不至于长白屏。 */
const HOST_HANDSHAKE_TIMEOUT_MS = 3000;

/**
 * 启动/运行期异常可视化：Vue 对 setup 与首帧 render 抛出的异常只会
 * `console.error` 后留下空容器 —— 在外壳 webview 里没有 devtools，表现就是
 * 「永久白屏、零提示」（beta.2.2 现场即如此：分屏 composable 在 sandbox
 * opaque origin 下裸读 localStorage 抛 SecurityError）。这里把首个错误直接
 * 画进 #app，任何环境都能一眼看到根因，而不是再靠截图猜。
 *
 * 只在容器仍为空（从未挂载成功）时接管，避免运行期偶发错误抢占已渲染界面。
 */
let bootFailureShown = false;

function showBootFailure(cause: unknown, info = "boot"): void {
  if (bootFailureShown) return;
  const host = document.getElementById("app");
  if (!host || host.childElementCount > 0) return;
  bootFailureShown = true;
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}\n\n${cause.stack ?? ""}` : String(cause);
  console.error(`[${info}] 工作台启动失败`, cause);
  const box = document.createElement("pre");
  box.style.cssText =
    "margin:0;padding:14px;box-sizing:border-box;width:100%;height:100%;overflow:auto;" +
    "font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;" +
    "color:#fca5a5;background:#111827";
  box.textContent = `工作台启动失败（${info}）\n\n${detail.slice(0, 2400)}`;
  host.appendChild(box);
}

// UI 状态水合（宿主 host.storage → localStorage 降级 + 旧键搬家）先于挂载，
// 保证 App setup 内的同步首读（面板形态 / 字体 / WebGL 等偏好）命中持久化值。
const boot = async () => {
  await pluginStore.ready;
  // 弹层动画冻结保险先于挂载装好：宿主渲染器停摆（动画定格透明首帧）时，
  // 弹层挂载 300ms 后被强制落到可见态（lib/popupReveal.ts）。
  watchPopupReveal();
  // A native connection context-menu dialog carries the host's public
  // {id, dbType, name} summary. Route it before App mounts so no PTY is made.
  const api = await waitForHostApi();
  // 宿主注入桥时通常已同步挂上 `context`（工作台 id / connectionId 从这里读），
  // 握手超时的兜底下先吃它，避免空 context 把工作台退化成"无连接"形态。
  const injectedContext = (api?.context ?? {}) as Record<string, unknown>;
  const readyContext = (api ? await withTimeout(api.ready, HOST_HANDSHAKE_TIMEOUT_MS, "api.ready") : undefined) ?? {};
  const requestedContext = (api
    ? await withTimeout(api.request<Record<string, unknown>>("host.getContext"), HOST_HANDSHAKE_TIMEOUT_MS, "host.getContext")
    : undefined) ?? {};
  const context = { ...injectedContext, ...readyContext, ...requestedContext, quickStart: readyContext.quickStart === true || injectedContext.quickStart === true || openedContributionId === "io.dbx.ssh.tunnels.quick" };
  const app = isTunnelManagerContext(context) ? createApp(TunnelManager, { context }) : createApp(App);
  app.config.errorHandler = (error, _instance, info) => {
    console.error(`[vue] ${info}`, error);
    showBootFailure(error, info);
  };
  try {
    app.mount("#app");
  } catch (cause) {
    showBootFailure(cause, "mount");
  }
};
void boot().catch((cause) => showBootFailure(cause, "boot"));
