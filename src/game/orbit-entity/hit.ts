// 弾の高度な衝突判定(トンネリング防止のセグメント衝突・被弾ダメージ)。
import { addScaled, dot, lenSq, sub } from '../../physics/vec3';
import * as C from '../const';
import { Ship } from './entities';
import { Bullet } from './bullet';
import { Enemy } from './enemy';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { Simulator } from './simulator';

export class HitSystem {
  // 撃破が発生した場合の集計・勝敗判定は activeStage(attacked() 経由)に委ねる。
  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  checkBulletHits(simTime: number, player: Player, activeStage: Stage, simulator: Simulator): void {
    const targets: (Player | Enemy)[] = [player, ...simulator.enemies];

    for (const p of simulator.bullets) {
      for (const target of targets) {
        if (!p.alive || !target.alive) continue;
        // プラズマ弾は自機のみを狙う(敵機には当たらない)
        if (p.type === 'plasma' && target !== player) continue;
        // 通常弾とプレイヤーの判定は、撃った直後の自己ヒットを避けるため猶予を置く
        // (通常弾はプレイヤーしか撃たないので、弾が地球を一周して戻るような場合のみ発生する)
        if (p.type === 'normal' && target === player && simTime - p.bornSim <= C.SELF_HIT_GRACE) continue;

        if (!this.segmentHit(p, target)) continue;
        p.alive = false;
        target.attacked(p, simTime, activeStage);
      }
    }
  }

  private segmentHit(b: Bullet, ship: Ship): boolean {
    const a = sub(b.prevState.r, ship.prevState.r);
    const bb = sub(b.state.r, ship.state.r);
    const d = sub(bb, a);
    const dd = lenSq(d);
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -dot(a, d) / dd)) : 0;
    const closest = addScaled(a, d, t);
    return lenSq(closest) <= ship.radius * ship.radius;
  }
}
