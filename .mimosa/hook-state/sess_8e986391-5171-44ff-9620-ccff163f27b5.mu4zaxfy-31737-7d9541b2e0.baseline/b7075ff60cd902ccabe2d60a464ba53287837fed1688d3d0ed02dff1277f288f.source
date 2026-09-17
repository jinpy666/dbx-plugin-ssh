export interface TransferSpeedSample {
  transferred: number;
  windowStartedAt: number;
  windowStartedTransferred: number;
  speed: number;
}

const DEFAULT_SAMPLE_WINDOW_MS = 1000;

export function sampleTransferSpeed(previous: TransferSpeedSample | undefined, transferred: number, sampledAt: number, sampleWindowMs = DEFAULT_SAMPLE_WINDOW_MS): TransferSpeedSample {
  if (!previous || transferred < previous.transferred || sampledAt < previous.windowStartedAt) {
    return {
      transferred,
      windowStartedAt: sampledAt,
      windowStartedTransferred: transferred,
      speed: 0,
    };
  }

  const elapsed = sampledAt - previous.windowStartedAt;
  if (elapsed < sampleWindowMs) {
    return { ...previous, transferred };
  }

  const bytes = transferred - previous.windowStartedTransferred;
  const instantaneous = elapsed > 0 ? (bytes * 1000) / elapsed : 0;
  return {
    transferred,
    windowStartedAt: sampledAt,
    windowStartedTransferred: transferred,
    speed: previous.speed > 0 ? previous.speed * 0.5 + instantaneous * 0.5 : instantaneous,
  };
}
