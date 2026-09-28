/**
 * Translates raw sidecar/SFTP error strings into friendly localized messages
 * for the SFTP banner. Unrecognized messages pass through untouched so rare
 * server-specific errors keep their original detail.
 */
export function friendlySftpError(
  message: string,
  t: (key: string) => string,
): string | undefined {
  if (isPermissionDeniedError(message)) return t("errors.permissionDenied");
  if (/no such file|does not exist|doesn't exist/i.test(message)) return t("errors.remoteNotFound");
  return undefined;
}

/** 权限类失败（登录用户读不了目标目录/文件的常见形态，大小写不敏感）。 */
export function isPermissionDeniedError(message: string): boolean {
  return /permission denied|access denied|not permitted/i.test(message);
}

/**
 * 目录跟随失败时是否给出「切换 sudo 模式并重试」引导：仅终端跟随触发（手动
 * 导航有自己的错误横幅）、sudo 模式未开（已开时重试无意义）、连接可写（只读
 * 连接禁用 sudo 开关）、且错误确属权限类。
 */
export function shouldOfferSudoRetryAfterFollowFailure(input: {
  fromTerminal: boolean;
  sudoMode: boolean;
  canWrite: boolean;
  message: string;
}): boolean {
  if (!input.fromTerminal) return false;
  if (input.sudoMode) return false;
  if (!input.canWrite) return false;
  return isPermissionDeniedError(input.message);
}
