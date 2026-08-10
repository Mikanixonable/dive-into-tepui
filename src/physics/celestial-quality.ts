export type CelestialQuality = 'low' | 'medium' | 'high';

export interface CelestialQualityPreset {
  readonly auroraCurtains: number;
  readonly visualUpdateInterval: number;
}

export const CELESTIAL_QUALITY: Readonly<Record<CelestialQuality, CelestialQualityPreset>> = {
  low: { auroraCurtains: 2, visualUpdateInterval: 1 / 12 },
  medium: { auroraCurtains: 4, visualUpdateInterval: 1 / 24 },
  high: { auroraCurtains: 6, visualUpdateInterval: 1 / 45 },
};

/** 地球の投影半径と端末画素密度から、主要効果を消さずに細部だけを段階化する。 */
export function celestialQualityFor(projectedRadiusPx: number, devicePixelRatio = 1): CelestialQuality {
  const radius = Number.isFinite(projectedRadiusPx) ? Math.max(0, projectedRadiusPx) : 0;
  const dpr = Number.isFinite(devicePixelRatio) ? Math.max(0.5, devicePixelRatio) : 1;
  const physicalRadius = radius * dpr;
  if (physicalRadius >= 520) return 'high';
  if (physicalRadius >= 150) return 'medium';
  return 'low';
}
