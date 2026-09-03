// 軌道物体一覧の天体区画の行が検索に使う文字列。行には出さないが、自艦からの距離と
// その位置を最も強く引く天体の名前で絞り込めるようにする。
import { len, sub, type Vec3 } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import { fmtDist } from '../../hud/utils';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { Player } from '../player/player';

// 自艦がいなければ空文字。pos は displayTime の ECI 位置。
export function bodySearchText(
  celestialSystem: CelestialSystem, pos: Vec3, activePlayer: Player | null, displayTime: number,
): string {
  if (activePlayer === null) return '';
  const center = strongestAttractor(pos, celestialSystem.celestialMotions, displayTime);
  return `${fmtDist(len(sub(pos, activePlayer.state.r)))} · ${celestialSystem.nameOf(center.id)}`;
}
