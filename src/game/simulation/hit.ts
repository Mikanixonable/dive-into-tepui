// 弾の高度な衝突判定(トンネリング防止のセグメント衝突・被弾ダメージ)。

import * as C from '../const';

import { Bullet } from '../game-entity/bullet';
import { Enemy } from '../game-entity/enemy';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { EntityManager } from './entity-manager';
import type { EffectsSystem } from '../vfx/effects-system';
import type { Sfx } from '../../audio/sfx';
import { Vec3 } from '../../physics/vec3';

export class HitSystem {
  constructor(private readonly fx: EffectsSystem, private readonly sfx: Sfx) {}

  // 撃破が発生した場合の集計・勝敗判定は activeStage(attacked() 経由)に委ねる。
  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  checkBulletHits(simTime: number, player: Player, activeStage: Stage, entities: EntityManager): void {
    const shipTargets: (Player | Enemy)[] = [player, ...entities.enemies];
    const debrisTargets = entities.debris.filter(d => d.collideRadius !== undefined);

    for (const p of entities.bullets) {
      if (!p.alive) continue;

      let hitSomething = false;

      // 1. Ship への命中判定
      for (const target of shipTargets) {
        if (!p.alive || !target.alive) continue;
        // プラズマ弾は自機のみを狙う(敵機には当たらない)
        if (p.type === 'plasma' && target !== player) continue;
        // 通常弾とプレイヤーの判定は、撃った直後の自己ヒットを避けるため猶予を置く
        if (p.type === 'normal' && target === player && simTime - p.bornSim <= C.SELF_HIT_GRACE) continue;

        const distSq = this.segmentDistSq(p, target.prevState.r, target.state.r);

        // 敵プラズマ弾がプレイヤーの至近を通過した場合に音を鳴らす
        if (p.type === 'plasma' && target === player && !p.passedClose) {
          const closeRadius = target.radius + 15; // 15m以内
          if (distSq < closeRadius * closeRadius) {
            p.passedClose = true;
            this.sfx.magneticInterference();
          }
        }

        if (distSq <= target.radius * target.radius) {
          p.alive = false;
          target.attacked(p, simTime, activeStage);
          hitSomething = true;
          break; // この弾は消滅した
        }
      }

      if (hitSomething || !p.alive) continue;

      // 2. デブリ(薬莢・マガジン)への命中判定
      for (const target of debrisTargets) {
        if (!p.alive || !target.alive) continue;
        const distSq = this.segmentDistSq(p, target.prevState.r, target.state.r);
        if (distSq <= target.collideRadius! * target.collideRadius!) {
          p.alive = false;
          // ガスのようなエフェクトを発生
          this.fx.spawnGasPuff(p.state.r, p.state.v);
          break; // この弾は消滅した
        }
      }
    }
  }

  // 前フレームから今フレームまでの弾と目標の相対移動を線分近似し、目標の最近接点までの距離の2乗を返す。
  private segmentDistSq(b: Bullet, prevTargetR: Vec3, targetR: Vec3): number {
    // 前フレーム時点の、目標基準の弾の相対位置
    const bpr = b.prevState.r;
    const ax = bpr.x - prevTargetR.x;
    const ay = bpr.y - prevTargetR.y;
    const az = bpr.z - prevTargetR.z;

    // 今フレーム時点の相対位置と、前フレームからの相対移動ベクトル
    const br = b.state.r;
    const bbx = br.x - targetR.x;
    const bby = br.y - targetR.y;
    const bbz = br.z - targetR.z;

    const dx = bbx - ax;
    const dy = bby - ay;
    const dz = bbz - az;

    // 相対移動の線分上で目標に最も近づく点の媒介変数 t を求める(0〜1にクランプ)
    const dd = dx * dx + dy * dy + dz * dz;
    const a_dot_d = ax * dx + ay * dy + az * dz;
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -a_dot_d / dd)) : 0;

    // 最近接点
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const cz = az + dz * t;

    return cx * cx + cy * cy + cz * cz;
  }
}
