import { clamp, max, mix, vec2 } from 'three/tsl';
import { weatherForcingField, type WeatherForcingField } from './weather-forcing-field';
import type { FloatNode } from '../tsl-types';

// 前線は気温・水分勾配と上昇流の dynamic anomaly。最終色や雲種を返さない。
export function frontForcing(
  temperatureGradient: FloatNode, moistureGradient: FloatNode, updraft: FloatNode,
  extratropicalWeight: FloatNode, warmth: FloatNode,
): WeatherForcingField {
  const frontWeight = clamp(
    temperatureGradient.add(moistureGradient.mul(0.2)).add(updraft.mul(0.15)), 0, 1,
  ).mul(extratropicalWeight);
  return weatherForcingField(
    frontWeight.mul(0.65).add(max(warmth, 0).mul(0.1)),
    frontWeight.mul(0.06),
    mix(frontWeight.mul(0.4), frontWeight, updraft),
    vec2(frontWeight.mul(0.2), frontWeight.mul(0.05)),
  );
}
