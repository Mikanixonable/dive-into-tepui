// world-space sub-grid の振幅を時間帯域と画面 footprint から決める。画面座標や壁時計は参照しない。
import { CLOUD_MODEL_PARAMETERS } from './cloud-model-parameters';

export function subGridAmplitude(
  worldWavelengthMeters: number, footprintMeters: number, averagingWindowSeconds: number,
): number {
  if (!Number.isFinite(worldWavelengthMeters) || worldWavelengthMeters <= 0) return 0;
  const spatial = Math.max(0, Math.min(1, worldWavelengthMeters / Math.max(footprintMeters, 1)));
  const temporal = averagingWindowSeconds <= 0
    ? 1 : Math.max(
      0, Math.min(1, CLOUD_MODEL_PARAMETERS.subGridLifetimeSeconds / averagingWindowSeconds),
    );
  return spatial * temporal;
}

export function backAdvectedCoordinate(
  coordinate: readonly [number, number], wind: readonly [number, number], seconds: number,
): readonly [number, number] {
  return [coordinate[0] - wind[0] * seconds, coordinate[1] - wind[1] * seconds];
}
