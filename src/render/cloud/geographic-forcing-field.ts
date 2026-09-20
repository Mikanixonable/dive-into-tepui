import { abs, clamp, float, max, smoothstep } from 'three/tsl';
import type { FloatNode } from '../tsl-types';

export interface GeographicForcingPrior {
  readonly stormTrack: FloatNode;
  readonly marineStratocumulus: FloatNode;
  readonly itcz: FloatNode;
  readonly drySubsidence: FloatNode;
}

// AnnualClimateMap は平均 coverage ではなく、producer / parameterization の prior として一度だけ読む。
export function geographicForcingPrior(
  latitude: FloatNode, meanCloudiness: FloatNode, landFraction: FloatNode,
): GeographicForcingPrior {
  const absoluteLatitude = abs(latitude);
  const stormTrack = smoothstep(0.25, 0.55, absoluteLatitude)
    .mul(smoothstep(0.58, 0.75, absoluteLatitude).oneMinus());
  const marineStratocumulus = smoothstep(0.18, 0.32, absoluteLatitude)
    .mul(smoothstep(0.38, 0.58, absoluteLatitude).oneMinus())
    .mul(float(1).sub(landFraction));
  const itcz = smoothstep(0.02, 0.32, absoluteLatitude).oneMinus();
  const drySubsidence = max(
    smoothstep(0.18, 0.32, absoluteLatitude).mul(float(1).sub(meanCloudiness)),
    0,
  );
  return {
    stormTrack: clamp(stormTrack.mul(meanCloudiness), 0, 1),
    marineStratocumulus: clamp(marineStratocumulus.mul(meanCloudiness), 0, 1),
    itcz: clamp(itcz.mul(meanCloudiness), 0, 1),
    drySubsidence: clamp(drySubsidence, 0, 1),
  };
}
