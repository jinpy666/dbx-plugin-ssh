// dbx-plugin-ssh facade（非上游代码）：替代上游 `autocomplete-parser/src/loadSpec.ts`
// （相对别名 `./loadSpec.js`）。上游该文件是文件系统/CDN/本地 `.fig/` 目录的
// spec 加载面（fs 语义 + 宿主设置 + shell 探测）；本插件的 spec 来源是
// `frontend/vendor/fig-specs/spec-manifest.generated.ts`（静态 bundled，决策
// D2'），由 `figCompletionSource` 的注册表在同步驱动内直接解析，不经过本文件。
// 保留同名导出只为打包期解析成立；任何误调用按 §43 降级语义抛 unsupported。

import { HostBridgeUnsupportedError } from "./apiBindingsWrappers.js";

export const serializeSpecLocation = (location: {
  type: string;
  name: string;
  path?: string;
}): string =>
  location.type === "global"
    ? `global://name=${location.name}`
    : `local://path=${location.path ?? ""}&name=${location.name}`;

export const getSpecPath = async (
  _name: string,
  _cwd: string,
  _isScript?: boolean,
): Promise<never> => {
  throw new HostBridgeUnsupportedError("getSpecPath");
};

export const loadSubcommandCached = async (
  _specLocation: unknown,
  _context?: unknown,
): Promise<never> => {
  throw new HostBridgeUnsupportedError("loadSubcommandCached");
};
