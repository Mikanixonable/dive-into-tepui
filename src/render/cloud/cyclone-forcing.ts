import { clamp, vec2 } from 'three/tsl';
import { weatherForcingField, type WeatherForcingField } from './weather-forcing-field';
import type { FloatNode, Vec2Node } from '../tsl-types';

// Cyclone の眼・金床・雨帯は共通 forcing へ寄与し、白い object を直接描画しない。
export function cycloneForcing(
  rainband: FloatNode, anvil: FloatNode, eye: FloatNode, windPerturbation: Vec2Node,
  stormTrackPrior: FloatNode,
): WeatherForcingField {
  const priorWeightedRainband = rainband.mul(stormTrackPrior);
  const priorWeightedAnvil = anvil.mul(stormTrackPrior);
  const organization = clamp(
    priorWeightedRainband.mul(0.8).add(priorWeightedAnvil.mul(0.45)).sub(eye.mul(0.2)), 0, 1,
  );
  return weatherForcingField(
    priorWeightedRainband.mul(0.2).add(priorWeightedAnvil.mul(0.1)).sub(eye.mul(0.35)),
    priorWeightedRainband.mul(0.06),
    organization,
    vec2(
      windPerturbation.x.add(priorWeightedRainband.mul(0.25)),
      windPerturbation.y.add(priorWeightedRainband.mul(0.25)),
    ),
  );
}
