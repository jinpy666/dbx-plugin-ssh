import { createApp } from "vue";
import App from "./App.vue";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import "./styles/tailwind.css";
import { installHostThemeBridge } from "../../shared/frontend/themeSync";
import { pluginStore } from "./lib/pluginStore";

// 宿主令牌 → 插件变量桥：首绘即命中宿主主题，主题变化经 SDK 令牌更新自动跟随。
// 字体回退值覆盖为插件规范链（UI 字体补 CJK 回退，与 style.css :root 一致；
// 终端字体保持等宽链，与既有默认一致）。
installHostThemeBridge({
  "--ui-font-family": 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  "--terminal-font-family": '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
});

// UI 状态水合（宿主 host.storage → localStorage 降级 + 旧键搬家）先于挂载，
// 保证 App setup 内的同步首读（面板形态 / 字体 / WebGL 等偏好）命中持久化值。
const boot = async () => {
  await pluginStore.ready;
  createApp(App).mount("#app");
};
boot();