import { pluginStore } from "./pluginStore";
import { validateForwardForm, type ForwardFormDraft } from "./portForward";
import { randomUUID } from "./uuid";

const KEY = "ssh-tunnel-profiles";
const MAX_PROFILES = 64;

export interface TunnelProfile extends ForwardFormDraft {
  id: string;
  connectionId: string;
}

function allProfiles(): TunnelProfile[] {
  try {
    const parsed: unknown = JSON.parse(pluginStore.getItem(KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_PROFILES).filter((item): item is TunnelProfile => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === "string" && !!row.id && typeof row.connectionId === "string" && !!row.connectionId
        && (row.kind === "local" || row.kind === "remote" || row.kind === "dynamic")
        && ["listenHost", "listenPort", "targetHost", "targetPort"].every((key) => typeof row[key] === "string")
        && !validateForwardForm(row as unknown as ForwardFormDraft);
    });
  } catch {
    return [];
  }
}

export function loadTunnelProfiles(connectionId: string): TunnelProfile[] {
  return allProfiles().filter((profile) => profile.connectionId === connectionId);
}

export function saveTunnelProfile(connectionId: string, draft: ForwardFormDraft): TunnelProfile {
  if (!connectionId || validateForwardForm(draft)) throw new Error("Invalid tunnel profile");
  const rows = allProfiles();
  const normalized = { ...draft, listenHost: draft.listenHost.trim() || "127.0.0.1", listenPort: draft.listenPort.trim(), targetHost: draft.kind === "dynamic" ? "" : draft.targetHost.trim(), targetPort: draft.kind === "dynamic" ? "" : draft.targetPort.trim() };
  const existing = rows.find((row) => row.connectionId === connectionId && row.kind === normalized.kind && row.listenHost === normalized.listenHost && row.listenPort === normalized.listenPort && row.targetHost === normalized.targetHost && row.targetPort === normalized.targetPort);
  if (existing) return existing;
  if (rows.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} tunnel profiles can be saved`);
  const profile = { id: randomUUID(), connectionId, ...normalized };
  pluginStore.setItem(KEY, JSON.stringify([...rows, profile]));
  return profile;
}

export function deleteTunnelProfile(id: string): void {
  pluginStore.setItem(KEY, JSON.stringify(allProfiles().filter((profile) => profile.id !== id)));
}
