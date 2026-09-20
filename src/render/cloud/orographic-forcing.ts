import { clamp, dot, max, min, vec2 } from 'three/tsl';
import { weatherForcingField, type WeatherForcingField } from './weather-forcing-field';
import type { FloatNode, Vec2Node } from '../tsl-types';

// 地形は現在の風と slope の組から dynamic orographic anomaly を作る。地形だけで常時雲を発生させない。
export function orographicForcing(
  wind: Vec2Node, slope: Vec2Node, landFraction: FloatNode,
): WeatherForcingField {
  const ascent = dot(wind, slope).mul(0.35).mul(landFraction.add(0.25));
  const lift = clamp(ascent, -0.06, 0.06);
  const drying = max(lift.negate(), 0);
  return weatherForcingField(
    drying.mul(-0.15),
    lift,
    min(max(lift, 0).mul(4), 1),
    vec2(slope.x.mul(0.1), slope.y.mul(0.1)),
  );
}
