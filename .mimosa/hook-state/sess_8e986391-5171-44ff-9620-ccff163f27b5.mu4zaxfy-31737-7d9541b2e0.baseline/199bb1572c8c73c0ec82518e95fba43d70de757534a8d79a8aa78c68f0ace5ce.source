/**
 * Translates raw sidecar/SFTP error strings into friendly localized messages
 * for the SFTP banner. Unrecognized messages pass through untouched so rare
 * server-specific errors keep their original detail.
 */
export function friendlySftpError(
  message: string,
  t: (key: string) => string,
): string | undefined {
  if (/permission denied|access denied|not permitted/i.test(message)) return t("errors.permissionDenied");
  if (/no such file|does not exist|doesn't exist/i.test(message)) return t("errors.remoteNotFound");
  return undefined;
}
