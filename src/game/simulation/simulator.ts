// 実シミュレーションの更新(軌道積分・弾命中・剛体接触・慣性姿勢積分)。simTime/lastSimDt を保持する。
import { stepAttitude } from '../../physics/attitude';
import * as C from '../const';
import { HitSystem } from './hit';
import { EffectsSystem } from '../vfx/effects-system';
import { EntityManager } from './entity-manager';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Stage } from '../stages/stage';
import { CollisionPhysics } from './collision';
import { Sfx } from '../../audio/sfx';
import { GameEntity } from '../game-entity/game-entity';
import { R_EARTH } from '../../physics/kinematic-state';
import { v3 } from '../../physics/vec3';
import { adaptiveSimulationMaxStep, simulationStepDuration } from './time-step';

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
    private readonly fx: EffectsSystem,
  ) {
    this.hitSystem = new HitSystem(this.fx, this._sfx);
    this.collisionPhysics = new CollisionPhysics();
  }

  // dt 分のシミュレーションを進める。simDt をサブステップに分割して積分し、弾命中判定・剛体接触・姿勢積分を行う。
  advance(
    dt: number,
    simDt: number,
    player: Player | null,
    activeStage: Stage,
    bulletCollision: boolean,
    resolveCollision: boolean,
    doSubstep: boolean,
    onHighSpeedImpact?: (a: GameEntity, b: GameEntity, speed: number) => void,
  ): void {
    const targetTime = this.simTime + simDt;
    while (this.simTime < targetTime - 1e-9) {
      const remaining = targetTime - this.simTime;
      const maxStep = doSubstep ? this.adaptiveMaxStep() : remaining;
      const eventTime = this.nextEventTime(activeStage);
      const subDt = simulationStepDuration(this.simTime, targetTime, maxStep, eventTime);
      // 浮動小数点の丸めでゼロ刻みになったイベントは現在時刻で消費して前進を保証する。
      if (subDt <= 1e-9) {
        activeStage.applySimulationEvents(this.simTime);
        this.entities.cleanup(0, this.simTime, activeStage, player?.state.r ?? v3(), this.ephemeris.attractorsAt(this.simTime));
        continue;
      }

      this.simTime = this.substep(this.simTime, subDt);
      this.stepAttitudes(subDt);
      for (const p of this.entities.players) p.stepEnvironment(subDt, this.ephemeris, this.simTime);
      activeStage.applySimulationEvents(this.simTime);
      // 期限切れ弾が同じsubstepの命中判定へ進まないよう、既知境界の直後に回収する。
      this.entities.cleanup(subDt, this.simTime, activeStage, player?.state.r ?? v3(), this.ephemeris.attractorsAt(this.simTime));
      if (bulletCollision) {
        this.hitSystem.checkBulletHits(this.simTime, player, activeStage, this.entities);
      }
    }

    if (resolveCollision && player) {
      this.collisionPhysics.resolve(dt, player, this.entities.all(), () => this._sfx.clank(), onHighSpeedImpact);
    }

    this.lastSimDt = simDt;
  }

  // 生存エンティティの高度から今フレームのサブステップ上限 [s] を求める。
  private adaptiveMaxStep(): number {
    return adaptiveSimulationMaxStep(
      this.entities.all().filter((e) => e.alive).map((e) => e.state),
      R_EARTH + C.REENTRY_SUBSTEP_ALT,
      C.SUBSTEP_MAX_DT,
      C.REENTRY_SUBSTEP_MAX_DT,
    );
  }

  // ステージと全生存エンティティが持つ次イベント時刻のうち最も早いものを返す。無ければ null。
  private nextEventTime(activeStage: Stage): number | null {
    let next = activeStage.nextSimulationEventTime(this.simTime);
    for (const e of this.entities.all()) {
      if (!e.alive) continue;
      const t = e.nextSimulationEventTime(this.simTime);
      if (t !== null && (next === null || t < next)) next = t;
    }
    return next;
  }

  // 全エンティティを dt だけ積分する。積分後の simTime を返す。
  private substep(
    simTime: number,
    dt: number,
  ): number {
    for (const p of this.entities.players) p.stepActual(dt, this.ephemeris);
    for (const e of this.entities.enemies) e.stepActual(dt, this.ephemeris);
    for (const b of this.entities.bullets) b.stepActual(dt, this.ephemeris);
    for (const c of this.entities.casings) c.stepActual(dt, this.ephemeris);
    for (const d of this.entities.debris) d.stepActual(dt, this.ephemeris);
    for (const a of this.entities.ammos) a.stepActual(dt, this.ephemeris);
    for (const b of this.entities.bases) b.stepActual(dt, this.ephemeris);

    return simTime + dt;
  }

  // 軌道積分と同じ刻み幅 simDt で全エンティティの姿勢を進める。
  private stepAttitudes(simDt: number): void {
    for (const p of this.entities.players) p.att = stepAttitude(p.att, p.torque, simDt);

    for (const e of this.entities.enemies) if (e.alive) e.att = stepAttitude(e.att, e.torque, simDt);
    for (const cs of this.entities.casings) cs.att = stepAttitude(cs.att, cs.torque, simDt);
    for (const d of this.entities.debris) d.att = stepAttitude(d.att, d.torque, simDt);
    for (const ammo of this.entities.ammos) if (ammo.alive) ammo.att = stepAttitude(ammo.att, ammo.torque, simDt);
  }
}
