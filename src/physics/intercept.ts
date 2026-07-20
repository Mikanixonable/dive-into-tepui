// 弾速一定の弾丸が相対運動する目標に命中するまでの最短時間を解く純関数。
import { Vec3, dot, lenSq } from './vec3';

// |relP + relV t| = s t を満たす最小の正の t
export function solveLeadTime(relP: Vec3, relV: Vec3, s: number): number | null {
  const a = lenSq(relV) - s * s;
  const b = 2 * dot(relP, relV);
  const c = lenSq(relP);
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  let best: number | null = null;
  for (const t of [t1, t2]) {
    if (t > 0 && (best === null || t < best)) best = t;
  }
  return best;
}
