// 巻雲の筋の向き(倍角ベクトル × 揃い度)の見せ方。筋の向き θ を色相(θ/π が 1 周)、
// 揃い度を明度へ写す。揃い度の無い所は黒。
import { atan, clamp, fract, length, min, vec3 } from 'three/tsl';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';

// 倍角ベクトル flow((cos 2θ, sin 2θ) × 揃い度)を、向きを色相・揃い度を明度の色へ。
// 色相は筋の向き θ = atan2(flow.y, flow.x)/2 ∈ (−π/2, π/2] を 0..1 へ畳んだもの。
export function cirrusFlowColor(flow: Vec2Node): Vec3Node {
  const hue = atan(flow.y, flow.x).mul(0.5 / Math.PI).add(0.5);
  const brightness = min(length(flow), 1);
  // HSV(h, 1, v)。彩度は 1 なので、基底色へ明度を掛けるだけ。
  const rgb = clamp(
    fract(hue.add(vec3(0, 2 / 3, 1 / 3))).mul(6).sub(3).abs().sub(1), 0, 1);
  return rgb.mul(brightness);
}
