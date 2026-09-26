/**
 * JSON 格式化预览（issue #96）——纯函数层，供 JsonPreviewPanel.vue 消费。
 *
 * 预览链路（App.vue openEntry）已经把文件头部读进 `previewText`（sftp/read
 * maxBytes = 1 MiB，超限置 truncated）。本模块在这个已解码文本上做三件事：
 *
 * 1. 检测：文件名扩展（.json / .geojson）或无扩展名时的内容嗅探（首个非空白
 *    字符为 { 或 [）。`.jsonl` / `.ndjson` 按行分片的文档显式排除——整篇
 *    pretty-print 会把 N 个独立对象拼成非法 JSON，误导用户（取舍：这类文件
 *    保持原始文本预览）。
 * 2. 降级链：候选 → 截断/超 1 MiB → 原文视图（too-large）；解析失败 → 原文
 *    视图（invalid）；成功 → pretty-print + 字段树（ok）。所有降级都不抛错。
 * 3. 字段树：解析成功后展平为 [{ path, key, value, fullValue, type }]。路径为
 *    JSONPath 风格（$.a.b[0]["weird key"]）；仅收集叶子标量与空容器——复合
 *    子树的复制由 pretty 文本窗格选区承担，避免逐节点 stringify 的 O(n²) 成本。
 *
 * 大小保护：字段行数与递归深度双上限，敌意深宽结构不会拖垮渲染或栈。
 */

/** 超过该字节数（或 truncated）不做 parse/pretty：成本高且截断内容 pretty 无意义。 */
export const JSON_PREVIEW_MAX_BYTES = 1024 * 1024;
/** 字段列表行数上限（防敌意宽结构拖垮 DOM）。 */
export const JSON_PREVIEW_MAX_FIELDS = 2000;
/** 展平递归深度上限（防栈溢出；JSON.parse 自身能承受的深度远小于此）。 */
export const JSON_PREVIEW_MAX_DEPTH = 128;
/** 字符串值的展示截断长度（完整值始终可复制）。 */
export const JSON_PREVIEW_MAX_STRING_DISPLAY = 200;

/** 长字符串展示截断省略号。 */
const ELLIPSIS = "…";

/** 按行分片的 JSON 变体：整篇 pretty 无意义，显式排除在候选之外。 */
const JSON_LINES_EXTENSIONS = new Set(["jsonl", "ndjson"]);
/** 直接以扩展名命中的 JSON 变体。 */
const JSON_EXTENSIONS = new Set(["json", "geojson"]);

export type JsonPreviewFieldType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonPreviewField {
  /** JSONPath 风格路径，根为 `$`。 */
  path: string;
  /** 最后一段的展示名（对象键或数组下标 `[i]`；根为 `$`）。 */
  key: string;
  /** 展示值（长字符串截断；标量字面量）。 */
  value: string;
  /** 复制用完整值（字符串为原文内容，不含引号；空容器为其字面量）。 */
  fullValue: string;
  type: JsonPreviewFieldType;
}

export type JsonPreviewState =
  /** 非 JSON 候选：保持既有纯文本预览，不显示 JSON 面板。 */
  | { kind: "unavailable" }
  /** 截断或超大小上限：仅原文视图（App 已有 truncated 徽标）。 */
  | { kind: "too-large" }
  /** 候选但解析失败：仅原文视图 + 提示条。 */
  | { kind: "invalid" }
  /** 解析成功：pretty 文本 + 可搜索字段树。 */
  | { kind: "ok"; pretty: string; fields: JsonPreviewField[] };

function fileExtension(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  return base.includes(".") ? base.split(".").pop()?.toLowerCase() || "" : "";
}

/** 内容嗅探：首个非空白字符是否为 `{` 或 `[`（仅对无扩展名文件生效，见下）。 */
export function sniffsJsonText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") continue;
    return char === "{" || char === "[";
  }
  return false;
}

/**
 * JSON 预览候选判定（双条件，命中其一即可）：
 * - 扩展名直判：.json / .geojson；
 * - 无扩展名文件按内容首字符嗅探（改名的 config.json 仍可获得格式化预览）。
 * 行分片变体（.jsonl / .ndjson）无论何种条件都不做整篇 pretty。
 */
export function isJsonPreviewCandidate(fileName: string, text: string): boolean {
  const extension = fileExtension(fileName);
  if (JSON_LINES_EXTENSIONS.has(extension)) return false;
  if (JSON_EXTENSIONS.has(extension)) return true;
  if (extension !== "") return false;
  return sniffsJsonText(text);
}

export function jsonValueType(value: unknown): JsonPreviewFieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function truncateDisplay(text: string): string {
  return text.length > JSON_PREVIEW_MAX_STRING_DISPLAY
    ? `${text.slice(0, JSON_PREVIEW_MAX_STRING_DISPLAY)}${ELLIPSIS}`
    : text;
}

/** 键名为合法标识符时用 `.` 连接，否则用 `["..."]` 引用形式。 */
function joinPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * 展平已解析的 JSON 为叶子字段列表。复合节点（非空 object/array）不产出行——
 * 其子树的值复制由 pretty 文本窗格承担；空容器（{}/[]）按叶子行处理。
 */
export function flattenJsonFields(root: unknown): JsonPreviewField[] {
  const fields: JsonPreviewField[] = [];
  const collect = (value: unknown, path: string, key: string, depth: number): void => {
    if (fields.length >= JSON_PREVIEW_MAX_FIELDS || depth > JSON_PREVIEW_MAX_DEPTH) return;
    const type = jsonValueType(value);
    if (type === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        fields.push({ path, key, value: "{}", fullValue: "{}", type });
        return;
      }
      for (const [childKey, childValue] of entries) {
        collect(childValue, joinPath(path, childKey), childKey, depth + 1);
      }
      return;
    }
    if (type === "array") {
      const items = value as unknown[];
      if (items.length === 0) {
        fields.push({ path, key, value: "[]", fullValue: "[]", type });
        return;
      }
      items.forEach((item, index) => collect(item, `${path}[${index}]`, `[${index}]`, depth + 1));
      return;
    }
    const fullValue = type === "string" ? (value as string) : type === "null" ? "null" : String(value);
    fields.push({ path, key, value: truncateDisplay(fullValue), fullValue, type });
  };
  collect(root, "$", "$", 0);
  return fields;
}

/** 字段列表搜索：对路径与展示值做大小写不敏感子串匹配（纯前端 filter）。 */
export function filterJsonFields(fields: JsonPreviewField[], query: string): JsonPreviewField[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return fields;
  return fields.filter((field) => field.path.toLowerCase().includes(needle) || field.value.toLowerCase().includes(needle));
}

function byteLengthOf(text: string): number {
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return text.length;
  }
}

/**
 * 预览构建主入口：检测 → 大小门 → 解析 →（pretty + 字段树）。
 * 任何失败都降级为可显示的状态，绝不抛错（调用方在 computed 内直接消费）。
 */
export function buildJsonPreview(
  fileName: string,
  text: string,
  options: { truncated?: boolean; byteLength?: number } = {},
): JsonPreviewState {
  if (!isJsonPreviewCandidate(fileName, text)) return { kind: "unavailable" };
  const byteLength = options.byteLength ?? byteLengthOf(text);
  if (options.truncated === true || byteLength > JSON_PREVIEW_MAX_BYTES) return { kind: "too-large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "ok", pretty: `${JSON.stringify(parsed, null, 2)}\n`, fields: flattenJsonFields(parsed) };
}
