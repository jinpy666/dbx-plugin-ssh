import { createApp } from "vue";
import App from "./App.vue";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { installHostThemeBridge } from "../../shared/frontend/themeSync";

// 宿主令牌 → 插件变量桥：首绘即命中宿主主题，主题变化经 SDK 令牌更新自动跟随。
installHostThemeBridge();

createApp(App).mount("#app");
