// 弾の高度な衝突判定(トンネリング防止のセグメント衝突・被弾ダメージ・的通過マーカー)。
// game.ts を import しない — 依存は HitCtx 引数・コンストラクタ注入のみ。
import { Vec3, addScaled, clone, dot, lenSq, norm, sub } from '../../physics/vec3';
import * as C from '../const';
import { Bullet, Ship } from '../entities';
import { Enemy } from '../enemy/enemy';
import { Sfx } from '../../audio/sfx';
import { spawnFlash, spawnFragments } from '../effects-system';
import { CombatCtx, CombatSystem } from './combat';

// checkBulletHits / checkBoardCrossings が必要とする、Game 側の現在状態のスナップショット。
// 撃破が発生した場合の集計・勝敗判定は combat(CombatCtx 経由)に委ねる。
export interface HitCtx {
  combat: CombatCtx;
  enemies: readonly Enemy[];
  target: Enemy | null;
  bullets: readonly Bullet[];
  plasmaBullets: readonly Bullet[];
  boardMarks: { off: Vec3; age: number }[];
}

export class HitSystem {
  constructor(
    private readonly sfx: Sfx,
    private readonly combat: CombatSystem,
  ) {}

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
    for (const b of ctx.bullets) {
      if (!b.alive) continue;
      for (const ship of ctx.enemies) {
        if (!ship.alive) continue;
        if (this.segmentHit(b, ship)) {
          this.applyHit(b, ship, ctx);
          break;
        }
      }
      if (!b.alive) continue;
      // 自機被弾(軌道を一周して戻ってきた自弾)
      if (player.alive && ctx.combat.simTime - b.bornSim > C.SELF_HIT_GRACE && this.segmentHit(b, player)) {
        this.applyHit(b, player, ctx);
      }
    }
    for (const pb of ctx.plasmaBullets) {
      if (!pb.alive) continue;
      if (player.alive && this.segmentHit(pb, player)) {
        pb.alive = false;
        pb.dispose();
        player.hp -= C.PLAYER_HIT_DAMAGE;
        ctx.combat.setLostReason('敵のエネルギー弾により機体を喪失した');
        this.combat.recordHit();
        this.sfx.hit();
        spawnFlash(ctx.combat.fx, clone(pb.state.r), clone(player.state.v), C.PLASMA_HIT_FLASH_SIZE0, C.PLASMA_HIT_FLASH_SIZE1, C.PLASMA_HIT_FLASH_DURATION, 0xffa0ff);
        spawnFragments(ctx.combat.fx, clone(pb.state.r), clone(player.state.v), C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
        if (player.hp <= 0) {
          this.combat.destroyShip(player, ctx.combat);
        }
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

  private applyHit(b: Bullet, ship: Ship, ctx: HitCtx): void {
    b.alive = false;
    ship.hp -= ship === ctx.combat.player ? C.PLAYER_HIT_DAMAGE : C.ENEMY_HIT_DAMAGE;
    if (ship === ctx.combat.player) ctx.combat.setLostReason('自弾の被弾により機体を喪失した');
    this.combat.recordHit();
    this.sfx.hit();
    spawnFlash(ctx.combat.fx, clone(b.state.r), clone(ship.state.v), C.BULLET_HIT_FLASH_SIZE0, C.BULLET_HIT_FLASH_SIZE1, C.BULLET_HIT_FLASH_DURATION, 0xffe2a0);
    // 被弾時にも小さな欠片を飛散させる
    spawnFragments(ctx.combat.fx, clone(b.state.r), clone(ship.state.v), C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
    if (ship.hp <= 0) {
      this.combat.destroyShip(ship, ctx.combat);
    }
  }
}
