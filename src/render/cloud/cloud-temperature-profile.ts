// 温度から相の傾向を連続的に求める。liquid / mixed / ice は排他的な雲種ではなく、optics の重みである。
import { smoothstep } from 'three/tsl';
import type { FloatNode } from '../tsl-types';

export interface CloudPhaseWeights {
  readonly liquid: number;
  readonly mixed: number;
  readonly ice: number;
}

const FREEZING_K = 273.15;

function smoothstepNumber(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function cloudTemperatureKAtAltitude(
  surfaceTemperatureK: number, altitudeMeters: number, lapseRateKPerKm = 6.5,
): number {
  return surfaceTemperatureK - Math.max(0, altitudeMeters) * lapseRateKPerKm / 1_000;
}

export function cloudPhaseWeights(temperatureK: number): CloudPhaseWeights {
  const liquid = smoothstepNumber(FREEZING_K - 15, FREEZING_K, temperatureK);
  const ice = 1 - smoothstepNumber(FREEZING_K - 25, FREEZING_K - 10, temperatureK);
  return { liquid, mixed: Math.max(0, 1 - liquid - ice), ice };
}

export function cloudIceWeightNode(temperatureK: FloatNode): FloatNode {
  return smoothstep(248, 263, temperatureK).oneMinus();
}

export function cloudLiquidWeightNode(temperatureK: FloatNode): FloatNode {
  return smoothstep(258, 273.15, temperatureK);
}
