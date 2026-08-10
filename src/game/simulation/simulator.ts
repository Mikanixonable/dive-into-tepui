// 実シミュレーションの更新(軌道積分・剛体接触・慣性姿勢積分)。simTime/lastSimDt を保持する。
import { stepAttitude } from '../../physics/attitude';
import * as C from '../const';
import { attractorsAt, attractorsNear, classifyAttractors } from './attractors';
import { EntityManager } from './entity-manager';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Stage } from '../stages/stage';
import { ContactPhysics } from './contact';
import { R_EARTH } from '../../physics/solar-system';
import { v3 } from '../../physics/vec3';
import { adaptiveSimulationMaxStep, simulationStepDuration } from './time-step';

export class Simulator {
  readonly contactPhysics: ContactPhysics;

  simTime = 0;
  lastSimDt = 0;

  // entities/ephemeris は参照として保持する。
  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
  ) {
    this.contactPhysics = new ContactPhysics();
  }

  // dt 分のシミュレーションを進める。simDt をサブステップに分割して積分し、剛体接触(弾命中含む)・姿勢積分を行う。
  advance(
    dt: number,
    simDt: number,
    player: Player | null,
    activeStage: Stage,
    resolveCollision: boolean,
    doSubstep: boolean,
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
      const attractorsNow = this.ephemeris.attractorsAt(this.simTime);
      if (resolveCollision) {
        // 放熱板の折りは EntityManager に登録された実体ではなく、艦の姿勢から毎 substep
        // 置き直す接触代理なので、参加者リストへこの場で合流させる。
        const radiatorFolds = this.entities.players.flatMap(
          (p) => p.alive ? p.collisionFolds(this.simTime) : []);
        this.contactPhysics.resolveSubstep(
          this.simTime, [...this.entities.all(), ...radiatorFolds], attractorsNow, activeStage);
      }
      activeStage.applySimulationEvents(this.simTime);
      // 期限切れ弾が同じsubstepの接触解決へ進まないよう、既知境界の直後に回収する。
      this.entities.cleanup(subDt, this.simTime, activeStage, player?.state.r ?? v3(), attractorsNow);
    }

    // ベルトは実dtで解く艦にくっついた局所シミュレーションなので、substepループの外で
    // フレームに1回だけ解決する(§3-8)。
    if (resolveCollision && player) {
      this.contactPhysics.resolveBelt(
        dt, this.simTime, player, this.entities.all(), this.ephemeris.attractorsAt(this.simTime), activeStage,
      );
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

  // 全エンティティを dt だけ積分する。重力源はこのステップの中点(t + dt/2)で1回だけ組み、
  // 空間グリッドへ分類してから全エンティティで使い回す — 各自が積分後の新しい位置を読みに
  // 行くと、本来対称であるべき相互作用に処理順依存の誤差が入る。各エンティティは自身の位置の
  // 27近傍グリッドを引き直すだけで、分類そのものはこのステップで1回。積分後の simTime を返す。
  private substep(
    simTime: number,
    dt: number,
  ): number {
    const classified = classifyAttractors(attractorsAt(this.ephemeris, this.entities, simTime + dt / 2));
    for (const e of this.entities.all()) e.stepActual(dt, attractorsNear(e.state.r, classified));

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
