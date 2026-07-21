// 弾の高度な衝突判定(トンネリング防止のセグメント衝突・被弾ダメージ・的通過マーカー)。
import { Vec3, addScaled, dot, lenSq, norm, sub } from '../../physics/vec3';
import * as C from '../const';
import { Ship } from './entities';
import { Bullet } from './bullet';
import { Enemy } from './enemy';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { Simulator } from './simulator';

// checkBulletHits / checkBoardCrossings が必要とする、Game 側の現在状態のスナップショット。
// 撃破が発生した場合の集計・勝敗判定は activeStage(attacked() 経由)に委ねる。
export interface HitCtx {
  simTime: number;
  player: Player;
  activeStage: Stage;
  simulator: Simulator;
  target: Enemy | null;
  boardMarks: { off: Vec3; age: number; }[];
}

export class HitSystem {
  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、
  // 発射弾がその面を自機側から通過した点をターゲット相対で記録する。
  // 次弾の照準修正の目安になるマーカーとして一定時間表示する。
  checkBoardCrossings(target: Enemy | null, player: Player, simulator: Simulator, boardMarks: { off: Vec3; age: number; }[]): void {
    if (!target || !target.alive) return;
    const n = norm(sub(target.state.r, player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    for (const b of simulator.bullets) {
      if (b.type !== 'normal' || !b.alive) continue; // 的通過マーカーは通常弾のみ対象
      const d0 = dot(sub(b.prevR, target.state.r), n);
      const d1 = dot(sub(b.state.r, target.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(b.prevR, sub(b.state.r, b.prevR), t);
      const off = sub(pos, target.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      boardMarks.push({ off, age: 0 });
      if (boardMarks.length > C.MAX_BOARD_MARKS) boardMarks.shift();
    }
  }

  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  checkBulletHits(ctx: HitCtx): void {
    const player = ctx.player;
    const targets: (Player | Enemy)[] = [player, ...ctx.simulator.enemies];

    for (const p of ctx.simulator.bullets) {
      for (const target of targets) {
        if (!p.alive || !target.alive) continue;
        // プラズマ弾は自機のみを狙う(敵機には当たらない)
        if (p.type === 'plasma' && target !== player) continue;
        // 通常弾とプレイヤーの判定は、撃った直後の自己ヒットを避けるため猶予を置く
        // (通常弾はプレイヤーしか撃たないので、弾が地球を一周して戻るような場合のみ発生する)
        if (p.type === 'normal' && target === player && ctx.simTime - p.bornSim <= C.SELF_HIT_GRACE) continue;

        if (!this.segmentHit(p, target)) continue;
        p.alive = false;
        target.attacked(p, ctx.simTime, ctx.activeStage);
      }
    }
  }

  private segmentHit(b: Bullet, ship: Ship): boolean {
    const a = sub(b.prevR, ship.prevR);
    const bb = sub(b.state.r, ship.state.r);
    const d = sub(bb, a);
    const dd = lenSq(d);
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -dot(a, d) / dd)) : 0;
    const closest = addScaled(a, d, t);
    return lenSq(closest) <= ship.radius * ship.radius;
  }
}
