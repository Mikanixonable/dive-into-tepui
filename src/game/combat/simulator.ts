// エンティティ配列の所有と、その受動的な更新(軌道積分・慣性姿勢・寿命管理)。
// 描画同期や能動的な更新(AI・発射・スポーン判断)は行わない — それらは
// game.ts / combat.ts / stage-director.ts が担い、追加は addXxx 経由で行う。
// scene への add/remove は各 entity 自身の責務(entities.ts)なので、
// Simulator は配列管理・上限管理・寿命判定に専念する。
// game.ts を import しない — 依存は constructor 注入と各メソッド引数のみ。
import { stepAttitude } from '../../physics/attitude';
import { envAccelInto } from '../../physics/envaccel';
import { ExtraAccel, R_EARTH, stepOrbitRK4 } from '../../physics/orbital';
import { add, clone, len, v3 } from '../../physics/vec3';
import * as C from '../const';
import { CombatCtx, CombatSystem } from './combat';
import { Bullet, Casing, DebrisPiece, Enemy, MagPickup, OrbitEntity } from '../entities';
import { EphemerisSystem } from '../ephemeris';
import { Player } from '../player/player';
import { Vec3 } from '../../physics/nbody/bodies';

export interface SimulatorCtx {
  player: Player;
  combatCtx: (simTime: number) => CombatCtx;
}

export interface SimulationAdvance {
  simTime: number;
  simDt: number;
}

export function altitudeOf(r: Vec3): number {
  return len(r) - R_EARTH;
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
    private readonly combat: CombatSystem,
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
    warp: number,
    ctx: SimulatorCtx,
    hardCollision: boolean,
    doSubstep: boolean,
    playerAccel: ExtraAccel | null = null,
  ): SimulationAdvance {
    const simDt = dt * (doSubstep ? warp : Math.min(warp, 4));
    const nSub = doSubstep && warp > C.MAX_PHYS_WARP ? Math.min(64, Math.ceil(simDt / 20)) : 1;
    const subDt = simDt / nSub;
    let nextSimTime = simTime;
    for (let i = 0; i < nSub; i++) {
      nextSimTime = this.simulationSubStep(nextSimTime, subDt, ctx.player, playerAccel, hardCollision);
      if (hardCollision) {
        const combatCtx = ctx.combatCtx(nextSimTime);
        this.combat.checkBulletHits(combatCtx);
        this.combat.checkBoardCrossings(combatCtx);
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

  cleanup(combatCtx: CombatCtx, simTime: number): void {

    // プレイヤーによる撃破（checkBulletHits -> applyHit で alive=falseにされている、はず）
    this.prune(this.enemies,
      (e) => !e.alive,
      (e) => { this.combat.destroyShip(e, combatCtx, true); e.dispose(); },
    );

    // 再突入による破壊を除去
    this.prune(this.enemies,
      (e) => e.alive && altitudeOf(e.state.r) < C.REENTRY_ALT,
      (e) => { this.combat.destroyShip(e, combatCtx, false); e.dispose(); },
    );

    for (const e of this.enemies) {
      if (e.alive && altitudeOf(e.state.r) < C.REENTRY_ALT) {
        this.combat.destroyShip(e, combatCtx, false);
      }
    }

    // 撃破・喪失(alive=false)は destroyShip 経由でのみ起きる。ここでは配列からの
    // 除去と scene からの後片付け(軌道線含む)のみを行う — 撃破数・勝敗判定は
    // combat.ts が destroyShip 経由で自前集計するので、この配列を見に行かない。
    this.prune(this.enemies, (e) => !e.alive, (e) => e.dispose());

    this.prune(this.bullets,
      (b) => !b.alive || simTime - b.bornSim > C.BULLET_LIFETIME || altitudeOf(b.state.r) < C.DEBRIS_REENTRY_ALT,
      (b) => b.dispose(),
    );

    this.prune(this.plasmaBullets,
      (pb) => !pb.alive || simTime - pb.bornSim > C.PLASMA_LIFETIME || altitudeOf(pb.state.r) < C.DEBRIS_REENTRY_ALT,
      (pb) => pb.dispose(),
    );

    this.prune(this.casings,
      (cs) => simTime - cs.bornSim > C.CASING_LIFETIME || altitudeOf(cs.state.r) < C.DEBRIS_REENTRY_ALT,
      (cs) => cs.dispose(),
    );

    this.prune(this.debris,
      (d) => altitudeOf(d.state.r) < C.DEBRIS_REENTRY_ALT,
      (d) => d.dispose(),
    );

    // 取り込み・デスポーン判断(alive=false)は ammo-resupply.ts 側で行われる
    this.prune(this.magPickups,
      (mp) => !mp.alive || altitudeOf(mp.state.r) < C.DEBRIS_REENTRY_ALT,
      (mp) => mp.dispose(),
    );
  }

  // in-place フィルタ: 配列の参照はそのまま保つ(ctx スナップショット越しの参照を無効化しない)
  private prune<T>(arr: T[], expired: (x: T) => boolean, remove: (x: T) => void): void {
    let w = 0;
    for (const x of arr) {
      if (expired(x)) remove(x);
      else arr[w++] = x;
    }
    arr.length = w;
  }
}
