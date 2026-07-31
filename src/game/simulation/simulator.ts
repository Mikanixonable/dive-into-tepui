// 実シミュレーションの更新(軌道積分・弾命中・剛体接触・慣性姿勢積分)。simTime/lastSimDt を保持する。
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

  simTime = 0;
  lastSimDt = 0;

  // hitSystem/collisionPhysics を構築する。entities/ephemeris/sfx は参照として保持する。
  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly _sfx: Sfx,
  ) {
    this.hitSystem = new HitSystem();
    this.collisionPhysics = new CollisionPhysics();
  }

  // dt 分のシミュレーションを進める。simDt をサブステップに分割して積分し、弾命中判定・剛体接触・姿勢積分を行う。
  stepSimulation(
    dt: number,
    simDt: number,
    player: Player,
    activeStage: Stage,
    bulletCollision: boolean,
    resolveCollision: boolean,
    doSubstep: boolean,
  ): void {
    // fps によらず積分の刻みを一定に保つため、サブステップ数は simDt のみから決める。
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

  // 全エンティティを dt だけ積分する。積分後の simTime を返す。
  private simulationSubStep(
    simTime: number,
    dt: number,
    player: Player,
  ): number {
    // サブステップ中点の太陽/月位置を1回だけ求めて全エンティティで共有する
    const mid = simTime + dt / 2;
    const sunPos = this.ephemeris.sunPosAt(mid);
    const moonPos = this.ephemeris.moonPosAt(mid);

    // 各エンティティを積分する
    player.stepSim(dt, sunPos, moonPos);
    for (const e of this.entities.enemies) e.stepSim(dt, sunPos, moonPos);
    for (const b of this.entities.bullets) b.stepSim(dt, sunPos, moonPos);
    for (const c of this.entities.casings) c.stepSim(dt, sunPos, moonPos);
    for (const d of this.entities.debris) d.stepSim(dt, sunPos, moonPos);
    for (const a of this.entities.ammos) a.stepSim(dt, sunPos, moonPos);

    player.thermal.updateThermal(dt, player.state.r, player.state.v);

    return simTime + dt;
  }

  // 全エンティティの姿勢をそれぞれのトルクから積分する。
  private stepAttitudes(simDt: number, player: Player): void {
    player.att = stepAttitude(player.att, player.torque, simDt);

    const attDt = Math.min(simDt, 0.12);
    for (const e of this.entities.enemies) if (e.alive) e.att = stepAttitude(e.att, e.torque, attDt);
    for (const cs of this.entities.casings) cs.att = stepAttitude(cs.att, cs.torque, attDt);
    for (const d of this.entities.debris) d.att = stepAttitude(d.att, d.torque, attDt);
    for (const ammo of this.entities.ammos) if (ammo.alive) ammo.att = stepAttitude(ammo.att, ammo.torque, attDt);
  }
}
