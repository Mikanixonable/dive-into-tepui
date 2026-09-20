// 総観場の寿命と雲セルの発生・減衰を分離する純粋な lifecycle。absolute time から直接評価し、
// 評価経路や前フレームの状態を参照しない。
import { CLOUD_MODEL_PARAMETERS } from './cloud-model-parameters';
import { SIMULATION_DAY_SECONDS } from './weather-time';

export interface CloudLifecycleWeights {
  readonly cell: number;
  readonly meso: number;
  readonly anvil: number;
  readonly inSitu: number;
}

function periodicPulse(seconds: number, lifetime: number, phase: number): number {
  const cycle = ((seconds + phase) % lifetime + lifetime) % lifetime;
  const normalized = cycle / lifetime;
  return Math.sin(normalized * Math.PI) ** 2;
}

export function cloudLifecycleAt(
  absoluteSeconds: number, seed: number, forcing: number,
): CloudLifecycleWeights {
  const safeTime = Number.isFinite(absoluteSeconds) ? absoluteSeconds : 0;
  const phase = Math.abs(seed % 1_000) * 60;
  const activity = Math.max(0, Math.min(1, forcing));
  return {
    cell: periodicPulse(safeTime, CLOUD_MODEL_PARAMETERS.cloudCellLifetimeSeconds, phase) * activity,
    meso: 0.5 + 0.5 * periodicPulse(
      safeTime, CLOUD_MODEL_PARAMETERS.mesoLifetimeSeconds, phase * 0.25),
    anvil: periodicPulse(safeTime, CLOUD_MODEL_PARAMETERS.anvilLifetimeSeconds, phase * 0.5) * activity,
    inSitu: 0.4 + 0.6 * periodicPulse(safeTime, SIMULATION_DAY_SECONDS, phase * 0.1),
  };
}

export function bandLimitLifecycle(
  current: CloudLifecycleWeights, averagingWindowSeconds: number,
): CloudLifecycleWeights {
  if (averagingWindowSeconds <= 0) return current;
  const highFrequencyWeight = Math.max(
    0, Math.min(1, CLOUD_MODEL_PARAMETERS.cloudCellLifetimeSeconds / averagingWindowSeconds),
  );
  return {
    cell: current.cell * highFrequencyWeight,
    meso: current.meso,
    anvil: current.anvil * (0.35 + 0.65 * highFrequencyWeight),
    inSitu: current.inSitu,
  };
}
