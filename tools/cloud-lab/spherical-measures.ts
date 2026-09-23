// 雲ラボの球面位置・質量分布に共通する距離と広がりの測定。
import { cross, dot, len, norm, v3 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/math/vec3';

export interface SphericalMassSample {
  readonly directionUnitVector: Vec3;
  readonly massKgM2: number;
}

export function sphericalDistanceM(actual: Vec3, expected: Vec3, radiusM: number): number {
  const sine = len(cross(actual, expected));
  const cosine = Math.max(-1, Math.min(1, dot(actual, expected)));
  return Math.atan2(sine, cosine) * radiusM;
}

export function massWeightedSphericalRmsSpreadM(
  samples: readonly SphericalMassSample[],
  sphereRadiusM: number,
): number {
  const totalMassKgM2 = samples.reduce((total, sample) => total + sample.massKgM2, 0);
  if (totalMassKgM2 === 0) return 0;
  const weightedDirection = samples.reduce((sum, sample) => v3(
    sum.x + sample.directionUnitVector.x * sample.massKgM2,
    sum.y + sample.directionUnitVector.y * sample.massKgM2,
    sum.z + sample.directionUnitVector.z * sample.massKgM2,
  ), v3(0, 0, 0));
  const centroidDirection = norm(weightedDirection);
  const weightedVarianceM2 = samples.reduce((total, sample) => {
    const distanceM = sphericalDistanceM(sample.directionUnitVector, centroidDirection, sphereRadiusM);
    return total + sample.massKgM2 * distanceM * distanceM;
  }, 0) / totalMassKgM2;
  return Math.sqrt(weightedVarianceM2);
}
