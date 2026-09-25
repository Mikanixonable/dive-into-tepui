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


export type CloudTemporalCacheSlot = 'A' | 'B';

export interface CloudTemporalCacheState {
  readonly timeA: number | null;
  readonly timeB: number | null;
}

export interface CloudTemporalCacheWrite {
  readonly slot: CloudTemporalCacheSlot;
  readonly timeSeconds: number;
}

export interface CloudTemporalCachePlan extends CloudTemporalSampleTimes {
  readonly writes: readonly CloudTemporalCacheWrite[];
  readonly lowerSlot: CloudTemporalCacheSlot;
  readonly upperSlot: CloudTemporalCacheSlot;
  readonly blendAtoB: number;
}

function replacementSlot(
  timeA: number | null,
  timeB: number | null,
  protectedTime: number | null,
  targetTime: number,
): CloudTemporalCacheSlot {
  if (timeA === protectedTime) return 'B';
  if (timeB === protectedTime) return 'A';
  if (timeA === null) return 'A';
  if (timeB === null) return 'B';
  return Math.abs(timeA - targetTime) >= Math.abs(timeB - targetTime) ? 'A' : 'B';
}

export function cloudTemporalCachePlan(
  displayTimeSeconds: number,
  qualityLevel: number,
  state: CloudTemporalCacheState,
): CloudTemporalCachePlan {
  const sample = cloudTemporalSampleTimes(displayTimeSeconds, qualityLevel);
  let timeA = state.timeA;
  let timeB = state.timeB;
  const writes: CloudTemporalCacheWrite[] = [];

  const materialize = (timeSeconds: number, protectedTime: number | null): CloudTemporalCacheSlot => {
    if (timeA === timeSeconds) return 'A';
    if (timeB === timeSeconds) return 'B';
    const slot = replacementSlot(timeA, timeB, protectedTime, timeSeconds);
    writes.push({ slot, timeSeconds });
    if (slot === 'A') timeA = timeSeconds;
    else timeB = timeSeconds;
    return slot;
  };

  const lowerSlot = materialize(sample.lowerTimeSeconds, sample.upperTimeSeconds);
  const upperSlot = materialize(sample.upperTimeSeconds, sample.lowerTimeSeconds);
  if (lowerSlot === upperSlot) throw new Error('cloud temporal cache requires two distinct sample slots');
  return {
    ...sample,
    writes,
    lowerSlot,
    upperSlot,
    blendAtoB: lowerSlot === 'A' ? sample.fraction : 1 - sample.fraction,
  };
}
