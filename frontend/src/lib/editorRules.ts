// 外部编辑器配置与「按扩展名映射编辑器」的解析规则（纯函数为主）。
//
// 参照 WinSCP Preferences→Editors 的「文件掩码 → 编辑器」关联模型：右键
// 「在外部编辑器中打开」先按文件名匹配关联表，命中则用映射的编辑器打开
// （known 目录项或用户自定义命令），未命中回落默认编辑器/系统默认程序。
// 配置整体持久化在 pluginStore 单键 JSON（`ssh-editor-config`，宿主 storage
// 水合后可读），App 与设置弹窗共用本模块的拆装与净化函数，避免字面量分叉。

import { pluginStore } from "./pluginStore";

/** 单键 JSON 的存储键（必须在 PLUGIN_STORE_KEYS 白名单内，见 pluginStore.ts）。 */
export const EDITOR_CONFIG_KEY = "ssh-editor-config";

/** sidecar 知名编辑器目录（local/editors/list）的条目。 */
export interface KnownEditor {
  id: string;
  name: string;
  available: boolean;
  launch:
    | { kind: "openApp"; appId: string }
    | { kind: "exe"; exe: string; args: string[] };
  suggestedExtensions: string[];
}

/** 用户自定义编辑器：一条完整命令行（含可选 {file} 占位符），sidecar
 * `local/open-with` 的 custom 通道原样透传。 */
export interface CustomEditor {
  id: string;
  name: string;
  command: string;
}

/** 一条「文件掩码 → 编辑器」关联。editorId/customId 二选一，指向
 * known 目录项或自定义编辑器；两者都无效时该条目按未命中处理。 */
export interface EditorAssociation {
  pattern: string;
  editorId?: string;
  customId?: string;
}

/** 保存后回传策略：auto = FinalShell 式保存即静默回传；ask = 每次弹确认。 */
export type ExternalEditUploadPolicy = "auto" | "ask";

export interface EditorConfig {
  defaultEditorId?: string;
  defaultCustomId?: string;
  associations: EditorAssociation[];
  customEditors: CustomEditor[];
  uploadPolicy: ExternalEditUploadPolicy;
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  associations: [],
  customEditors: [],
  uploadPolicy: "auto",
};

const MAX_ASSOCIATIONS = 200;
const MAX_CUSTOM_EDITORS = 50;

/** 自定义编辑器 id（crypto 不可用时退化为时间戳+随机，够本地唯一即可）。 */
export function newCustomEditorId(): string {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 脏数据净化：任一字段不合法即丢弃该条目，整体结构回到可用形态。
 * 与 sanitizeCompletionEngine 同一守则——存储值永远不可信。 */
export function sanitizeEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_EDITOR_CONFIG };
  const raw = value as Record<string, unknown>;
  const customEditors: CustomEditor[] = Array.isArray(raw.customEditors)
    ? raw.customEditors
        .map((item): CustomEditor | undefined => {
          if (!item || typeof item !== "object") return undefined;
          const entry = item as Record<string, unknown>;
          const id = typeof entry.id === "string" ? entry.id.trim() : "";
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          const command = typeof entry.command === "string" ? entry.command.trim() : "";
          if (!id || !command) return undefined;
          return { id, name: name || id, command };
        })
        .filter((item): item is CustomEditor => !!item)
        .slice(0, MAX_CUSTOM_EDITORS)
    : [];
  const customIds = new Set(customEditors.map((item) => item.id));
  const associations: EditorAssociation[] = Array.isArray(raw.associations)
    ? raw.associations
        .map((item): EditorAssociation | undefined => {
          if (!item || typeof item !== "object") return undefined;
          const entry = item as Record<string, unknown>;
          const pattern =
            typeof entry.pattern === "string" ? entry.pattern.trim() : "";
          if (!pattern) return undefined;
          const editorId =
            typeof entry.editorId === "string" && entry.editorId ? entry.editorId : undefined;
          const customId =
            typeof entry.customId === "string" && entry.customId ? entry.customId : undefined;
          // 指向已不存在的自定义编辑器的关联没有意义，整条丢弃。
          if (!editorId && !customId) return undefined;
          if (customId && !customIds.has(customId)) return undefined;
          return editorId ? { pattern, editorId } : { pattern, customId };
        })
        .filter((item): item is EditorAssociation => !!item)
        .slice(0, MAX_ASSOCIATIONS)
    : [];
  const defaultEditorId =
    typeof raw.defaultEditorId === "string" && raw.defaultEditorId
      ? raw.defaultEditorId
      : undefined;
  const defaultCustomId =
    typeof raw.defaultCustomId === "string" && raw.defaultCustomId
      ? raw.defaultCustomId
      : undefined;
  return {
    defaultEditorId,
    defaultCustomId: defaultCustomId && customIds.has(defaultCustomId) ? defaultCustomId : undefined,
    associations,
    customEditors,
    uploadPolicy: raw.uploadPolicy === "ask" ? "ask" : "auto",
  };
}

