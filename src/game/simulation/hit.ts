// 弾の高度な衝突判定(トンネリング防止のセグメント衝突・被弾ダメージ)。

import * as C from '../const';
import { Ship } from '../game-entity/ship';
import { Bullet } from '../game-entity/bullet';
import { Enemy } from '../game-entity/enemy';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { EntityManager } from './entity-manager';

export class HitSystem {
  // 撃破が発生した場合の集計・勝敗判定は activeStage(attacked() 経由)に委ねる。
  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  checkBulletHits(simTime: number, player: Player, activeStage: Stage, entities: EntityManager): void {
    const targets: (Player | Enemy)[] = [player, ...entities.enemies];

    for (const p of entities.bullets) {
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
    const bpr = b.prevState.r;
    const spr = ship.prevState.r;
    const ax = bpr.x - spr.x;
    const ay = bpr.y - spr.y;
    const az = bpr.z - spr.z;

    const br = b.state.r;
    const sr = ship.state.r;
    const bbx = br.x - sr.x;
    const bby = br.y - sr.y;
    const bbz = br.z - sr.z;

    const dx = bbx - ax;
    const dy = bby - ay;
    const dz = bbz - az;

    const dd = dx * dx + dy * dy + dz * dz;
    const a_dot_d = ax * dx + ay * dy + az * dz;
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -a_dot_d / dd)) : 0;

    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const cz = az + dz * t;

    return cx * cx + cy * cy + cz * cz <= ship.radius * ship.radius;
  }
}
