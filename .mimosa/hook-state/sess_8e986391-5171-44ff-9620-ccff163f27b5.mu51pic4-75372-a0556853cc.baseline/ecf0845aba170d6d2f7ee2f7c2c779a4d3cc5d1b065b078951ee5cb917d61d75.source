/**
 * Friendly classification of SSH connect failures.
 *
 * The sidecar surfaces raw transport/auth error strings (russh, tokio TCP and
 * its own "SSH …" wrappers). Raw strings are useful as detail but unreadable
 * as the primary UI message, so App.vue renders a localized hint per category
 * and keeps the raw text as the tooltip. Classification is a pure function of
 * the message text and only fires on connection-domain errors, so unrelated
 * failures (SFTP paths, zmodem, approvals) keep their original messages.
 */

export type ConnectErrorKind = "dns" | "refused" | "hostKey" | "auth" | "timeout" | "network";

const CONNECT_ERROR_PATTERNS: ReadonlyArray<readonly [ConnectErrorKind, RegExp]> = [
  // Name resolution: sidecar wraps dial errors as "SSH connection failed:
  // failed to lookup address information: …".
  ["dns", /failed to lookup address information/i],
  ["dns", /name or service not known/i],
  ["dns", /nodename nor servname provided/i],
  ["dns", /no address associated with hostname/i],
  ["dns", /temporary failure in name resolution/i],
  ["dns", /failed to resolve/i],
  ["refused", /connection refused/i],
  ["hostKey", /host key/i],
  ["hostKey", /unknownkey/i],
  ["hostKey", /known[_ ]?hosts/i],
  ["auth", /authentication/i],
  ["auth", /permission denied/i],
  ["auth", /access denied/i],
  ["auth", /keyboard-interactive/i],
  ["timeout", /timed out/i],
  ["timeout", /timeout/i],
  ["network", /no route to host/i],
  ["network", /network is unreachable/i],
  ["network", /connection reset/i],
  ["network", /connection aborted/i],
];

/** Gate so plain "… timed out" / "… was rejected" from other domains (agent
 * approvals, zmodem, SFTP) are never rewritten into connect hints. */
const CONNECT_DOMAIN_PATTERN = /ssh|connection|handshake|host key|authentication|auth probe/i;

/**
 * Maps a raw error message to a connect-error category, or null when the
 * message is not a connection-domain failure (it is shown as-is then).
 * Order matters: auth-specific timeouts must classify as auth, not timeout.
 */
export function classifyConnectError(message: string): ConnectErrorKind | null {
  const text = String(message || "");
  if (!text || !CONNECT_DOMAIN_PATTERN.test(text)) return null;
  for (const [kind, pattern] of CONNECT_ERROR_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

/** i18n key suffix ("connectError.<kind>") for the classified kind. */
export function connectErrorKey(kind: ConnectErrorKind): string {
  return `connectError.${kind}`;
}
