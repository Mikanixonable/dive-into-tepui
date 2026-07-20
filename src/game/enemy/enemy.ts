
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Bullet, Ship } from '../../game/entities';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import { OrbitLine } from '../../render/orbitline';
import { add, clone, len, norm, randPerp, rotateAxis, scale, sub } from '../../physics/vec3';
import { solveLeadTime } from '../../physics/intercept';
import { buildPlasmaMesh } from '../../render/ships';
import type { Player } from '../player/player';

// 敵 AI(Enemy.behave)が必要とする、Game 側の現在状態のスナップショット。
// player / enemies は参照渡し(state.r 等を読むだけでミューテートしない)。
export interface EnemyAiCtx {
  simTime: number;
  player: Player;
  enemies: readonly Enemy[]; // 同一集団の同時攻撃数カウントに使う
  scene: THREE.Scene;
  addPlasmaBullet(bullet: Bullet): void;
}

export class Enemy extends Ship {
  accent: number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  // 軌道線: 生成元(addEnemy)が生成直後に必ず設定する(scene への add も呼び出し側が行う)。
  orbitLine!: OrbitLine;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastTargetedSim?: number; // 最後にロックオンされた時刻。LEAD マーカー表示の履歴
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間

  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    hp: number,
    accent: number,
    waveId?: number,
    scene?: THREE.Scene,
  ) {
    super(name, state, obj, att, C.ENEMY_RADIUS, hp, scene);
    this.accent = accent;
    this.waveId = waveId;
    this.mass = 10000;
    this.collideRadius = C.ENEMY_RADIUS;
    this.obj.scale.setScalar(C.ENEMY_SCALE);
  }

  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
  }

  // 敵機は自機の ENEMY_SCALE 倍サイズなので、撃破エフェクトも見合った大きさにする
  protected override get destroyScale(): number { return C.ENEMY_SCALE; }
  protected override get destroyAccent(): number { return 0xff6a4a; }

  // 至近距離帯に入った自機へバースト射撃を行う(player.ts の behave に対応)。
  // 同一集団(色)内で同時攻撃するのは最大 ENEMY_MAX_ATTACKERS_PER_GROUP 機まで —
  // 集団の攻撃中カウントは呼び出し時点の ctx.enemies を都度スキャンして求める
  // (game.ts が敵配列の順に behave を呼ぶため、直前に発射を始めた個体も反映される)。
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

    const pb = new Bullet({ r: clone(r), v: bV }, buildPlasmaMesh(this.accent), ctx.simTime, ctx.scene);
    pb.obj.position.set(r.x, r.y, r.z);
    // 進行方向に向ける
    const mz = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      new THREE.Vector3(actualAim.x, actualAim.y, actualAim.z),
      new THREE.Vector3(0, 1, 0),
    );
    pb.obj.quaternion.setFromRotationMatrix(mz);

    ctx.addPlasmaBullet(pb);
  }
}
