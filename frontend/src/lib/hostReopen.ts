/** Ask DBX to replay the vault-backed connection lifecycle into the sidecar. */
export async function reopenHostConnection(
  api: {
    reopenConnection?: (connectionId: string) => Promise<unknown>;
    request: (method: string, params?: unknown) => Promise<unknown>;
  },
  connectionId: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reopen = api.reopenConnection
      ? api.reopenConnection(connectionId)
      : api.request("host.reopenConnection", { connectionId });
    const result = await Promise.race([
      reopen,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Host connection reopen timed out")), timeoutMs);
      }),
    ]);
    return result !== false && !(typeof result === "object" && result !== null && "success" in result && result.success === false);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
