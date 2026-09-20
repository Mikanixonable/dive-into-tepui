// RGBA basis を高度の compact support へ写す。profile は雲種を切り替えず、複数 basis の重なりを返す。
import { CLOUD_MODEL_PARAMETERS } from './cloud-model-parameters';

export interface CloudVerticalProfile {
  readonly low: number;
  readonly middle: number;
  readonly convective: number;
  readonly inSitu: number;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function descendingSmoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 1 : 0;
  return 1 - smoothstep(edge0, edge1, value);
}

export function cloudVerticalProfileAt(
  altitudeMeters: number, basis: CloudVerticalProfile,
  maximumAltitudeMeters = CLOUD_MODEL_PARAMETERS.maximumCloudAltitudeMeters,
): CloudVerticalProfile {
  const altitude = Math.max(0, Math.min(maximumAltitudeMeters, altitudeMeters));
  return {
    low: basis.low * descendingSmoothstep(0, 2_500, altitude),
    middle: basis.middle
      * smoothstep(1_500, 4_000, altitude)
      * descendingSmoothstep(8_000, 11_000, altitude),
    convective: basis.convective
      * smoothstep(4_000, 7_000, altitude)
      * descendingSmoothstep(16_000, maximumAltitudeMeters, altitude),
    inSitu: basis.inSitu
      * smoothstep(8_000, 11_000, altitude)
      * descendingSmoothstep(18_000, maximumAltitudeMeters, altitude),
  };
}

export function verticalProfileSupport(
  profile: CloudVerticalProfile, threshold = 1e-4,
): boolean {
  return profile.low > threshold || profile.middle > threshold
    || profile.convective > threshold || profile.inSitu > threshold;
}
