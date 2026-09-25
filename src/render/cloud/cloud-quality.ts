// Cloud quality policy shared by temporal preparation and spatial detail filtering.
// Numeric levels intentionally match the persisted cumulusDetail values.
export type CloudQualityLevel = 0 | 1 | 2 | 3;

export interface CloudQualityPolicy {
  readonly temporalIntervalSeconds: number;
  readonly detailFootprintScale: number;
  readonly atmosphereStepScale: number;
  readonly shadowStepScale: number;
}

const POLICY: Readonly<Record<CloudQualityLevel, CloudQualityPolicy>> = {
  0: { temporalIntervalSeconds: 3_600, detailFootprintScale: 4, atmosphereStepScale: 2, shadowStepScale: 2 },
  1: { temporalIntervalSeconds: 1_800, detailFootprintScale: 2, atmosphereStepScale: 1.5, shadowStepScale: 1.5 },
  2: { temporalIntervalSeconds: 900, detailFootprintScale: 1, atmosphereStepScale: 1, shadowStepScale: 1 },
  3: { temporalIntervalSeconds: 300, detailFootprintScale: 0.5, atmosphereStepScale: 0.75, shadowStepScale: 0.75 },
};

export function cloudQualityPolicy(level: number): CloudQualityPolicy {
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    throw new RangeError('cloud quality level must be an integer from 0 to 3');
  }
  return POLICY[level as CloudQualityLevel];
}

export interface CloudTemporalSampleTimes {
  readonly lowerTimeSeconds: number;
  readonly upperTimeSeconds: number;
  readonly fraction: number;
}

export function cloudTemporalSampleTimes(
  displayTimeSeconds: number, qualityLevel: number,
): CloudTemporalSampleTimes {
  if (!Number.isFinite(displayTimeSeconds)) throw new RangeError('displayTimeSeconds must be finite');
  const interval = cloudQualityPolicy(qualityLevel).temporalIntervalSeconds;
  const lowerTimeSeconds = Math.floor(displayTimeSeconds / interval) * interval;
  const upperTimeSeconds = lowerTimeSeconds + interval;
  return {
    lowerTimeSeconds,
    upperTimeSeconds,
    fraction: (displayTimeSeconds - lowerTimeSeconds) / interval,
  };
}
