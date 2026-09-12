import { addScaled, dot, lenSq, type Vec3 } from '../../math/vec3';

// 太陽グレアによる散布界倍率。影の半径と倍率テーブルは呼び出し側が渡すので、
// 自機と敵機の射撃調整値をこの幾何計算へ混ぜない。
export function sunGlareSpreadScale(
  pos: Vec3, aimDir: Vec3, sunDir: Vec3, shadowRadius: number,
): number {
  const along = dot(pos, sunDir);
  if (along < 0 && lenSq(addScaled(pos, sunDir, -along)) < shadowRadius * shadowRadius) return 1;
  const angle = (Math.acos(Math.max(-1, Math.min(1, dot(aimDir, sunDir)))) * 180) / Math.PI;
  if (angle <= 5) return 2;
  if (angle <= 30) return 1 + (30 - angle) / 25;
  if (angle >= 160) return 0.5;
  if (angle >= 130) return 1 - ((angle - 130) / 30) * 0.5;
  return 1;
}
