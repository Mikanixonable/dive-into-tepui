// 山岳の wake / mountain-wave 補助 pattern。solver や texture を増やさず、既存の風上/風下 forcing の
// 連続な補助項として使う。戻り値は -1..1 の無次元係数。

export function orographicPattern(
  downwindDistanceMeters: number, crosswindDistanceMeters: number, wavelengthMeters: number,
): number {
  if (!Number.isFinite(wavelengthMeters) || wavelengthMeters <= 0) return 0;
  if (downwindDistanceMeters <= 0) return 0;
  const envelope = Math.exp(-downwindDistanceMeters / (wavelengthMeters * 6));
  const crosswind = Math.exp(-((crosswindDistanceMeters / (wavelengthMeters * 1.5)) ** 2));
  return Math.sin((2 * Math.PI * downwindDistanceMeters) / wavelengthMeters) * envelope * crosswind;
}

export function orographicPatternForcing(
  baseLift: number, downwindDistanceMeters: number, crosswindDistanceMeters: number,
  wavelengthMeters: number, amplitude = 0.08,
): number {
  return baseLift + orographicPattern(
    downwindDistanceMeters, crosswindDistanceMeters, wavelengthMeters,
  ) * amplitude;
}
