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
