// docker/list 响应归一化（自 DockerPanel 纯搬移）：防收敛不受信任的动态面，
// 只放行形态完整的行；行结构与 DockerContainerList 的 DockerContainerRow
// 结构化一致（lib 不反向依赖组件，由调用方按结构赋值）。

export interface DockerListRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
}

export interface DockerListPayload {
  available: boolean;
  needsSudo: boolean;
  containers: DockerListRow[];
}

export function dockerListPayload(raw: unknown): DockerListPayload {
  const record = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(record.containers) ? record.containers : [];
  const containers: DockerListRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id) continue;
    containers.push({
      id,
      name: typeof entry.name === "string" ? entry.name : "",
      image: typeof entry.image === "string" ? entry.image : "",
      state: typeof entry.state === "string" ? entry.state : "",
      status: typeof entry.status === "string" ? entry.status : "",
      ports: typeof entry.ports === "string" ? entry.ports : "",
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    });
  }
  return {
    available: record.available === true,
    needsSudo: record.needsSudo === true,
    containers,
  };
}
