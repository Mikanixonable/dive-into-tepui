import { dot, type Vec3 } from '../../math/vec3';
import { sunlitFactor } from '../../physics/shadow';
import type { CelestialBodies } from '../celestial/celestial-bodies';

// pos で撃つときの、太陽グレアによる散布界の倍率。逆光(照準方向に太陽がある)ほど狙いが
// 甘くなり、順光では締まる。難易度調整のための経験則であって物理計算ではない。
export function sunGlareSpreadScale(
  pos: Vec3, aimDir: Vec3, celestialBodies: CelestialBodies, t: number,
): number {
  const starId = celestialBodies.starId;
  if (starId === null) return 1;

  const sunDir = celestialBodies.sunDirFrom(pos, t);
  const angle = (Math.acos(Math.max(-1, Math.min(1, dot(aimDir, sunDir)))) * 180) / Math.PI;
  const litScale = angle <= 5 ? 2
    : angle <= 30 ? 1 + (30 - angle) / 25
    : angle >= 160 ? 0.5
    : angle >= 130 ? 1 - ((angle - 130) / 30) * 0.5
    : 1;

  // 日照率で内挿し、影の中では倍率 1 へ寄せる(SPEC/COMBAT.md「発射」)。しきい値で畳むと
  // 半影を横切るたびに散布界が跳ぶ。
  const sunlit = sunlitFactor(
    pos, celestialBodies.motionOf(starId), celestialBodies.celestialMotions, t,
  );
  return 1 + (litScale - 1) * sunlit;
}
