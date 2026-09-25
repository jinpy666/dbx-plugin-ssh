export const RDP_EXPERIMENTAL_PREFERENCE = "rdp_experimental_enabled";

/** RDP remains opt-in until the real-server validation matrix is complete. */
export function rdpExperimentalEnabled(value: unknown): boolean {
  return value === true;
}
