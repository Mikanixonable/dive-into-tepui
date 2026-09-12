// 軌道物体一覧の天体区画の行が検索に使う文字列。行には出さないが、操作対象からの距離と
// その位置を最も強く引く天体の名前で絞り込めるようにする。
import { len, sub, type Vec3 } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import { fmtDist } from '../../hud/utils';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';

// 操作対象がいなければ空文字。pos は displayTime の ECI 位置。
export function bodySearchText(
  celestialBodies: CelestialBodies, pos: Vec3, viewer: OrbitingObject | null, displayTime: number,
): string {
  if (viewer === null) return '';
  const center = strongestAttractor(pos, celestialBodies.celestialMotions, displayTime);
  return `${fmtDist(len(sub(pos, viewer.motion.state.r)))} · ${celestialBodies.nameOf(center.id)}`;
}
