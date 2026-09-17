// CodeMirror 6 语法高亮调色板（四插件共用，唯一实现点）。
//
// 背景：ssh/files TextPreview 只用 basicSetup，其内置 defaultHighlightStyle 是
// 浅底配色，暗色宿主主题下语法色发暗不显眼（用户反馈"配色不太好，不够明显，
// 有点暗"）；kafka CodeEditor 的 --cm-* 变量用标准 VS Code Dark+，同样偏暗。
// 本模块按明暗两套统一提亮（暗色以 GitHub Dark / One 亮色系为参照，浅色取
// VS Code Light+ 同源），单点维护，插件按 scheme 引用。
//
// 接入方：
// - ssh/files TextPreview.vue：`dbxSyntaxHighlight(scheme, runtime)` 追加在
//   basicSetup 之后（defaultHighlightStyle 作为 fallback，自定义样式优先生效）。
// - kafka CodeEditor.vue：CSS 变量驱动无法 import 色值进样式表，`--cm-*` 暗色
//   块按 `EDITOR_TOKEN_COLORS.dark` 镜像（kafka frontend/src/lib/editorTheme.spec.ts
//   以源码断言防漂移）。
//
// 依赖约束：shared/frontend 位于 workspace 根（无 node_modules 祖先链），本模块
// 与 binaryEvent/themeSync 同约定保持零运行时依赖，不直接 import codemirror 系
// 包——`@codemirror/language`（HighlightStyle/syntaxHighlighting）与
// `@lezer/highlight`（tags）由调用方注入（三插件均已是直接依赖）。

/** 宿主/插件明暗色系。 */
export type DbxColorScheme = "light" | "dark";

/** 调色板键名。kafka `--cm-*` 镜像子集：key/string/number/null/punct/prop/comment。 */
export type EditorTokenColorKey =
  | "key" // 关键字 / 布尔 / 属性名(HTML) / this
  | "string"
  | "number"
  | "null" // null / const 常量名
  | "punct"
  | "prop" // 对象属性名 / XML 标签名
  | "comment"
  | "function"
  | "type" // 类型名 / 类名 / 命名空间
  | "operator"
  | "variable"
  | "regexp"
  | "link"
  | "heading"
  | "invalid";

/** 值为 CSS 颜色；`null` 表示不覆盖（跟随编辑器默认前景，如浅色下的变量名）。 */
export type EditorTokenPalette = Record<EditorTokenColorKey, string | null>;

// 暗色（提亮后的 GitHub Dark 系参照）：比标准 VS Code Dark+ 明显更亮。
// 浅色（VS Code Light+ 同源，与 kafka `--cm-*` 浅色块的历史值保持一致）。
export const EDITOR_TOKEN_COLORS: { light: EditorTokenPalette; dark: EditorTokenPalette } = {
  light: {
    key: "#0000ff",
    string: "#a31515",
    number: "#098658",
    null: "#795e26",
    punct: "#3b3b3b",
    prop: "#0451a5",
    comment: "#008000",
    function: "#795e26",
    type: "#267f99",
    operator: "#3b3b3b",
    variable: null, // 浅色下变量名跟随默认前景
    regexp: "#a31515",
    link: "#0451a5",
    heading: "#0451a5",
    invalid: "#e51400",
  },
  dark: {
    key: "#4fc1ff",
    string: "#ffb86c",
    number: "#c3e88d",
    null: "#e5c07b",
    punct: "#dcdcdc",
    prop: "#7cc7ff",
    comment: "#8b949e",
    function: "#d2a8ff",
    type: "#56d4dd",
    operator: "#ff7b72",
    variable: "#e6e6e6",
    regexp: "#d2a8ff",
    link: "#56d4dd",
    heading: "#56d4dd",
    invalid: "#ff7b72",
  },
};

/** 单条语法着色规则：tag 为 `@lezer/highlight` `tags` 的成员名或
 * `修饰器(成员名)` 组合表达式（如 `function(variableName)`）。 */
