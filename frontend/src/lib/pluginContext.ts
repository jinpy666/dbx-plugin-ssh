// PR-A4 context.plugin namespace (HOST_PLUGIN_UI_SPEC §4/§7.5/§11): the plugin payload
// Plugin payload goes only into context.plugin; workbenchId/restored/surface/connectionId are host-reserved
// fields are injected by the host into the final context and must never be forged by the plugin. Local-terminal
// `plugin.mode === "local-terminal"` — the legacy top-level `{ localTerminal: true }`
// shape was removed with the host A1 contract (hard switch on both read and write sides in-repo, no dual-read compat). Pure functions.
import { normalizeConnectionText } from "./connectionInfo";

/**
 * Reads `context.plugin.mode`; missing/non-object/array payloads or a non-string mode return
 * empty string; callers compare against a concrete mode name (`readPluginMode(ctx) === "local-terminal"`).
 */
export function readPluginMode(context: Record<string, unknown> | undefined | null): string {
  const plugin = context?.plugin;
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) return "";
  const mode = (plugin as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode : "";
}

/**
 * Host-authoritative workbenchId: injected by Host API 1.1+; legacy hosts (1.0, which do not inject the
 * field) fall back to the caller's locally generated id, keeping sessions scoped per workbench instance.
 */
export function resolveWorkbenchId(context: Record<string, unknown> | undefined | null, fallback: string): string {
  return normalizeConnectionText(context?.workbenchId) || fallback;
}

/**
 * Reads `context.plugin.shell` — when the bottom dock "+" creates a local terminal it starts the
 * selected type (e.g. zsh/fish); when absent or default it falls back to the caller's shell preference.
 */
export function readPluginShell(context: Record<string, unknown> | undefined | null): string {
  const plugin = context?.plugin;
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) return "";
  const shell = (plugin as Record<string, unknown>).shell;
  return typeof shell === "string" ? shell.trim() : "";
}
