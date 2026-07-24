// エンティティ配列の所有と、その受動的な更新(軌道積分・慣性姿勢・寿命管理)。
// 描画同期や能動的な更新(AI・発射・スポーン判断)は game.ts / 各 Stage(stages/)/
// Enemy.behave が担い、追加は addXxx 経由で行う。scene への add/remove は各 entity
// 自身の責務(entities.ts)なので、Simulator は配列管理・上限管理・寿命判定に専念する。
import { stepAttitude } from '../../physics/attitude';
import { envAccelInto } from '../../physics/envaccel';
import { ExtraAccel, stepOrbitRK4 } from '../../physics/orbital';
import { add, clone, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { HitSystem } from './hit';
import { Ammo, DebrisPiece, OrbitEntity } from './entities';
import { Player } from '../player/player';
import { Enemy } from './enemy';
import { Bullet } from './bullet';
import { EphemerisSystem } from '../ephemeris';
import type { Stage } from '../stages/stage';

export class Simulator {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  // casings/debris は DebrisPiece の kind によって振り分けられる別々の上限プール
  // (薬莢は撃破デブリより大量・頻繁に出るため、上限を分けて管理する)。
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly ammos: Ammo[] = [];

  // シミュレーション時刻(ECI 時間の経過)。game.ts は simSpeedManager から simDt を
  // 計算して渡す責務のみを持ち、その積算(simTime の保持・更新)はここが担う。
  simTime = 0;
  lastSimDt = 0;

  private makeEnvAccel(bcInv: number): ExtraAccel {
    return (r, v, out) => envAccelInto(out ?? v3(), r, v, this.ephemeris.sunPos, this.ephemeris.moonPos, bcInv);
  }
  private readonly envShip = this.makeEnvAccel(C.SHIP_BCINV);
  private readonly envBullet = this.makeEnvAccel(C.BULLET_BCINV);
  private readonly envSmall = this.makeEnvAccel(C.SMALL_DEBRIS_BCINV);

  constructor(
    private readonly ephemeris: EphemerisSystem,
    private readonly hit: HitSystem,
  ) { }

  // ------------------------------------------------------------ 追加
  // 配列への追加はここを通す(上限管理まで面倒を見る)。scene への登録は
  // entity 自身のコンストラクタが既に済ませている。破壊は alive = false に
  // すれば cleanup が回収するので、削除関数は持たない。

  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
  }

  addBullet(bullet: Bullet): void {
    this.addCapped(this.bullets, bullet, C.MAX_BULLETS * 3);
  }

  addDebris(piece: DebrisPiece): void {
    if (piece.kind === 'casing') this.addCapped(this.casings, piece, C.MAX_CASINGS);
    else this.addCapped(this.debris, piece, C.MAX_DEBRIS);
  }

  addAmmo(ammo: Ammo): void {
    this.ammos.push(ammo);
  }

  // 上限超過時は最古の個体をシーンから外す(弾・薬莢のジオメトリは共有なので破棄しない)
  private addCapped<T extends OrbitEntity>(arr: T[], entity: T, cap: number): void {
    arr.push(entity);
    if (arr.length > cap) arr.shift()!.dispose();
  }

  allEntities(): OrbitEntity[] {
    return [
      ...this.enemies,
      ...this.bullets,
      ...this.ammos,
      ...this.casings,
      ...this.debris
    ];
  }

  // ------------------------------------------------------------ 積分

  // entity.thrustFn(既定 null = 無推力)と環境加速度を合成する。
  private accelFor(entity: OrbitEntity, envAccel: ExtraAccel): ExtraAccel {
    const { thrustFn } = entity;
    return thrustFn ? (r, v) => add(thrustFn(r, v), envAccel(r, v)) : envAccel;
  }

  // simDt(このフレームで積算すべきシミュレーション時間)は game.ts が
  // simSpeedManager から計算して渡す。ここでは受け取った simDt をサブステップに
  // 分割して積分し、simTime/lastSimDt を自ら進めるだけ。
  stepSimulation(
    dt: number,
    simDt: number,
    player: Player,
    activeStage: Stage,
    hardCollision: boolean,
    doSubstep: boolean,
  ): void {
    // 謎実装
    const nSub = doSubstep && simDt > dt * C.MAX_PHYS_SIM_SPEED ? Math.min(64, Math.ceil(simDt / 20)) : 1;

    const subDt = simDt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.simTime = this.simulationSubStep(this.simTime, subDt, player, hardCollision);
      if (hardCollision) {
        this.hit.checkBulletHits(this.simTime, player, activeStage, this);
      }
    }

    this.stepCoastingAttitudes(simDt);
    this.lastSimDt = simDt;
  }

  private simulationSubStep(
    simTime: number,
    dt: number,
    player: Player,
    trackPrevR: boolean,
  ): number {
    this.ephemeris.update(simTime);
    
    this.stepEntity(player, dt, this.envShip, trackPrevR);
    this.enemies.forEach(e => this.stepEntity(e, dt, this.envShip, trackPrevR));
    this.bullets.forEach(b => this.stepEntity(b, dt, this.envBullet, trackPrevR));
    this.casings.forEach(c => this.stepEntity(c, dt, this.envSmall, false));
    this.debris.forEach(d => this.stepEntity(d, dt, this.envSmall, false));
    this.ammos.forEach(a => this.stepEntity(a, dt, this.envSmall, false));
    
    player.thermal.updateThermal(dt, player.state.r, player.state.v);
    
    return simTime + dt;
  }

  private stepEntity(
    entity: OrbitEntity,
    dt: number,
    envAccel: ExtraAccel,
    trackPrevR: boolean = false,
  ): void {
    if (!entity.alive) return;
    if (trackPrevR) entity.prevR = clone(entity.state.r);
    stepOrbitRK4(entity.state, dt, this.accelFor(entity, envAccel));
  }

  // ------------------------------------------------------------ 回転運動
  
  // 自由回転するエンティティの姿勢を進める(自機の姿勢は入力駆動なので game.ts 側)
  private stepCoastingAttitudes(simDt: number): void {
    const attDt = Math.min(simDt, 0.12);
    for (const e of this.enemies) if (e.alive) stepAttitude(e.att, v3(), attDt);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    for (const ammo of this.ammos) if (ammo.alive) stepAttitude(ammo.att, v3(), attDt);
  }

  // ------------------------------------------------------------ 寿命管理

  // 不要になったものを除去する
  cleanup(dt: number, activeStage: Stage): void {
    // 自滅要因をチェック。もし不要になっていたらalive=falseになる。
    for (const e of this.enemies) e.checkLoss(dt, this.simTime, activeStage);
    for (const b of this.bullets) b.checkLoss(dt, this.simTime, activeStage);
    for (const cs of this.casings) cs.checkLoss(dt, this.simTime, activeStage);
    for (const d of this.debris) d.checkLoss(dt, this.simTime, activeStage);
    for (const ammo of this.ammos) ammo.checkLoss(dt, this.simTime, activeStage);
    // alive=false になったものを配列から除去して scene から片付ける(dispose)。
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammos);
  }

  // in-place フィルタ: 配列の参照はそのまま保つ(ctx スナップショット越しの参照を無効化しない)
  private prune<T extends OrbitEntity>(arr: T[]): void {
    let w = 0;
    for (const x of arr) {
      if (!x.alive) x.dispose();
      else arr[w++] = x;
    }
    arr.length = w;
  }

  // ------------------------------------------------------------ 描画同期
  
  sync(fo: FloatingOrigin): void {
    this.allEntities().forEach(e => e.sync(fo));
  }
}
