/**
 * Docker 面板 mock 夹具（B2 容器指标）：镜像 sidecar `docker/stats` 的响应
 * 形状，供 mock.html 视觉走查与前端单测使用。只在 mockDbxHost 里被调用，
 * 生产构建不打包（mockDbxHost 仅在 `?mock` 模式动态加载）。
 *
 * 契约（docs/PROTOCOL.zh-CN.md「Docker 管理面板」）：
 * `{available, needsSudo, sampledAt, stats: [{containerId, name, cpuPercent,
 * memBytes, memLimitBytes, memPercent, netRxBytes, netTxBytes, netRxRate,
 * netTxRate, blockReadBytes, blockWriteBytes, pids}]}`。
 * 与计划 §2.1 一致：未运行的容器可能被 CLI 跳过（数组里没有该 id；Docker 29
 * 等版本对显式指定的已停止容器返回 0 值行，解析端两种都接受）；
 * `?docker=off` → available:false，`?docker=sudo` → needsSudo:true。
 */

const MAX_CONTAINERS = 50;
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;

interface MockStatRow {
  name: string;
  running: boolean;
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

/** 与 docker/list 夹具同一批容器；exited 的 db-postgres 不在 stats 输出里。 */
const KNOWN_ROWS: Record<string, MockStatRow> = {
  "d4a7c9f1e2b3a1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7": {
    name: "web-nginx",
    running: true,
    cpuPercent: 1.8,
    memBytes: 29_780_787,
    memLimitBytes: 8_266_908_057,
    netRxBytes: 1_284_500,
    netTxBytes: 862_000,
    blockReadBytes: 4_500_000,
    blockWriteBytes: 1_200_000,
    pids: 9,
  },
  "9f8e7d6c5b4a": {
    name: "cache-redis",
    running: true,
    cpuPercent: 0.4,
    memBytes: 12_582_912,
    memLimitBytes: 2_040_109_465,
    netRxBytes: 340_000,
    netTxBytes: 120_000,
    blockReadBytes: 900_000,
    blockWriteBytes: 640_000,
    pids: 5,
  },
  "1a2b3c4d5e6f": {
    name: "db-postgres",
    running: false,
    cpuPercent: 0,
    memBytes: 0,
    memLimitBytes: 0,
    netRxBytes: 0,
    netTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    pids: 0,
  },
  "0f1e2d3c4b5a": {
    name: "worker-queue",
    running: true, // paused 仍算运行中：stats 给 0 CPU
    cpuPercent: 0,
    memBytes: 41_943_040,
    memLimitBytes: 1_073_741_824,
    netRxBytes: 52_000,
    netTxBytes: 18_000,
    blockReadBytes: 120_000,
    blockWriteBytes: 30_000,
    pids: 12,
  },
};

function fallbackRow(id: string): MockStatRow {
  const seed = Number.parseInt(id.slice(-4), 16) || 1;
  return {
    name: `container-${id.slice(0, 8)}`,
    running: true,
    cpuPercent: Math.round((seed % 800) / 100) / 10,
    memBytes: 16 * 1024 * 1024 + (seed % 4096) * 1024,
    memLimitBytes: 2 * 1024 * 1024 * 1024,
    netRxBytes: 100_000 + (seed % 1000) * 128,
    netTxBytes: 50_000 + (seed % 500) * 64,
    blockReadBytes: 500_000,
    blockWriteBytes: 200_000,
    pids: 2 + (seed % 20),
  };
}

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid containerIds: expected an array of 1-50 container ids");
  }
  if (raw.length === 0 || raw.length > MAX_CONTAINERS) {
    throw new Error(`Invalid containerIds: expected 1-${MAX_CONTAINERS} ids, got ${raw.length}`);
  }
  const ids: string[] = [];
  for (const entry of raw) {
    const id = String(entry);
    if (!CONTAINER_ID_RE.test(id)) {
      throw new Error(`Invalid containerId '${id}': expected 12-64 lowercase hex characters`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `docker/stats` 的 mock 响应；`mode` 来自 URL 的 `?docker=off|sudo`。 */
export function mockDockerStatsPayload(
  params: Record<string, unknown>,
  mode?: string | null,
): Record<string, unknown> {
  const sampledAt = Date.now();
  if (mode === "off") {
    return { available: false, needsSudo: false, sampledAt, stats: [] };
  }
  if (mode === "sudo") {
    return { available: false, needsSudo: true, sampledAt, stats: [] };
  }
  const ids = parseIds(params.containerIds);
  const stats = ids.flatMap((containerId, index) => {
    const row = KNOWN_ROWS[containerId] ?? fallbackRow(containerId);
    if (!row.running) return [];
    return [
      {
        containerId,
        name: row.name,
        cpuPercent: row.cpuPercent,
        memBytes: row.memBytes,
        memLimitBytes: row.memLimitBytes,
        memPercent:
          row.memLimitBytes > 0
            ? Math.round((row.memBytes / row.memLimitBytes) * 10_000) / 100
            : 0,
        netRxBytes: row.netRxBytes,
        netTxBytes: row.netTxBytes,
        // sidecar 的差分值：mock 里给稳定速率，让指标条不走「首帧 0」路径。
        netRxRate: 12_000 + index * 3_000,
        netTxRate: 4_000 + index * 1_500,
        blockReadBytes: row.blockReadBytes,
        blockWriteBytes: row.blockWriteBytes,
        pids: row.pids,
      },
    ];
  });
  return { available: true, needsSudo: false, sampledAt, stats };
}

// —— B4 容器文件（只读 list/read）—————————————————————————

const FILES_TREE: Record<string, Array<{ name: string; kind: "file" | "dir" | "link" | "other"; size: number }>> = {
  "/": [
    { name: "etc", kind: "dir", size: 0 },
    { name: "var", kind: "dir", size: 0 },
    { name: "home", kind: "dir", size: 0 },
    { name: "tmp", kind: "dir", size: 0 },
    { name: "app.log", kind: "file", size: 24_576 },
    { name: "current", kind: "link", size: 0 },
    { name: ".dockerenv", kind: "file", size: 0 },
  ],
  "/etc": [
    { name: "nginx", kind: "dir", size: 0 },
    { name: "hostname", kind: "file", size: 12 },
    { name: "os-release", kind: "file", size: 384 },
  ],
  "/etc/nginx": [{ name: "nginx.conf", kind: "file", size: 1_482 }],
  "/var": [
    { name: "log", kind: "dir", size: 0 },
    { name: "lib", kind: "dir", size: 0 },
  ],
  "/var/log": [
    { name: "nginx", kind: "dir", size: 0 },
    { name: "messages", kind: "file", size: 92_132 },
  ],
  "/home": [{ name: "user", kind: "dir", size: 0 }],
  "/home/user": [
    { name: "server.js", kind: "file", size: 2_048 },
    { name: ".env", kind: "file", size: 64 },
  ],
};

function normalizeFilesPath(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value || !value.startsWith("/")) {
    throw new Error(`Invalid path '${value}': expected an absolute container path`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes("..") || value.startsWith("//")) {
    throw new Error(`Invalid path '${value}': rejected by the path gate`);
  }
  return value.length > 1 ? value.replace(/\/+$/, "") || "/" : value;
}

function requireFileContainer(params: Record<string, unknown>): string {
  const containerId = String(params.containerId ?? "");
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new Error(`Invalid containerId '${containerId}': expected 12-64 lowercase hex characters`);
  }
  return containerId;
}

/** `docker/files/list` 的 mock 响应（最多 500 条，size 仅普通文件）。 */
export function mockDockerFilesListing(params: Record<string, unknown>): Record<string, unknown> {
  requireFileContainer(params);
  const path = normalizeFilesPath(params.path);
  const showHidden = params.showHidden === true;
  const entries = (FILES_TREE[path] ?? [])
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
      kind: entry.kind,
      size: entry.kind === "file" ? entry.size : 0,
    }));
  return { path, entries, truncated: false };
}

const SAMPLE_FILE_TEXT = "hello from the container fixture\n";

/** `docker/files/read` 的 mock 响应；路径不存在时像 sidecar 一样报错。 */
export function mockDockerFileRead(params: Record<string, unknown>): Record<string, unknown> {
  requireFileContainer(params);
  const path = normalizeFilesPath(params.path);
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const entry = (FILES_TREE[parent] ?? []).find((item) => item.name === name);
  if (!entry || entry.kind !== "file") {
    throw new Error("docker/files/read: not a regular file");
  }
  const maxBytes = Number(params.maxBytes ?? 1024 * 1024);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 8 * 1024 * 1024) : 1024 * 1024;
  const bytes = new TextEncoder().encode(SAMPLE_FILE_TEXT);
  const shown = bytes.slice(0, Math.min(bytes.length, limit));
  const base64 = typeof btoa === "function" ? btoa(String.fromCharCode(...shown)) : "";
  return {
    path,
    dataBase64: base64,
    size: bytes.length,
    truncated: bytes.length > shown.length,
  };
}
