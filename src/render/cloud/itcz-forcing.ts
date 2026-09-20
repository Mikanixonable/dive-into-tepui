import { cos, float, vec2 } from 'three/tsl';
import { weatherForcingField, type WeatherForcingField } from './weather-forcing-field';
import type { FloatNode } from '../tsl-types';

// ITCZ climatology は位置・強度の prior として評価し、現在の weather object とは別の連続 anomaly とする。
export function itczForcing(
  latitude: FloatNode, climatologyPrior: FloatNode, landFraction: FloatNode,
): WeatherForcingField {
  const prior = climatologyPrior.mul(float(1).sub(landFraction.mul(0.35)));
  return weatherForcingField(
    prior.mul(0.12),
    prior.mul(0.012),
    prior.mul(0.75),
    vec2(cos(latitude).mul(prior).mul(-0.1), prior.mul(0.02)),
  );
}
