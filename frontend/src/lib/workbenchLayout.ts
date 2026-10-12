export type SshWorkbenchPaneOrder = "terminal-left" | "sftp-left";

export function getSshWorkbenchSplitLayout(order: SshWorkbenchPaneOrder) {
  const reversed = order === "sftp-left";
  return {
    rtl: reversed,
    flexDirection: reversed ? "row-reverse" : "row",
  } as const;
}

/**
 * Resolves the SFTP pane visibility for a restored workbench: the persisted
 * per-workbench flag wins; a fresh workbench falls back to the global
 * "open by default" preference.
 */
export function resolveSftpPaneOpen(state: { sftpPaneOpen?: unknown }, defaultOpen: boolean): boolean {
  return typeof state.sftpPaneOpen === "boolean" ? state.sftpPaneOpen : defaultOpen;
}

/**
 * Parses the persisted global preference ("true" = open the SFTP pane on new
 * workbenches; anything else, including missing values, keeps the global
 * default of a terminal-only workbench).
 */
export function sanitizeSftpPaneDefaultOpen(raw: string | null): boolean {
  return raw === "true";
}

/**
 * Resolves the directory-follow switch for a restored workbench: the persisted
 * per-workbench flag wins; a fresh workbench falls back to the global
 * preference persisted by the pluginStore (see sanitizeDirectoryFollowPref).
 */
export function resolveDirectoryFollow(state: { followDirectory?: unknown }, followByDefault: boolean): boolean {
  return typeof state.followDirectory === "boolean" ? state.followDirectory : followByDefault;
}

/**
 * Parses the persisted global directory-follow preference. Default is OFF:
 * only the explicit opt-in makes new workbenches start with the switch on.
 */
export function sanitizeDirectoryFollowPref(raw: string | null): boolean {
  return raw === "true";
}

/**
 * Parses the persisted global SFTP auto-connect preference. Default is ON:
 * only the explicit "false" opts out of prefetching the remote listing on
 * connect (issue #179 — servers without an SFTP subsystem surface an error
 * banner on every connect otherwise).
 */
export function sanitizeSftpAutoConnectPref(raw: string | null): boolean {
  return raw !== "false";
}

/**
 * Decides whether opening the SFTP pane should fire the session's first
 * directory load (the lazy connect path when auto-connect is off). A pane
 * that stayed open, a listing already fetched, or no live session must not
 * re-trigger it.
 */
export function shouldLazyLoadSftpListing(input: { paneOpen: boolean; sessionLive: boolean; listingLoaded: boolean }): boolean {
  return input.paneOpen && input.sessionLive && !input.listingLoaded;
}

// —— 跨重启的布局/视图全局偏好（issue #178）——
// workbenchState 按 sessionId 键控，重启后 SSH 重连是新会话，旧状态读不回，
// 于是「终端移左 / SFTP 面板开合 / 列显隐与列宽 / 显示隐藏文件 / 排序」全部
// 回落硬编码默认。这层全局偏好（pluginStore 单键 JSON）记录最近一次的布局
// 与视图状态：启动时作为新工作台初始值；workbenchState 的会话恢复仍优先
// （恢复字段存在即覆盖偏好值）。

/** 偏好里允许出现的排序列（与 App 的 SftpSortColumn 同集合）。 */
const LAYOUT_SORT_COLUMNS = ["name", "size", "modified"] as const;

export interface WorkbenchLayoutPrefs {
  paneOrder?: SshWorkbenchPaneOrder;
  splitRatio?: number;
  sftpPaneOpen?: boolean;
  visibleColumns?: string[];
  sftpColumnWidths?: Record<string, number>;
  sftpNameWidth?: number;
  showHidden?: boolean;
  sort?: { column: (typeof LAYOUT_SORT_COLUMNS)[number]; direction: "asc" | "desc" };
}

/**
 * 解析 pluginStore 的布局偏好档：JSON 对象逐字段校验，只收合法值（列宽只做
 * 数值检查，min/max 钳制由 App 侧恢复逻辑按列宽表执行）。非法/缺字段直接
 * 丢弃——调用方以「字段未出现」处理（保持当前值/默认）。非对象或 JSON 损坏
 * 返回 null（视为无偏好档）。
 */
export function sanitizeWorkbenchLayoutPrefs(raw: unknown): WorkbenchLayoutPrefs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const prefs: WorkbenchLayoutPrefs = {};
  if (source.paneOrder === "terminal-left" || source.paneOrder === "sftp-left") prefs.paneOrder = source.paneOrder;
  if (typeof source.splitRatio === "number" && Number.isFinite(source.splitRatio) && source.splitRatio >= 35 && source.splitRatio <= 80) prefs.splitRatio = source.splitRatio;
  if (typeof source.sftpPaneOpen === "boolean") prefs.sftpPaneOpen = source.sftpPaneOpen;
  if (Array.isArray(source.visibleColumns) && source.visibleColumns.every((column): column is string => typeof column === "string")) prefs.visibleColumns = source.visibleColumns;
  if (source.sftpColumnWidths && typeof source.sftpColumnWidths === "object" && !Array.isArray(source.sftpColumnWidths)) {
    const widths: Record<string, number> = {};
    for (const [column, value] of Object.entries(source.sftpColumnWidths as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) widths[column] = value;
    }
    prefs.sftpColumnWidths = widths;
  }
  if (typeof source.sftpNameWidth === "number" && Number.isFinite(source.sftpNameWidth)) prefs.sftpNameWidth = source.sftpNameWidth;
  if (typeof source.showHidden === "boolean") prefs.showHidden = source.showHidden;
  if (source.sort && typeof source.sort === "object" && !Array.isArray(source.sort)) {
    const sort = source.sort as { column?: unknown; direction?: unknown };
    if ((LAYOUT_SORT_COLUMNS as readonly string[]).includes(sort.column as string) && (sort.direction === "asc" || sort.direction === "desc")) {
      prefs.sort = { column: sort.column as (typeof LAYOUT_SORT_COLUMNS)[number], direction: sort.direction };
    }
  }
  return prefs;
}
