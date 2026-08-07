// 弾速一定の弾丸が相対運動する目標に命中するまでの最短時間と、そこから求まる
// 見越し点(狙うべき位置)を解く純関数。
import { Vec3, addScaled, dot, lenSq, sub } from './vec3';
import { OrbitState } from './orbital-state';

// |relP + relV t| = s t を満たす最小の正の t
export function solveLeadTime(relP: Vec3, relV: Vec3, s: number): number | null {
  // |relP + relV t|² = s² t² を t についての二次方程式として係数を求める
  const a = lenSq(relV) - s * s;
  const b = 2 * dot(relP, relV);
  const c = lenSq(relP);
  // 二次の係数がほぼ0なら一次方程式として解く
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }
  // 判別式が負なら実数解が無い
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  // 正の解のうち最小のものを採用する
  let best: number | null = null;
  for (const t of [t1, t2]) {
    if (t > 0 && (best === null || t < best)) best = t;
  }
  return best;
}

// shooter から muzzleSpeed で撃った弾が target に当たる未来位置。命中解が無い場合と、
// maxTime より先にしか当たらない(照準の目安として実用にならない)場合は null。
export function leadPoint(
  target: OrbitState,
  shooter: OrbitState,
  muzzleSpeed: number,
  maxTime: number,
): Vec3 | null {
  const relV = sub(target.v, shooter.v);
  const t = solveLeadTime(sub(target.r, shooter.r), relV, muzzleSpeed);
  if (t === null || t >= maxTime) return null;
  return addScaled(target.r, relV, t);
}
