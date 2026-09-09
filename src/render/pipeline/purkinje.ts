// 暗所での人間の相対的な色感度を、トーンマッピング後の世界画像へ適用する。
// 露出や光源の値は変更せず、明るい画像では恒等写像になる。
import { clamp, dot, float, mix, smoothstep, vec3 } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 遷移は表示値の輝度で決める。暗所の青緑感度が立ち上がる範囲を広く取り、境界を帯にしない。
export const PURKINJE_DARK_LUMINANCE = 0.05;
export const PURKINJE_LIGHT_LUMINANCE = 0.30;

// GPU側の補正強度と同じsmoothstepをCPUの不変条件テストからも参照できる形にする。
export function purkinjeDarknessAt(luminance: number): number {
  const t = Math.max(0, Math.min(1,
    (luminance - PURKINJE_DARK_LUMINANCE)
      / (PURKINJE_LIGHT_LUMINANCE - PURKINJE_DARK_LUMINANCE)));
  return 1 - t * t * (3 - 2 * t);
}

// 表示色の暗所補正。赤を抑え、青緑を少し保つが、色を新しい光源として加算しない。
export function applyPurkinje(color: Vec3Node): Vec3Node {
  const luminance: FloatNode = dot(color, vec3(0.2126, 0.7152, 0.0722));
  const darkness = float(1).sub(
    smoothstep(PURKINJE_DARK_LUMINANCE, PURKINJE_LIGHT_LUMINANCE, luminance),
  );
  const darkColor = vec3(
    color.r.mul(0.58).add(color.g.mul(0.03)),
    color.g.mul(1.02).add(color.b.mul(0.04)),
    color.b.mul(1.08).add(color.g.mul(0.06)),
  );
  return clamp(mix(color, darkColor, darkness), 0, 1) as Vec3Node;
}
