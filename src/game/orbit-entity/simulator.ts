// 実シミュレーションの更新(軌道積分・弾命中・剛体接触・慣性姿勢積分)。対象のエンティティ配列は
// 持たず、EntityManager の参照を受け取って回す(配列の保持・追加・上限管理・寿命回収は
// EntityManager の責務)。simTime/lastSimDt の保持もここ。Game だけが参照する。
import { stepAttitude } from '../../physics/attitude';
import * as C from '../const';
import { HitSystem } from './hit';
import { EntityManager } from './entity-manager';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Stage } from '../stages/stage';
import { CollisionPhysics } from './collision';
import { Sfx } from '../../audio/sfx';

export class Simulator {
  readonly hitSystem: HitSystem;
  readonly collisionPhysics: CollisionPhysics;

  // シミュレーション時刻(ECI 時間の経過)。game.ts は simSpeedManager から simDt を
  // 計算して渡す責務のみを持ち、その積算(simTime の保持・更新)はここが担う。
  simTime = 0;
  lastSimDt = 0;

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly _sfx: Sfx,
  ) {
    this.hitSystem = new HitSystem();
    this.collisionPhysics = new CollisionPhysics();
  }

  // ------------------------------------------------------------ 積分

  // simDt(このフレームで積算すべきシミュレーション時間)は game.ts が
  // simSpeedManager から計算して渡す。ここでは受け取った simDt をサブステップに
  // 分割して積分し、simTime/lastSimDt を自ら進めるだけ。
  stepSimulation(
    dt: number,
    simDt: number,
    player: Player,
    activeStage: Stage,
    bulletCollision: boolean,
    resolveCollision: boolean,
    doSubstep: boolean,
  ): void {
    // サブステップ数はこのフレームで進めるシミュレーション時間 simDt のみから決める
    // (実フレーム時間 dt を条件に含めると、同じワープ倍率でも fps によって積分の刻みが
    // 変わってしまう)。1サブステップを SUBSTEP_MAX_DT 秒以下に保ちつつ、
    // SUBSTEP_MAX_COUNT で上限を設けてワープ最大時に1フレームの計算量が爆発しないようにする。
    const nSub = doSubstep
      ? Math.min(C.SUBSTEP_MAX_COUNT, Math.max(1, Math.ceil(simDt / C.SUBSTEP_MAX_DT)))
      : 1;

    const subDt = simDt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.simTime = this.simulationSubStep(this.simTime, subDt, player);
      if (bulletCollision) {
        this.hitSystem.checkBulletHits(this.simTime, player, activeStage, this.entities);
      }
    }

    if (resolveCollision) {
      this.collisionPhysics.resolve(dt, player, this.entities.all(), () => this._sfx.clank());
    }

    this.stepAttitudes(simDt, player);
    this.lastSimDt = simDt;
  }

  // 各 entity の積分そのもの(中心重力 + 環境加速度 + 推力)は entity.stepSim の責務。
  // ここは太陽・月位置を今サブステップぶんだけ求め、全配列へ配って回るだけ。
  private simulationSubStep(
    simTime: number,
    dt: number,
    player: Player,
  ): number {
    const sunPos = this.ephemeris.sunPosAt(simTime);
    const moonPos = this.ephemeris.moonPosAt(simTime);

    player.stepSim(dt, sunPos, moonPos);
    for (const e of this.entities.enemies) e.stepSim(dt, sunPos, moonPos);
    for (const b of this.entities.bullets) b.stepSim(dt, sunPos, moonPos);
    for (const c of this.entities.casings) c.stepSim(dt, sunPos, moonPos);
    for (const d of this.entities.debris) d.stepSim(dt, sunPos, moonPos);
    for (const a of this.entities.ammos) a.stepSim(dt, sunPos, moonPos);

    player.thermal.updateThermal(dt, player.state.r, player.state.v);

    return simTime + dt;
  }

  // ------------------------------------------------------------ 回転運動

  // 全エンティティの姿勢を entity.torque に従って積分する(既定ゼロ = 自由回転)。
  // 自機は PlayerThrottle が毎フレーム torque を書き込む(それ以外は既定ゼロのまま)。
  private stepAttitudes(simDt: number, player: Player): void {
    player.att = stepAttitude(player.att, player.torque, simDt);

    const attDt = Math.min(simDt, 0.12);
    for (const e of this.entities.enemies) if (e.alive) e.att = stepAttitude(e.att, e.torque, attDt);
    for (const cs of this.entities.casings) cs.att = stepAttitude(cs.att, cs.torque, attDt);
    for (const d of this.entities.debris) d.att = stepAttitude(d.att, d.torque, attDt);
    for (const ammo of this.entities.ammos) if (ammo.alive) ammo.att = stepAttitude(ammo.att, ammo.torque, attDt);
  }
}
