// 時間方向の更新間隔と空間 detail の帯域制限をまとめた雲品質ポリシー。
// 数値は保存済み cumulusDetail と同じ 0..3 を使う。
export type CloudQualityLevel = 0 | 1 | 2 | 3;

export interface CloudQualityPolicy {
  readonly temporalIntervalSeconds: number;
  readonly detailFootprintScale: number;
}

const POLICY: Readonly<Record<CloudQualityLevel, CloudQualityPolicy>> = {
  0: { temporalIntervalSeconds: 3_600, detailFootprintScale: 4 },
  1: { temporalIntervalSeconds: 1_800, detailFootprintScale: 2 },
  2: { temporalIntervalSeconds: 900, detailFootprintScale: 1 },
  3: { temporalIntervalSeconds: 300, detailFootprintScale: 0.5 },
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

interface CloudTemporalPairPlan {
  readonly writes: readonly CloudTemporalCacheWrite[];
  readonly firstSlot: CloudTemporalCacheSlot;
  readonly secondSlot: CloudTemporalCacheSlot;
  readonly blendAtoB: number;
}

function cloudTemporalPairPlan(
  firstTimeSeconds: number,
  secondTimeSeconds: number,
  secondWeight: number,
  state: CloudTemporalCacheState,
): CloudTemporalPairPlan {
  if (!Number.isFinite(firstTimeSeconds) || !Number.isFinite(secondTimeSeconds)) {
    throw new RangeError('cloud temporal sample times must be finite');
  }
  if (!(secondTimeSeconds > firstTimeSeconds)) {
    throw new RangeError('cloud temporal sample times must be strictly increasing');
  }
  if (!Number.isFinite(secondWeight) || secondWeight < 0 || secondWeight > 1) {
    throw new RangeError('cloud temporal secondWeight must be within 0..1');
  }

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

  const firstSlot = materialize(firstTimeSeconds, secondTimeSeconds);
  const secondSlot = materialize(secondTimeSeconds, firstTimeSeconds);
  if (firstSlot === secondSlot) throw new Error('cloud temporal cache requires two distinct sample slots');
  return {
    writes,
    firstSlot,
    secondSlot,
    blendAtoB: firstSlot === 'A' ? secondWeight : 1 - secondWeight,
  };
}

export function cloudTemporalCachePlan(
  displayTimeSeconds: number,
  qualityLevel: number,
  state: CloudTemporalCacheState,
): CloudTemporalCachePlan {
  const sample = cloudTemporalSampleTimes(displayTimeSeconds, qualityLevel);
  const pair = cloudTemporalPairPlan(
    sample.lowerTimeSeconds, sample.upperTimeSeconds, sample.fraction, state,
  );
  return {
    ...sample,
    writes: pair.writes,
    lowerSlot: pair.firstSlot,
    upperSlot: pair.secondSlot,
    blendAtoB: pair.blendAtoB,
  };
}

export interface CloudTemporalAveragePlan {
  readonly firstTimeSeconds: number;
  readonly secondTimeSeconds: number;
  readonly writes: readonly CloudTemporalCacheWrite[];
  readonly firstSlot: CloudTemporalCacheSlot;
  readonly secondSlot: CloudTemporalCacheSlot;
  readonly blendAtoB: number;
}

// 60 Hz の表示フレーム1枚が覆うシミュレーション時間を仮想シャッター幅とする。
// 実フレーム間隔ではなく倍率だけから決めるため、同じ時刻・倍率なら再現結果が変わらない。
export function cloudTemporalExposureSeconds(simSpeed: number): number {
  if (!Number.isFinite(simSpeed) || simSpeed <= 0) {
    throw new RangeError('simSpeed must be positive and finite');
  }
  return simSpeed / 60;
}

// 極端な時間加速では、露光窓の前半・後半の中点を2標本とする。
// 雲場そのものを数値平均せず、描画用の焼成段でどちらか一方の瞬間場を決定的に選ぶ。
export function cloudTemporalAveragePlan(
  displayTimeSeconds: number,
  temporalExposureSeconds: number,
  state: CloudTemporalCacheState,
): CloudTemporalAveragePlan {
  if (!Number.isFinite(displayTimeSeconds)) throw new RangeError('displayTimeSeconds must be finite');
  if (!Number.isFinite(temporalExposureSeconds) || temporalExposureSeconds <= 0) {
    throw new RangeError('temporalExposureSeconds must be positive and finite');
  }
  const quarter = temporalExposureSeconds / 4;
  const firstTimeSeconds = displayTimeSeconds - quarter;
  const secondTimeSeconds = displayTimeSeconds + quarter;
  const pair = cloudTemporalPairPlan(firstTimeSeconds, secondTimeSeconds, 0.5, state);
  return {
    firstTimeSeconds,
    secondTimeSeconds,
    writes: pair.writes,
    firstSlot: pair.firstSlot,
    secondSlot: pair.secondSlot,
    blendAtoB: pair.blendAtoB,
  };
}

export function cloudUsesTemporalAverage(
  temporalExposureSeconds: number,
  qualityLevel: number,
): boolean {
  if (!Number.isFinite(temporalExposureSeconds) || temporalExposureSeconds < 0) {
    throw new RangeError('temporalExposureSeconds must be non-negative and finite');
  }
  return temporalExposureSeconds > cloudQualityPolicy(qualityLevel).temporalIntervalSeconds;
}
