// dbx-plugin-ssh facade（非上游代码）：`@aws/…-api-bindings-wrappers` 替代。
// 上游经此访问 Fig/AmazonQ 桌面宿主（设置、shell 执行）。插件内：
// - 设置一律缺省（FIRST_COMMAND_COMPLETION=false，避免首 token 触发登录 shell
//   的命令枚举 generator——那是要在目标机执行命令的面，批次 1 必须关闭）；
// - shell 执行抛 unsupported（§43 降级语义）：同步补全路径绝不执行命令，
//   批次 2 才经 `completion/execute` 注入目标机执行器。

export class HostBridgeUnsupportedError extends Error {
  constructor(operation: string) {
    super(`fig autocomplete host bridge unsupported: ${operation}`);
    this.name = "HostBridgeUnsupportedError";
  }
}

export const SETTINGS = {
  FIRST_COMMAND_COMPLETION: "firstCommandCompletion",
  PERSONAL_SHORTCUTS_TOKEN: "personalShortcutsToken",
  DISABLE_FOR_COMMANDS: "disableForCommands",
  DEV_COMPLETIONS_FOLDER: "devCompletionsFolder",
  DEV_COMPLETIONS_SERVER_PORT: "devCompletionsServerPort",
  DEV_MODE_NPM: "devModeNpm",
  DEV_MODE_NPM_INVALIDATE_CACHE: "devModeNpmInvalidateCache",
} as const;

export const getSetting = (name: string): unknown =>
  name === SETTINGS.FIRST_COMMAND_COMPLETION ? false : undefined;

export const isInDevMode = (): boolean => false;

export const executeCommand = async (
  _command: unknown,
  _options?: unknown,
): Promise<{ stdout: string; stderr: string; status: number }> => {
  throw new HostBridgeUnsupportedError("executeCommand");
};

export const executeLoginShell = async (
  _command: unknown,
): Promise<{ stdout: string }> => {
  throw new HostBridgeUnsupportedError("executeLoginShell");
};