/** 单键 JSON 读取（存储不可用/损坏时回默认，永不抛出）。 */
export function loadEditorConfig(): EditorConfig {
  try {
    const raw = pluginStore.getItem(EDITOR_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_EDITOR_CONFIG };
    return sanitizeEditorConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_EDITOR_CONFIG };
  }
}

/** 单键 JSON 写入（失败静默——宿主 storage 不可用时仅本次会话内存态）。 */
export function saveEditorConfig(config: EditorConfig): void {
  try {
    pluginStore.setItem(EDITOR_CONFIG_KEY, JSON.stringify(sanitizeEditorConfig(config)));
  } catch {
    /* 存储不可用：保持内存态，下次启动回落默认 */
  }
}

/** 文件名 → 小写扩展名串（含多点，"a.tar.gz" → ".tar.gz"）；点文件与无扩展名返回 ""。 */
export function extensionOf(fileName: string): string {
  const name = fileName.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot);
}

/** 关联模式归一：trim + 小写；".log"/"*.log" 统一成扩展名语义，不带
 * 星号也不带点的前缀（如 "log"）按精确文件名匹配处理。 */
function normalizedPattern(pattern: string): string {
  const text = pattern.trim().toLowerCase();
  return text;
}

interface AssociationMatch {
  association: EditorAssociation;
  /** 精确文件名 > 更长扩展；同分先到先得。 */
  score: [exact: number, extLength: number, order: number];
}

/** 文件名 → 关联解析：精确文件名（"Makefile"）优先于扩展名（"*.log"），
 * 扩展名按更长者优先（"*.tar.gz" 胜 "*.gz"），同分按列表顺序取最先。 */
export function associationFor(
  fileName: string,
  associations: EditorAssociation[],
): EditorAssociation | undefined {
  const lower = fileName.toLowerCase();
  let best: AssociationMatch | undefined;
  associations.forEach((association, order) => {
    const pattern = normalizedPattern(association.pattern);
    if (!pattern) return;
    if (!pattern.includes("*") && !pattern.startsWith(".")) {
      if (pattern === lower) {
        const score: AssociationMatch["score"] = [1, 0, order];
        if (!best || best.score[0] < 1) best = { association, score };
      }
      return;
    }
    const ext = pattern.replace(/^\*+/, "").startsWith(".")
      ? pattern.replace(/^\*+/, "")
      : `.${pattern.replace(/^\*+/, "")}`;
    if (ext === ".") return;
    // 以扩展名为界匹配完整文件名："*.tar.gz" 也能命中 "a.tar.gz"，
    // 而 "*.gz" 同样命中（更长的模式按 ext 长度胜出）。
    if (lower.endsWith(ext)) {
      const score: AssociationMatch["score"] = [0, ext.length, order];
      const better =
        !best ||
        score[0] > best.score[0] ||
        (score[0] === best.score[0] &&
          (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])));
      if (better) best = { association, score };
    }
  });
  return best?.association;
}

/** 为文件名生成默认掩码（设置面板与「记住为默认」的初始值）：无扩展名的
 * 文件（Makefile/.hidden）用文件名本身，其余用 "*.ext"（多点保留）。 */
export function defaultPatternFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return fileName || "*";
  return `*${fileName.slice(dot).toLowerCase()}`;
}

/** 打开目标的解析结果：known 目录项 / 自定义编辑器 / 系统默认程序。 */
export type ResolvedEditor =
  | { kind: "known"; editor: KnownEditor }
  | { kind: "custom"; editor: CustomEditor }
  | { kind: "system" };

/** 关联/默认指向的编辑器 → 可执行解析体（id 失效时返回 undefined 让调用方回落）。 */
function resolveById(
  editorId: string | undefined,
  customId: string | undefined,
  knownById: Map<string, KnownEditor>,
  customById: Map<string, CustomEditor>,
): { kind: "known"; editor: KnownEditor } | { kind: "custom"; editor: CustomEditor } | undefined {
  if (customId) return customById.has(customId) ? { kind: "custom", editor: customById.get(customId)! } : undefined;
  if (editorId) return knownById.has(editorId) ? { kind: "known", editor: knownById.get(editorId)! } : undefined;
  return undefined;
}

/** 打开入口的完整决策：关联表 → 默认编辑器 → 系统默认程序。
 * 关联/默认指向 unavailable 的 known 编辑器时视为未命中（继续回落），
 * 指向自定义编辑器则信任用户配置（sidecar 启动失败会回报错误）。 */
export function resolveEditorForFile(
  fileName: string,
  config: EditorConfig,
  knownEditors: KnownEditor[],
): ResolvedEditor {
  const knownById = new Map(knownEditors.map((editor) => [editor.id, editor]));
  const customById = new Map(config.customEditors.map((editor) => [editor.id, editor]));
  const association = associationFor(fileName, config.associations);
  if (association) {
    const resolved = resolveById(association.editorId, association.customId, knownById, customById);
    if (resolved && !(resolved.kind === "known" && !resolved.editor.available)) {
      return resolved;
    }
  }
  const fallback = resolveById(config.defaultEditorId, config.defaultCustomId, knownById, customById);
  if (fallback) {
    if (fallback.kind === "custom") return fallback;
    if (fallback.editor.available) return fallback;
  }
  return { kind: "system" };
}