export interface SyntaxTokenSpec {
  tag: string;
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

// tag 覆盖面：按调色板键归组的 tags 成员名。子 tag（如 controlKeyword 之于
// keyword、angleBracket 之于 punctuation）在未显式列出时会沿 parent 链继承
// 父 tag 样式，这里显式列出以保证着色优先级确定、且便于日后单独分色。
const TAG_COLOR_GROUPS: Array<{ key: EditorTokenColorKey; tags: string[]; weight?: string }> = [
  { key: "key", tags: ["keyword", "controlKeyword", "moduleKeyword", "definitionKeyword", "operatorKeyword", "self", "atom", "unit", "modifier", "bool", "attributeName"] },
  { key: "string", tags: ["string", "character", "attributeValue", "escape", "docString"] },
  { key: "number", tags: ["number", "integer", "float"] },
  { key: "regexp", tags: ["regexp"] },
  // null 是 keyword 子 tag，const 常量名经 constant 修饰器组合，两者均需显式覆盖。
  { key: "null", tags: ["null", "constant(variableName)"] },
  { key: "prop", tags: ["propertyName"] },
  { key: "function", tags: ["function(variableName)"] },
  { key: "type", tags: ["typeName", "className", "namespace"] },
  { key: "comment", tags: ["comment"] },
  { key: "operator", tags: ["operator"] },
  { key: "punct", tags: ["punctuation", "separator", "bracket", "angleBracket", "squareBracket", "paren", "brace"] },
  { key: "variable", tags: ["variableName"] },
  { key: "link", tags: ["link", "url"] },
  { key: "heading", tags: ["heading"], weight: "700" },
  { key: "invalid", tags: ["invalid"] },
];

/** 按色系展开语法着色规则；调色板为 `null` 的键（浅色 variable）不产出条目。 */
export function syntaxTokenSpecs(scheme: DbxColorScheme): SyntaxTokenSpec[] {
  const palette = EDITOR_TOKEN_COLORS[scheme];
  const specs: SyntaxTokenSpec[] = [];
  for (const group of TAG_COLOR_GROUPS) {
    const color = palette[group.key];
    if (!color) continue;
    for (const tag of group.tags) specs.push({ tag, color, fontWeight: group.weight });
  }
  return specs;
}

const MODIFIED_TAG_PATTERN = /^([A-Za-z]\w*)\(([A-Za-z]\w*)\)$/;

/** 把 tag 表达式解析为 `tags` 集合里的实际 Tag：`修饰器(成员)` 形式（如
 * `function(variableName)`）调用修饰器函数，其余按成员名直查。 */
export function resolveSyntaxTag(tagSet: Record<string, unknown>, tagExpr: string): unknown {
  const match = MODIFIED_TAG_PATTERN.exec(tagExpr);
  if (match) {
    const modifier = tagSet[match[1]];
    const inner = tagSet[match[2]];
    if (typeof modifier === "function" && inner) return (modifier as (tag: unknown) => unknown)(inner);
  }
  return tagSet[tagExpr];
}

/** 插件注入的 CodeMirror 高亮运行时（均为各插件 node_modules 的直接依赖）。
 * define 的 spec 是 `SyntaxTokenSpec` 经 `resolveSyntaxTag` 解析 tag 后的形状。 */
export interface EditorHighlightRuntime {
  HighlightStyle: { define(specs: readonly ResolvedTokenSpec[]): unknown };
  // 方法签名形式（参数双变）以结构兼容真实 CodeMirror 类型。
  syntaxHighlighting(style: unknown): unknown;
  tags: Record<string, unknown>;
}

/** `SyntaxTokenSpec` 的 tag 已解析为实际 Tag 对象后的形状（结构兼容 HighlightStyle.define）。 */
export interface ResolvedTokenSpec {
  tag: unknown;
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

// 每个色系只 define 一次：HighlightStyle 可被多个 EditorState 共享，主题切换
// 重建编辑器时复用，避免重复构造注入样式表。
const highlightCache = new Map<DbxColorScheme, unknown>();

/** 按明暗色系构造 CodeMirror 语法高亮扩展（插件侧以 `as Extension` 收窄）。
 * 追加在 basicSetup 之后即可覆盖其内置浅色 defaultHighlightStyle。 */
export function dbxSyntaxHighlight(scheme: DbxColorScheme, runtime: EditorHighlightRuntime): unknown {
  const cached = highlightCache.get(scheme);
  if (cached) return cached;
  const specs = syntaxTokenSpecs(scheme).map((spec) => ({ ...spec, tag: resolveSyntaxTag(runtime.tags, spec.tag) }));
  const extension = runtime.syntaxHighlighting(runtime.HighlightStyle.define(specs));
  highlightCache.set(scheme, extension);
  return extension;
}
