
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Bullet, CheckLossCtx, Ship } from '../../game/entities';
import { Attitude } from '../../physics/attitude';
import { altitudeOf, OrbitState } from '../../physics/orbital';
import { OrbitLine } from '../../render/orbitline';
import { add, clone, len, norm, randPerp, rotateAxis, scale, sub } from '../../physics/vec3';
import { solveLeadTime } from '../../physics/intercept';
import { buildPlasmaMesh } from '../../render/ships';
import { EffectsCtx, spawnBulletFlash, spawnFragments, spawnPlasmaFlash, spawnShipDestroyEffect } from '../effects-system';
import type { Player } from '../player/player';
import { CombatCtx } from '../stages/stage-definition';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';

// 敵 AI(Enemy.behave)が必要とする、Game 側の現在状態のスナップショット。
// player / enemies は参照渡し(state.r 等を読むだけでミューテートしない)。
// scene は含めない — Enemy 自身が(Ship 経由で)自身の scene を私有している。
export interface EnemyAiCtx {
  simTime: number;
  player: Player;
  enemies: readonly Enemy[]; // 同一集団の同時攻撃数カウントに使う
  addBullet(bullet: Bullet): void;
}

export class Enemy extends Ship {
  accent: number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  readonly orbitLine: OrbitLine;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastTargetedSim?: number; // 最後にロックオンされた時刻。LEAD マーカー表示の履歴
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間

  // hud は現状 Enemy 自身のメソッドからは未使用だが、hud/sfx は必ず対で注入する方針のため
  // 受け取る(hud はフィールドとしては保持しない)。
  private readonly _sfx: Sfx;

  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    hp: number,
    accent: number,
    orbitLineColor: number,
    _hud: Hud,
    sfx: Sfx,
    waveId?: number,
    scene?: THREE.Scene,
  ) {
    super(name, state, obj, att, C.ENEMY_RADIUS, hp, scene);
    this._sfx = sfx;
    this.accent = accent;
    this.waveId = waveId;
    this.mass = 10000;
    this.collideRadius = C.ENEMY_RADIUS;
    this.obj.scale.setScalar(C.ENEMY_SCALE);
    this.orbitLine = new OrbitLine(orbitLineColor, 0.35);
    scene?.add(this.orbitLine.line);
  }

  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。attacked からのみ呼ばれる。
  private hitEffect(fx: EffectsCtx, bullet: Bullet): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      spawnPlasmaFlash(this.scene!, fx, bullet.state.r, this.state.v);
    } else {
      spawnBulletFlash(this.scene!, fx, bullet.state.r, this.state.v);
    }
    spawnFragments(this.scene!, fx, bullet.state.r, this.state.v, C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
  }

  private destroyEffect(fx: EffectsCtx): void {
    this._sfx.explosion();
    // 敵機は自機の ENEMY_SCALE 倍サイズなので、撃破エフェクトも見合った大きさにする
    spawnShipDestroyEffect(this.scene!, fx, this.state.r, this.state.v, C.ENEMY_SCALE, 0xff6a4a);
  }

  // 被弾によるダメージ・致死判定。
  attacked(bullet: Bullet, ctx: CombatCtx): void {
    if (!this.alive) return;
    if (bullet.shooter === 'enemy') return; // 敵弾の被弾は無効化

    ctx.activeStage.killCounter.recordHit();

    this.hp -= C.ENEMY_HIT_DAMAGE;
    if (this.hp > 0) {
      this.hitEffect(ctx.fx, bullet);
      return;
    }

    this.alive = false;
    ctx.activeStage.recordKill(this, ctx, true);
    this.destroyEffect(ctx.fx);
  }

  // 再突入による自然死。alive がすでに false なら何もしない(多重処理防止)。
  checkLoss(ctx: CheckLossCtx): void {
    if (!this.alive) return;
    if (altitudeOf(this.state.r) >= C.REENTRY_ALT) return;
    this.alive = false;
    this.destroyEffect(ctx.combatCtx.fx);
    ctx.combatCtx.activeStage.recordKill(this, ctx.combatCtx, false);
  }

  // 行動関数
  behave(dt: number, ctx: EnemyAiCtx): void {
    if (!ctx.player.alive) return;
    const dist = len(sub(ctx.player.state.r, this.state.r));
    if (!(dist < C.STAGE00_MAX_RANGE && dist > C.ENEMY_AI_MIN_RANGE)) return;

    if (this.burstLeft && this.burstLeft > 0) {
      this.burstDelay = (this.burstDelay ?? 0) - dt;
      if (this.burstDelay <= 0) {
        this.firePlasma(ctx);
        this.burstLeft--;
        this.burstDelay = C.ENEMY_BURST_INTERVAL;
      }
      return;
    }

    if (this.lastFireSim === undefined) this.lastFireSim = ctx.simTime - Math.random() * C.ENEMY_FIRE_INTERVAL;
    if (ctx.simTime - this.lastFireSim <= C.ENEMY_FIRE_INTERVAL) return;
    this.lastFireSim = ctx.simTime;

    const countInGroup = this.attackingCountInGroup(ctx.enemies);
    if (countInGroup >= C.ENEMY_MAX_ATTACKERS_PER_GROUP || Math.random() >= C.ENEMY_ATTACK_CHANCE) return;
    const counts = C.ENEMY_BURST_COUNTS;
    this.burstLeft = counts[Math.floor(Math.random() * counts.length)]! - 1;
    this.burstDelay = C.ENEMY_BURST_INTERVAL;
    this.firePlasma(ctx);
  }

  private attackingCountInGroup(enemies: readonly Enemy[]): number {
    let n = 0;
    for (const e of enemies) {
      if (e.alive && e.accent === this.accent && e.burstLeft && e.burstLeft > 0) n++;
    }
    return n;
  }

  private firePlasma(ctx: EnemyAiCtx): void {
    const r = this.state.r;
    const v = this.state.v;
    const toPlayer = sub(ctx.player.state.r, r);
    const relV = sub(ctx.player.state.v, v);

    // 正確な見越し時間を計算
    let timeToHit = solveLeadTime(toPlayer, relV, C.PLASMA_BULLET_SPEED);
    if (timeToHit === null || timeToHit < 0) {
      timeToHit = len(toPlayer) / C.PLASMA_BULLET_SPEED; // フォールバック
    }

    const predictedRelPos = add(toPlayer, scale(relV, timeToHit));
    const aimDir = norm(predictedRelPos);

    // 散布界を非常に小さくして、正確に狙う
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * C.PLASMA_SPREAD_DEG * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const bV = add(v, scale(actualAim, C.PLASMA_BULLET_SPEED));

    const pb = new Bullet({ r: clone(r), v: bV }, buildPlasmaMesh(this.accent), ctx.simTime, C.PLASMA_LIFETIME, 'enemy', 'plasma', this.scene);
    pb.obj.position.set(r.x, r.y, r.z);
    // 進行方向に向ける
    const mz = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      new THREE.Vector3(actualAim.x, actualAim.y, actualAim.z),
      new THREE.Vector3(0, 1, 0),
    );
    pb.obj.quaternion.setFromRotationMatrix(mz);

    ctx.addBullet(pb);
  }
}
