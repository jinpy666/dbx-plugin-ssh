interface WorkbenchTitleApi {
  readonly capabilities?: { workbenchTitle?: boolean };
  getTitle?(): Promise<string>;
  setTitle?(title: string | null): Promise<unknown>;
}

export function readListedConnectionName(payload: unknown, connectionId: string): string {
  const connections = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { connections?: unknown }).connections)
      ? (payload as { connections: unknown[] }).connections
      : [];
  for (const connection of connections) {
    if (!connection || typeof connection !== "object" || Array.isArray(connection)) continue;
    const entry = connection as { id?: unknown; name?: unknown };
    if (entry.id === connectionId && typeof entry.name === "string") return entry.name.trim();
  }
  return "";
}

export function createWorkbenchTitleSync(api: WorkbenchTitleApi): (name: string) => Promise<void> {
  let sessionSuffix: Promise<string> | undefined;
  let revision = 0;

  return async (name: string) => {
    const connectionName = name.trim();
    const currentRevision = ++revision;
    if (!connectionName || api.capabilities?.workbenchTitle !== true || !api.setTitle) return;

    sessionSuffix ??= api.getTitle
      ? api.getTitle().then((title) => / \(\d+\)$/.exec(title)?.[0] ?? "").catch(() => "")
      : Promise.resolve("");
    const suffix = await sessionSuffix;
    if (currentRevision !== revision) return;
    await api.setTitle(`${connectionName}${suffix}`).catch(() => undefined);
  };
}
