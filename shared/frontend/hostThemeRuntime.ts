// 宿主环境订阅与外观应用的单点运行时（REVIEW-FAMILY X-P2/P3/P4 收敛）。
//
// 背景：四插件曾各自手写 env/locale/context/theme 订阅与 appearance 颜色
// 变量应用——ssh/kafka 订阅过真桥不存在的 onLocaleChange/onContextChange
// （幽灵 API，宿主切语言静默失效）；appearance 颜色循环四份拷贝三种写法
// （仅 kafka 先探测宿主令牌再移除内联，其余无条件 setProperty 冻结
// themeSync 桥的 var() 引用，appearance 事件后停止跟随宿主主题）。
// 本模块收敛为单点，插件只传领域回调（见各插件 App.vue 接入处与薄 spec）。

// 插件 CSS 颜色变量 → 宿主令牌名。宿主在插件根节点维护了令牌的字段交给
// themeSync 桥（var(--color-*) 动态跟随宿主令牌更新）；inline 写入会以更高
// 优先级永久冻结桥的引用。令牌缺失（Host API 1.0 / mock 缺省）才 inline 写
// 规范色板，覆盖桥的暗色回退；appearance 消息带色但无令牌的部分下发同样走
// inline，不出现拼色。
//
// 「宿主是否接管」只能看根节点 inline 的 --color-*（只有宿主 SDK 会 inline
// 写令牌，插件从不写）。不能用 computed：独立运行（mock / Host API 1.0）下
// tailwind theme 层的 --color-*:var(--*) 别名与 themeSync 桥的
// var(--color-*) 引用互相成环，computed 恒为空不可分辨；而插件自己 inline
// 过的色板又会让 computed 变非空——boot 写入后紧随的 appearance 重放据此
// removeProperty 撤掉自己的色板、复活循环（mock 整站黑底黑字的根因）。
export const APPEARANCE_COLOR_KEYS = [
  "background",
  "foreground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "border",
  "destructive",
] as const;

export type DbxAppearanceColorKey = (typeof APPEARANCE_COLOR_KEYS)[number];

export type DbxAppearanceColors = Partial<Record<DbxAppearanceColorKey, string>>;

export function applyAppearanceColorVars(root: HTMLElement, colors: DbxAppearanceColors): void {
  for (const key of APPEARANCE_COLOR_KEYS) {
    const name = `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
    const token = `--color-${name.slice(2)}`;
    const value = colors[key];
    if (root.style.getPropertyValue(token).trim()) root.style.removeProperty(name);
    else if (typeof value === "string" && value) root.style.setProperty(name, value);
  }
}

// 宿主环境事件的最小结构面（真桥 onEvent 同时投递后端事件与
// {type:"env", locale?, theme?} 环境更新；真桥不存在
// onLocaleChange/onContextChange 订阅）。结构化 typing 不耦合各插件 env.d.ts
// 的全局类型，显式泛型由调用方标注（见薄 spec / App.vue 接入处）。
export interface HostEnvironmentEventLike {
  type?: unknown;
  method?: unknown;
  locale?: unknown;
  theme?: unknown;
}

export interface HostEnvironmentApiLike<A, T> {
  onEvent?(listener: (event: HostEnvironmentEventLike) => void): () => void;
  onContext?(listener: (context: Record<string, unknown>) => void): () => void;
  /** Legacy optional callback; current bridges use onContext. */
  onContextChange?(listener: (context: Record<string, unknown>) => void): () => void;
  onAppearanceChange?(listener: (appearance: A) => void): () => void;
}

export interface HostEnvironmentHandlers<A, T> {
  /** 每条 env 事件（无论是否携带 locale/theme）都触发；供以 api.locale 等桥字段
   * 为权威源的插件同步状态（如 files：SDK 先更新 api.locale 再投递 env）。 */
  onEnv?(): void;
  /** env 推送的 locale（真桥 updateLocale 语义）。 */
  onLocale?(locale: string): void;
  /** context 重推（onContext，旧桥回退 onContextChange）。 */
  onContext?(context: Record<string, unknown>): void;
  /** 1.1 appearance 通道推送。 */
  onAppearance?(appearance: A): void;
  /** theme 形态推送（env 消息或 themeChannel 兜底），调用方自行转 appearance。 */
  onTheme?(theme: T): void;
}

export interface SubscribeHostEnvironmentOptions<T> {
  // appearance 订阅缺失（宿主只推 theme）时的兜底通道（各插件 lib/hostTheme
  // 的 onHostThemeChange：SDK 对 env 消息派发 dbx-plugin-env CustomEvent）。
  // 与 onAppearanceChange 两套不同时挂，与既有插件行为一致。
  themeChannel?: (listener: (theme: T) => void) => () => void;
}

// 订阅归一：env（locale/theme）+ context（onContext ?? onContextChange 旧桥
// 兼容）+ appearance（onAppearanceChange ?? themeChannel）。后端事件不经此——
// 插件保留自己的 api.onEvent(handleEvent) 订阅。返回聚合退订函数。
export function subscribeHostEnvironment<A = unknown, T = unknown>(
  api: HostEnvironmentApiLike<A, T>,
  handlers: HostEnvironmentHandlers<A, T>,
  options: SubscribeHostEnvironmentOptions<T> = {},
): () => void {
  const unsubs: Array<() => void> = [];
  if (typeof api.onEvent === "function") {
    unsubs.push(api.onEvent((event) => {
      if (event.type !== "env") return;
      handlers.onEnv?.();
      if (typeof event.locale === "string") handlers.onLocale?.(event.locale);
      if (event.theme !== undefined && event.theme !== null) handlers.onTheme?.(event.theme as T);
    }));
  }
  const onContext = api.onContext ?? api.onContextChange;
  if (typeof onContext === "function") unsubs.push(onContext.call(api, (context) => handlers.onContext?.(context)));
  if (typeof api.onAppearanceChange === "function") {
    unsubs.push(api.onAppearanceChange((appearance) => handlers.onAppearance?.(appearance)));
  } else if (options.themeChannel) {
    unsubs.push(options.themeChannel((theme) => handlers.onTheme?.(theme)));
  }
  return () => {
    for (const dispose of unsubs.splice(0)) dispose?.();
  };
}
