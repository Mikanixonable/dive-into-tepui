// エンティティ配列の所有と、その受動的な更新(軌道積分・慣性姿勢・寿命管理)。
// 描画同期や能動的な更新(AI・発射・スポーン判断)は行わない — それらは
// game.ts / combat.ts / stage-director.ts が担い、追加は addXxx 経由で行う。
// game.ts を import しない — 依存は constructor 注入と各メソッド引数のみ。
import * as THREE from 'three/webgpu';
import { stepAttitude } from '../physics/attitude';
import { envAccelInto } from '../physics/envaccel';
import { ExtraAccel, R_EARTH, stepOrbitRK4 } from '../physics/orbital';
import { add, clone, len, v3 } from '../physics/vec3';
import * as C from './const';
import { AmmoResupplySystem } from './combat/ammo-resupply';
import { CombatCtx, CombatSystem } from './combat/combat';
import { Bullet, Casing, DebrisPiece, Enemy, OrbitEntity } from './entities';
import { EphemerisSystem } from './ephemeris';
import { Player } from './player';
import { ThermalSystem } from './thermal';
import { Vec3 } from '../physics/nbody/bodies';

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

  private makeEnvAccel(bcInv: number): ExtraAccel {
    return (r, v, out) => envAccelInto(out ?? v3(), r, v, this.ephemeris.sunPos, this.ephemeris.moonPos, bcInv);
  }
  private readonly envShip = this.makeEnvAccel(C.SHIP_BCINV);
  private readonly envBullet = this.makeEnvAccel(C.BULLET_BCINV);
  private readonly envSmall = this.makeEnvAccel(C.SMALL_DEBRIS_BCINV);

  constructor(
    private readonly ephemeris: EphemerisSystem,
    private readonly thermal: ThermalSystem,
    private readonly ammoResupply: AmmoResupplySystem,
    private readonly combat: CombatSystem,
    private readonly scene: THREE.Scene,
  ) { }

  // ------------------------------------------------------------ 追加
  // 配列への追加はここを通す(scene への登録と上限管理まで面倒を見る)。
  // 破壊は alive = false にすれば cleanup が回収するので、削除関数は持たない。

  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
    this.scene.add(enemy.obj);
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
    this.scene.add(piece.obj);
    while (this.debris.length > C.MAX_DEBRIS) this.disposeDebris(this.debris.shift()!);
  }

  // 上限超過時は最古の個体をシーンから外す(弾・薬莢のジオメトリは共有なので破棄しない)
  private addCapped<T extends OrbitEntity>(arr: T[], entity: T, cap: number): void {
    arr.push(entity);
    this.scene.add(entity.obj);
    if (arr.length > cap) this.scene.remove(arr.shift()!.obj);
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
      this.thermal.updateThermal(dt, player.state.r, player.state.v);
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
    this.ammoResupply.stepAttitudes(attDt);
  }

  private stepWorldOrbits(dt: number, trackPrevR: boolean): void {
    this.stepEntities(this.enemies, dt, this.envShip, { skipDead: true, trackPrevR });
    this.stepEntities(this.bullets, dt, this.envBullet, { skipDead: true, trackPrevR });
    this.stepEntities(this.plasmaBullets, dt, this.envBullet, { skipDead: true, trackPrevR });
    this.stepEntities(this.casings, dt, this.envSmall);
    this.stepEntities(this.debris, dt, this.envSmall);
    this.ammoResupply.stepOrbits(dt, this.envSmall);
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

  cleanup(player: Player, combatCtx: CombatCtx, simTime: number): void {
    // 自機の構造限界高度(通常は加熱・動圧で先に喪失する)
    const playerLossReason = player.lossReasonByAltitude(altitudeOf(player.state.r));
    if (playerLossReason) {
      combatCtx.setLostReason(playerLossReason);
      this.combat.destroyShip(player, combatCtx);
    }

    for (const e of this.enemies) {
      if (e.alive && altitudeOf(e.state.r) < C.REENTRY_ALT) {
        // 再突入による空力分解はプレイヤーによる撃破ではないためカウントしない
        this.combat.destroyShip(e, combatCtx, false);
      }
    }

    this.prune(this.bullets, (b) =>
      !b.alive ||
      simTime - b.bornSim > C.BULLET_LIFETIME ||
      altitudeOf(b.state.r) < C.DEBRIS_REENTRY_ALT,
      (b) => this.scene.remove(b.obj),
    );

    this.prune(this.plasmaBullets, (pb) =>
      !pb.alive ||
      simTime - pb.bornSim > C.PLASMA_LIFETIME ||
      altitudeOf(pb.state.r) < C.DEBRIS_REENTRY_ALT,
      (pb) => this.scene.remove(pb.obj),
    );

    this.prune(this.casings, (cs) =>
      simTime - cs.bornSim > C.CASING_LIFETIME ||
      altitudeOf(cs.state.r) < C.DEBRIS_REENTRY_ALT,
      (cs) => this.scene.remove(cs.obj),
    );

    this.prune(this.debris, (d) =>
      altitudeOf(d.state.r) < C.DEBRIS_REENTRY_ALT,
      (d) => this.disposeDebris(d),
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

  // d.obj は単一 Mesh(通常の破片)の場合と、複数子メッシュを持つ Group
  // (排出された空マガジンのフレーム等)の場合がある。traverse して
  // 見つかった Mesh すべてのジオメトリ・マテリアルを破棄する。
  private disposeDebris(d: DebrisPiece): void {
    this.scene.remove(d.obj);
    d.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }
}
