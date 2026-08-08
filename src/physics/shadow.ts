// 地球の影による日照率。天体暦(いつどこにいるか)ではなく、位置と太陽方向から
// 日照の有無を求める幾何なので ephemeris.ts から独立させている。
import { R_EARTH } from './orbital-state';
import { Vec3, addScaled, dot, len } from './vec3';

// 位置 r における日照率 0..1。地球を円柱とみなし、影側では地球半径からの距離に応じて
// penumbra [m] の幅で 0→1 へ線形にぼかす。
export function sunlitFactor(r: Vec3, sunDir: Vec3, penumbra: number): number {
  const along = dot(r, sunDir);
  if (along >= 0) return 1; // 太陽側
  const perp = len(addScaled(r, sunDir, -along));
  return Math.min(1, Math.max(0, (perp - R_EARTH) / penumbra));
}
