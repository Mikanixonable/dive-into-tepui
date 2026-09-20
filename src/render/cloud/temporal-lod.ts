// シミュレーション時間の進み幅を、雲の時間的な詳細度へ写す純粋な境界。
// normal だけが短寿命セルと weather object の identity を追い、中間以上は場の尺度を優先する。

import type { SimulationDayTime } from './weather-time';

export const NORMAL_MAX_SIMULATION_SECONDS = 10 * 60;
export const INTERMEDIATE_MAX_SIMULATION_SECONDS = 6 * 60 * 60;
export const EXTREME_MAX_BAKES_PER_REAL_SECOND = 4;

export type TemporalLodMode = 'normal' | 'intermediate' | 'extreme';

export interface TemporalLodProfile {
  readonly mode: TemporalLodMode;
  readonly simulationSecondsPerFrame: number;
  readonly averagingWindowSeconds: number;
  readonly cellWeight: number;
  readonly weatherObjectWeight: number;
  readonly dailyCycleWeight: number;
  readonly maxBakesPerRealSecond: number;
}

const NORMAL_PROFILE: Omit<TemporalLodProfile, 'mode' | 'simulationSecondsPerFrame' | 'averagingWindowSeconds'> = {
  cellWeight: 1,
  weatherObjectWeight: 1,
  dailyCycleWeight: 1,
  maxBakesPerRealSecond: Number.POSITIVE_INFINITY,
};

export function temporalLodFor(
  simulationSeconds: number, realFrameSeconds: number,
): TemporalLodProfile {
  const step = Math.max(0, Number.isFinite(simulationSeconds) ? simulationSeconds : 0);
  if (step <= NORMAL_MAX_SIMULATION_SECONDS) {
    return {
      mode: 'normal',
      simulationSecondsPerFrame: step,
      averagingWindowSeconds: 0,
      ...NORMAL_PROFILE,
    };
  }

  if (step <= INTERMEDIATE_MAX_SIMULATION_SECONDS) {
    const realFrameFactor = realFrameSeconds > 0 ? Math.min(1, realFrameSeconds * 60) : 1;
    return {
      mode: 'intermediate',
      simulationSecondsPerFrame: step,
      averagingWindowSeconds: step,
      cellWeight: 0.35,
      weatherObjectWeight: 0.8,
      dailyCycleWeight: Math.min(1, NORMAL_MAX_SIMULATION_SECONDS / step, realFrameFactor),
      maxBakesPerRealSecond: Number.POSITIVE_INFINITY,
    };
  }

  return {
    mode: 'extreme',
    simulationSecondsPerFrame: step,
    averagingWindowSeconds: step,
    cellWeight: 0.05,
    weatherObjectWeight: 0.35,
    dailyCycleWeight: 0,
    maxBakesPerRealSecond: EXTREME_MAX_BAKES_PER_REAL_SECOND,
  };
}

// high-frequency な anchor を追い掛けず、現在 target に直接到達するための時刻。normal では
// 連続性を失わないように元の時刻を使い、中間以上では日内の sub-grid 位相を固定しない。
export function targetSimulationTime(
  seconds: number, profile: TemporalLodProfile, dayTime: SimulationDayTime,
): number {
  if (profile.mode === 'normal') return seconds;
  if (profile.mode === 'intermediate') {
    const dayOffset = dayTime.dayIndex * 24 * 60 * 60;
    return dayOffset + Math.floor(dayTime.secondsOfDay / 600) * 600;
  }
  return seconds - profile.averagingWindowSeconds * 0.5;
}

// 同一の実時間窓で許される bake 数を判定する。wall clock は bake の rate limit にだけ使い、
// 雲の seed や状態の入力には使わない。
export function canBakeInWindow(
  nowMs: number, windowStartMs: number | null, bakeCount: number, profile: TemporalLodProfile,
): boolean {
  if (profile.maxBakesPerRealSecond === Number.POSITIVE_INFINITY) return true;
  if (windowStartMs === null || nowMs - windowStartMs >= 1000) return true;
  return bakeCount < profile.maxBakesPerRealSecond;
}
