/**
 * Docker/Podman 引擎连接设置（面板齿轮弹层）：容器 CLI 命令与守护进程端点
 * （unix socket / tcp host）三参数的归一、校验与按连接持久化。字段语义与
 * sidecar docker/list|logs|action 的可选 cli/socket/host 参数一一对应：
 * 端点由 sidecar 经 DOCKER_HOST/CONTAINER_HOST 环境变量下发，Docker 与
 * Podman 各取所需，一处设置两个引擎通用。本模块只做纯逻辑与 pluginStore
 * 持久化（宿主 host.storage，Host API 1.2；RPC 调用留在 DockerPanel）。
 */

import { pluginStore } from "./pluginStore";

export interface DockerEngineSettings {
  /** 容器 CLI：二进制名或全路径；空串 = 默认 docker。 */
  cli: string;
  /** daemon unix socket；空串 = 引擎默认。与 host 互斥。 */
  socket: string;
  /** daemon tcp 端点（如 127.0.0.1:2375）；空串 = 引擎默认。与 socket 互斥。 */
  host: string;
}

export const DEFAULT_DOCKER_CLI = "docker";

/** 与 sidecar 同口径的字符白名单（shell/cmd 双惰性），避免怪字符下探到脚本。 */
export const DOCKER_CLI_PATTERN = /^[A-Za-z0-9_.\\/:/-]{1,256}$/;
export const DOCKER_ENDPOINT_PATTERN = /^[A-Za-z0-9_.\\/:/-]{1,512}$/;

/** 宿主 storage 单键：值是 connectionKey（空串归一为 "local"）→ settings 的
 *  JSON 映射。按连接的动态键无法进 PLUGIN_STORE_KEYS 的创建期声明，见
 *  pluginStore.ts 内注释。 */
export const DOCKER_ENGINE_STORE_KEY = "ssh-docker-engine";

export const EMPTY_DOCKER_ENGINE_SETTINGS: DockerEngineSettings = {
  cli: "",
  socket: "",
  host: "",
};

export interface DockerEngineValidation {
  settings: DockerEngineSettings;
  errors: { cli?: string; endpoints?: string };
}

/** 端点形状与 sidecar normalize_endpoint 同口径：显式 scheme 直通，
 * `/` 开头按 unix socket，含 `:` 按 tcp host:port，其余非法。 */
export function isDockerEndpointShape(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    lower.startsWith("unix://") ||
    lower.startsWith("tcp://") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("npipe:")
  ) {
    return true;
  }
  return value.startsWith("/") || value.includes(":");
}

/**
 * 归一并校验原始输入：trim、字符白名单、端点形状、socket/host 互斥。
 * cli 空串合法（= 默认 docker）；返回的 errors 为空即可保存生效。
 */
export function validateDockerEngineSettings(raw: Partial<DockerEngineSettings>): DockerEngineValidation {
  const cli = (raw.cli ?? "").trim();
  const socket = (raw.socket ?? "").trim();
  const host = (raw.host ?? "").trim();
  const errors: DockerEngineValidation["errors"] = {};
  if (cli && !DOCKER_CLI_PATTERN.test(cli)) {
    errors.cli = "invalid";
  }
  if (socket && host) {
    errors.endpoints = "conflict";
  } else if ((socket && (!DOCKER_ENDPOINT_PATTERN.test(socket) || !isDockerEndpointShape(socket))) || (host && (!DOCKER_ENDPOINT_PATTERN.test(host) || !isDockerEndpointShape(host)))) {
    errors.endpoints = "invalid";
  }
  return { settings: { cli, socket, host }, errors };
}

/** 面板随每次 invoke 携带的附加参数：空串剔除，非空原样透传（归一在 sidecar）。 */
export function dockerEngineParams(settings: DockerEngineSettings): Record<string, string> {
  const params: Record<string, string> = {};
  if (settings.cli) params.cli = settings.cli;
  if (settings.socket) params.socket = settings.socket;
  if (settings.host) params.host = settings.host;
  return params;
}

/** 单键映射读取：缺键/损坏 JSON 一律回落空映射（损坏不弹错，全量重置）。 */
function loadEngineMap(): Record<string, DockerEngineSettings> {
  const raw = pluginStore.getItem(DOCKER_ENGINE_STORE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, DockerEngineSettings>;
  } catch {
    return {};
  }
}

/** localStorage 读取；损坏/缺失/非法回落（非法字段单独剔除，合法字段保留）。
 *  pluginStore 在 main.ts boot 时 await ready 完成水合，此后读取全同步
 *  （面板内调用）。 */
export function loadDockerEngineSettings(connectionKey: string): DockerEngineSettings {
  const record = loadEngineMap()[connectionKey || "local"];
  if (!record || typeof record !== "object") return { ...EMPTY_DOCKER_ENGINE_SETTINGS };
  const stringOf = (key: keyof DockerEngineSettings): string =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  const { settings, errors } = validateDockerEngineSettings({
    cli: stringOf("cli"),
    socket: stringOf("socket"),
    host: stringOf("host"),
  });
  // 存量数据可能早于当前校验口径：非法字段剔除而不是让整份设置失效。
  return {
    cli: errors.cli ? "" : settings.cli,
    socket: errors.endpoints ? "" : settings.socket,
    host: errors.endpoints ? "" : settings.host,
  };
}

export function saveDockerEngineSettings(connectionKey: string, settings: DockerEngineSettings): void {
  const map = loadEngineMap();
  map[connectionKey || "local"] = settings;
  // pluginStore 写穿宿主桥（沙箱/配额失败仅告警不阻断，见 pluginStorage）。
  pluginStore.setItem(DOCKER_ENGINE_STORE_KEY, JSON.stringify(map));
}
