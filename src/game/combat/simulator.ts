// エンティティ配列の所有と、その受動的な更新(軌道積分・慣性姿勢・寿命管理)。
// 描画同期や能動的な更新(AI・発射・スポーン判断)は行わない — それらは
// game.ts / 各 combat/ モジュール / 各 Stage(stages/)が担い、追加は addXxx 経由で行う。
// scene への add/remove は各 entity 自身の責務(entities.ts)なので、
// Simulator は配列管理・上限管理・寿命判定に専念する。
// game.ts を import しない — 依存は constructor 注入と各メソッド引数のみ。
import { stepAttitude } from '../../physics/attitude';
import { envAccelInto } from '../../physics/envaccel';
import { ExtraAccel, stepOrbitRK4 } from '../../physics/orbital';
import { add, clone, v3 } from '../../physics/vec3';
import * as C from '../const';
import type { CombatCtx } from '../stages/stage-definition';
import { HitCtx, HitSystem } from './hit';
import { Bullet, Casing, CheckLossCtx, DebrisPiece, MagPickup, OrbitEntity } from '../entities';
import { Player } from '../player/player';
import { Enemy } from '../enemy/enemy';
import { EphemerisSystem } from '../ephemeris';

export interface SimulatorCtx {
  player: Player;
  combatCtx: (simTime: number) => CombatCtx;
  hitCtx: (simTime: number) => HitCtx;
}

export interface SimulationAdvance {
  simTime: number;
  simDt: number;
}

export class Simulator {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly plasmaBullets: Bullet[] = [];
  readonly casings: Casing[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly magPickups: MagPickup[] = [];
  // 生成された累計数(prune で enemies 配列から消えても減らない)。
  // 「何機中何機撃破」等の表示は enemies.length ではなくこちらを使う。
  private totalEnemiesSpawnedValue = 0;
  get totalEnemiesSpawned(): number { return this.totalEnemiesSpawnedValue; }

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
    this.totalEnemiesSpawnedValue++;
  }

  addBullet(bullet: Bullet): void {
    this.addCapped(this.bullets, bullet, C.MAX_BULLETS);
  }

  addPlasmaBullet(bullet: Bullet): void {
    this.addCapped(this.plasmaBullets, bullet, C.MAX_BULLETS * 2);
  }

  addCasing(casing: Casing): void {
    this.addCapped(this.casings, casing, C.MAX_CASINGS);
  }

  addDebris(piece: DebrisPiece): void {
    this.debris.push(piece);
    while (this.debris.length > C.MAX_DEBRIS) this.debris.shift()!.dispose();
  }

  addMagPickup(pickup: MagPickup): void {
    this.magPickups.push(pickup);
  }

  // 上限超過時は最古の個体をシーンから外す(弾・薬莢のジオメトリは共有なので破棄しない)
  private addCapped<T extends OrbitEntity>(arr: T[], entity: T, cap: number): void {
    arr.push(entity);
    if (arr.length > cap) arr.shift()!.dispose();
  }

  // ------------------------------------------------------------ 積分

  buildPlayerAccel(thrustFn: ExtraAccel | null): ExtraAccel {
    return thrustFn ? (r, v) => add(thrustFn(r, v), this.envShip(r, v)) : this.envShip;
  }

  integrateSimulation(
    simTime: number,
    dt: number,
    simSpeed: number,
    ctx: SimulatorCtx,
    hardCollision: boolean,
    doSubstep: boolean,
    playerAccel: ExtraAccel | null = null,
  ): SimulationAdvance {
    const simDt = dt * (doSubstep ? simSpeed : Math.min(simSpeed, 4));
    const nSub = doSubstep && simSpeed > C.MAX_PHYS_SIM_SPEED ? Math.min(64, Math.ceil(simDt / 20)) : 1;
    const subDt = simDt / nSub;
    let nextSimTime = simTime;
    for (let i = 0; i < nSub; i++) {
      nextSimTime = this.simulationSubStep(nextSimTime, subDt, ctx.player, playerAccel, hardCollision);
      if (hardCollision) {
        const hitCtx = ctx.hitCtx(nextSimTime);
        this.hit.checkBulletHits(hitCtx);
        this.hit.checkBoardCrossings(hitCtx);
      }
    }
    if (!hardCollision) this.stepCoastingAttitudes(simDt);
    return { simTime: nextSimTime, simDt };
  }

  private simulationSubStep(
    simTime: number,
    dt: number,
    player: Player,
    playerAccel: ExtraAccel | null,
    trackPrevR: boolean,
  ): number {
    this.ephemeris.update(simTime);
    if (trackPrevR) player.prevR = clone(player.state.r);
    if (playerAccel && player.alive) {
      stepOrbitRK4(player.state, dt, playerAccel);
      player.thermal.updateThermal(dt, player.state.r, player.state.v);
    }
    this.stepWorldOrbits(dt, trackPrevR);
    return simTime + dt;
  }

  // 自由回転するエンティティの姿勢を進める(自機の姿勢は入力駆動なので game.ts 側)
  stepCoastingAttitudes(simDt: number): void {
    const attDt = Math.min(simDt, 0.12);
    for (const e of this.enemies) if (e.alive) stepAttitude(e.att, v3(), attDt);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    for (const mp of this.magPickups) if (mp.alive) stepAttitude(mp.att, v3(), attDt);
  }

  private stepWorldOrbits(dt: number, trackPrevR: boolean): void {
    this.stepEntities(this.enemies, dt, this.envShip, { skipDead: true, trackPrevR });
    this.stepEntities(this.bullets, dt, this.envBullet, { skipDead: true, trackPrevR });
    this.stepEntities(this.plasmaBullets, dt, this.envBullet, { skipDead: true, trackPrevR });
    this.stepEntities(this.casings, dt, this.envSmall);
    this.stepEntities(this.debris, dt, this.envSmall);
    this.stepEntities(this.magPickups, dt, this.envSmall, { skipDead: true });
  }

  private stepEntities(
    entities: OrbitEntity[],
    dt: number,
    accel: ExtraAccel,
    options: { skipDead?: boolean; trackPrevR?: boolean; } = {},
  ): void {
    const { skipDead = false, trackPrevR = false } = options;
    for (const entity of entities) {
      if (skipDead && !entity.alive) continue;
      if (trackPrevR) entity.prevR = clone(entity.state.r);
      stepOrbitRK4(entity.state, dt, accel);
    }
  }

  // ------------------------------------------------------------ 寿命管理

  // 不要になったものを除去する
  cleanup(ctx: CheckLossCtx): void {
    // 自滅要因をチェック。もし不要になっていたらalive=falseになる。
    for (const e of this.enemies) e.checkLoss(ctx);
    for (const b of this.bullets) b.checkLoss(ctx);
    for (const pb of this.plasmaBullets) pb.checkLoss(ctx);
    for (const cs of this.casings) cs.checkLoss(ctx);
    for (const d of this.debris) d.checkLoss(ctx);
    for (const mp of this.magPickups) mp.checkLoss(ctx);
    // alive=false になったものを配列から除去して scene から片付ける(dispose)。
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.plasmaBullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.magPickups);
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
}
