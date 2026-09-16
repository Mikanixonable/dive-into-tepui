// 発射弾が、ターゲット位置に置いて自機の方へ向けた仮想の標的面(的)を通過したことの記録。
import { addScaled, dot, lenSq, norm, sub } from '../../math/vec3';
import { isBullet } from './dynamic-entity/bullet';
import { bulletReactionOf } from './dynamic-entity/bullet-reaction';
import { aliveCombatTarget } from './dynamic-entity/combat-target';
import type { OrbitingObject } from './dynamic-entity/orbiting-object';
import type { EntityRoster } from './entity-roster';
import type { RunEventSink } from '../run-events';

const BOARD_RADIUS = 4000; // 的の半径 [m](これ以遠の通過は記録しない)

// targetId が指す生存中の戦闘対象に的を置き、通常弾が viewer 側から的を通過したことを events へ記録する。
// 的の半径から外れた通過は記録しない。どの対象について記録するかは、表示の導出が需要として渡す(R4)。
export function recordTargetBoardPasses(
  viewer: OrbitingObject | null, targetId: string | null, roster: EntityRoster, events: RunEventSink,
): void {
  const target = targetId === null ? null : aliveCombatTarget(roster.all(), targetId);
  if (!viewer || !target) return;
  const n = norm(sub(target.motion.state.r, viewer.motion.state.r)); // 的の法線 = 視線方向
  if (lenSq(n) < 0.5) return;

  // 各弾について、前フレームと今フレームの位置が的面をどちら向きに跨いだかを見る。
  for (const b of roster.all().filter(isBullet)) {
    const bullet = bulletReactionOf(b.motion);
    if (bullet?.type !== 'normal' || !b.motion.alive) continue; // 的通過マーカーは通常弾のみ対象
    const prevR = b.motion.prevState.r;
    const d0 = dot(sub(prevR, target.motion.state.r), n);
    const d1 = dot(sub(b.motion.state.r, target.motion.state.r), n);
    if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
    const t = d0 / (d0 - d1);
    const pos = addScaled(prevR, sub(b.motion.state.r, prevR), t);
    const off = sub(pos, target.motion.state.r);
    if (lenSq(off) > BOARD_RADIUS * BOARD_RADIUS) continue; // 的から外れすぎ
    events.record({ kind: 'targetBoardPassed', offset: off, simTime: b.motion.state.t });
  }
}
