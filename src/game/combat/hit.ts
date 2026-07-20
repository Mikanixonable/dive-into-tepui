// 弾の高度な衝突判定(トンネリング防止のセグメント衝突・被弾ダメージ・的通過マーカー)。
// game.ts を import しない — 依存は HitCtx 引数・コンストラクタ注入のみ。
import { Vec3, addScaled, dot, lenSq, norm, sub } from '../../physics/vec3';
import * as C from '../const';
import { Bullet, Shooter, Ship } from '../entities';
import { Enemy } from '../enemy/enemy';
import { CombatCtx, CombatSystem } from './combat';

// checkBulletHits / checkBoardCrossings が必要とする、Game 側の現在状態のスナップショット。
// 撃破が発生した場合の集計・勝敗判定は combat(CombatCtx 経由)に委ねる。
export interface HitCtx {
  combat: CombatCtx;
  enemies: readonly Enemy[];
  target: Enemy | null;
  bullets: readonly Bullet[];
  plasmaBullets: readonly Bullet[];
  boardMarks: { off: Vec3; age: number; }[];
}

// 被弾の物理的な事実(何が・どこに・どの速度で当たったか)。演出(火花の見た目)は
// hit.ts の責務ではないため含めない — kind から見た目を決めるのは hitEffect 自身。
export type HitKind = 'bullet' | 'plasma';

export interface HitInfo {
  pos: Vec3;
  vel: Vec3;
  kind: HitKind; // 見た目(フラッシュの色・サイズ)の決定に使う
  shooter: Shooter; // 攻撃主体。kind とは独立 — byPlayer 等の帰属判定に使う
}

export class HitSystem {
  constructor(
    private readonly combat: CombatSystem,
  ) { }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、
  // 発射弾がその面を自機側から通過した点をターゲット相対で記録する。
  // 次弾の照準修正の目安になるマーカーとして一定時間表示する。
  checkBoardCrossings(ctx: HitCtx): void {
    const tgt = ctx.target;
    if (!tgt || !tgt.alive) return;
    const n = norm(sub(tgt.state.r, ctx.combat.player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    for (const b of ctx.bullets) {
      if (!b.alive) continue;
      const d0 = dot(sub(b.prevR, tgt.state.r), n);
      const d1 = dot(sub(b.state.r, tgt.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(b.prevR, sub(b.state.r, b.prevR), t);
      const off = sub(pos, tgt.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      ctx.boardMarks.push({ off, age: 0 });
      if (ctx.boardMarks.length > C.MAX_BOARD_MARKS) ctx.boardMarks.shift();
    }
  }

  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  checkBulletHits(ctx: HitCtx): void {
    const player = ctx.combat.player;

    // enemyとbulletの判定
    for (const enemy of ctx.enemies) {
      for (const b of ctx.bullets) {
        if (!enemy.alive || !b.alive) continue;

        if (this.segmentHit(b, enemy)) {
          b.alive = false;
          enemy.attacked({ pos: b.state.r, vel: enemy.state.v, kind: 'bullet', shooter: b.shooter }, this.combat, ctx.combat);
        }
      }
    }

    // playerとbulletの判定（現状、通常弾はプレイヤーしか打たないので地球を一周するような場合のみ）
    for (const b of ctx.bullets) {
      if (!b.alive || !player.alive) continue;
      if (ctx.combat.simTime - b.bornSim <= C.SELF_HIT_GRACE) continue; // 撃った直後は判定を無効化

      if (this.segmentHit(b, player)) {
        b.alive = false;
        player.attacked({ pos: b.state.r, vel: player.state.v, kind: 'bullet', shooter: b.shooter }, this.combat, ctx.combat);
      }
    }

    // playerとplasmaBulletの判定
    for (const pb of ctx.plasmaBullets) {
      if (!pb.alive || !player.alive) continue;
      
      if (this.segmentHit(pb, player)) {
        pb.alive = false;
        player.attacked({ pos: pb.state.r, vel: player.state.v, kind: 'plasma', shooter: pb.shooter }, this.combat, ctx.combat);
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
