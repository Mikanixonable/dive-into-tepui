export function subGridAmplitude(
  worldWavelengthMeters: number, footprintMeters: number,
): number {
  if (!Number.isFinite(worldWavelengthMeters) || worldWavelengthMeters <= 0) return 0;
  return Math.max(0, Math.min(1, worldWavelengthMeters / Math.max(footprintMeters, 1)));
}

export function backAdvectedCoordinate(
  coordinate: readonly [number, number], wind: readonly [number, number], seconds: number,
): readonly [number, number] {
  return [coordinate[0] - wind[0] * seconds, coordinate[1] - wind[1] * seconds];
}
