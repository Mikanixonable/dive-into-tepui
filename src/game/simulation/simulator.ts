// 実シミュレーションの更新(軌道積分・剛体接触・慣性姿勢積分)。simTime/lastSimDt を保持する。
import { stepAttitude } from '../../physics/attitude';
import type { KinematicState } from '../../physics/kinematic-state';
import * as C from '../const';
import { attractorsAt, attractorsNearInto, classifyAttractors } from './attractors';
import { EntityManager } from './entity-manager';
import { Player } from '../player/player';
import { Bullet } from '../game-entity/bullet';
import { DebrisPiece } from '../game-entity/debris-piece';
import type { GameEntity } from '../game-entity/game-entity';
import type { Attractor } from '../../physics/attractor';
import { Ephemeris } from '../../physics/ephemeris';
import type { Stage } from '../stages/stage';
import { ContactPhysics } from './contact';
import { R_EARTH } from '../../physics/solar-system';
import { v3 } from '../../physics/vec3';
import { adaptiveSimulationMaxStep, simulationStepDuration } from './time-step';
import type { NanWatchdog } from '../nan-watchdog';
import { FrameSections, SECTION } from '../../frame-sections';

export class Simulator {
  readonly contactPhysics: ContactPhysics;

  simTime: number;
  lastSimDt = 0;
  lastSubsteps = 0;
  lastGravitySourceCount = 0;
  // 今フレームに走った軌道積分(GameEntity.stepActual)の呼び出し回数。
  lastOrbitSteps = 0;
  // エンティティ側の最小イベント時刻の控えと、それを求めたときの LOD・顔ぶれの世代。
  private cachedEventTime: number | null = null;
  private cachedEventValid = false;
  private cachedEventLod = false;
  private cachedEventRevision = -1;
  private readonly adaptiveStatesScratch: KinematicState[] = [];
  private readonly contactEntitiesScratch: GameEntity[] = [];

  // entities/ephemeris/sections は参照として保持する。initialSimTime はシミュレーションの開始時刻。
  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly sections: FrameSections,
    initialSimTime = 0,
  ) {
    this.contactPhysics = new ContactPhysics();
    this.simTime = initialSimTime;
  }

  private readonly nearbyAttractorsScratch: Parameters<typeof attractorsNearInto>[2] = [];

  // dt 分のシミュレーションを進める。simDt をサブステップに分割して積分し、剛体接触(弾命中含む)・姿勢積分を行う。
  // nanWatchdog は軌道積分・姿勢積分・剛体接触・ベルトの各境界ごとに自機を検査する
  // (checkPlayer は軽量なので substep ごとに呼んでよい)。
  advance(
    dt: number,
    simDt: number,
    player: Player | null,
    activeStage: Stage,
    resolveCollision: boolean,
    doSubstep: boolean,
    nanWatchdog: NanWatchdog,
  ): void {
    this.lastSubsteps = 0;
    this.lastGravitySourceCount = 0;
    this.lastOrbitSteps = 0;
    const targetTime = this.simTime + simDt;
    // ×4を超えるワープでは射撃・剛体衝突が無効なので、弾と薬莢/破片は途中のsubstepで
    // 相互作用を起こさない。これらだけを最後に一度まとめて積分し、高warpのS倍走査を避ける。
    const passiveWarpLod = !resolveCollision && doSubstep && simDt > C.SUBSTEP_MAX_DT;
    while (this.simTime < targetTime - 1e-9) {
      const remaining = targetTime - this.simTime;
      const maxStep = doSubstep ? this.adaptiveMaxStep() : remaining;
      const eventTime = this.nextEventTime(activeStage, passiveWarpLod);
      const subDt = simulationStepDuration(this.simTime, targetTime, maxStep, eventTime);
      // 浮動小数点の丸めでゼロ刻みになったイベントは現在時刻で消費して前進を保証する。
      if (subDt <= 1e-9) {
        activeStage.applySimulationEvents(this.simTime);
        this.entities.cleanup(0, this.simTime, activeStage, player?.state.r ?? v3(), this.ephemeris.attractorsAt(this.simTime));
        continue;
      }

      this.sections.enter(SECTION.orbit);
      this.simTime = this.substep(this.simTime, subDt, passiveWarpLod);
      this.sections.exit(SECTION.orbit);
      this.lastSubsteps++;
      if (player) nanWatchdog.checkPlayer('simulator.advance(軌道積分)', player, this.simTime, dt, subDt);
      this.sections.enter(SECTION.attitude);
      this.stepAttitudes(subDt, passiveWarpLod);
      this.sections.exit(SECTION.attitude);
      if (player) nanWatchdog.checkPlayer('simulator.advance(姿勢積分)', player, this.simTime, dt, subDt);
      for (const p of this.entities.players) p.stepEnvironment(subDt, this.ephemeris, this.simTime);
      const attractorsNow = this.ephemeris.attractorsAt(this.simTime);
      if (resolveCollision) {
        // 放熱板の折りは EntityManager に登録された実体ではなく、艦の姿勢から毎 substep
        // 置き直す接触代理なので、参加者リストへこの場で合流させる。
        this.contactEntitiesScratch.length = 0;
        this.contactEntitiesScratch.push(...this.entities.all());
        for (const p of this.entities.players) {
          if (!p.alive) continue;
          this.contactEntitiesScratch.push(...p.collisionFolds(this.simTime));
        }
        this.sections.enter(SECTION.contact);
        this.contactPhysics.resolveSubstep(
          this.simTime, this.contactEntitiesScratch, attractorsNow, activeStage);
        this.sections.exit(SECTION.contact);
        if (player) nanWatchdog.checkPlayer('simulator.advance(接触)', player, this.simTime, dt, subDt);
      }
      activeStage.applySimulationEvents(this.simTime);
      // 期限切れ弾が同じsubstepの接触解決へ進まないよう、既知境界の直後に回収する。
      this.entities.cleanup(subDt, this.simTime, activeStage, player?.state.r ?? v3(), attractorsNow);
    }

    if (passiveWarpLod) this.stepPassiveWarpEntities(this.ephemeris.attractorsAt(this.simTime));

    // ベルトは実dtで解く艦にくっついた局所シミュレーションなので、substepループの外で
    // フレームに1回だけ解決する。
    if (resolveCollision && player) {
      this.sections.enter(SECTION.contact);
      this.contactPhysics.resolveBelt(
        dt, this.simTime, player, this.entities.all(), this.ephemeris.attractorsAt(this.simTime), activeStage,
      );
      this.sections.exit(SECTION.contact);
      nanWatchdog.checkPlayer('simulator.advance(ベルト)', player, this.simTime, dt, this.lastSimDt);
    }

    this.lastSimDt = simDt;
  }

  // 生存する艦の高度から今フレームのサブステップ上限 [s] を求める。
  private adaptiveMaxStep(): number {
    this.adaptiveStatesScratch.length = 0;
    // 加熱・動圧の積分結果が存続を左右し、その帰結をプレイヤーが観測するのは艦だけ。
    // 他の種別は大気圏に入れば失われるだけで、いつどれだけの精度で失われるかはプレイの結果を変えない。
    for (const p of this.entities.players) {
      if (p.alive) this.adaptiveStatesScratch.push(p.state);
    }
    for (const e of this.entities.enemies) {
      if (e.alive) this.adaptiveStatesScratch.push(e.state);
    }
    return adaptiveSimulationMaxStep(
      this.adaptiveStatesScratch,
      R_EARTH + C.REENTRY_SUBSTEP_ALT,
      C.SUBSTEP_MAX_DT,
      C.REENTRY_SUBSTEP_MAX_DT,
    );
  }

  // ステージと生存エンティティが持つ次イベント時刻のうち最も早いものを返す。無ければ null。
  // ステージ側の時刻は艦の現在の Δv と加速度から毎回決まる生きた値なので毎回引き直す。
  private nextEventTime(activeStage: Stage, passiveWarpLod: boolean): number | null {
    const stage = activeStage.nextSimulationEventTime(this.simTime);
    const entity = this.entityEventTime(passiveWarpLod);
    if (stage === null) return entity;
    if (entity === null) return stage;
    return Math.min(stage, entity);
  }

  // 生存エンティティが持つ次イベント時刻のうち最も早いもの。無ければ null。エンティティ側の
  // 締切は固定の絶対時刻なので、保持した時刻を simTime が越えたときと、エンティティの顔ぶれの
  // 世代が変わったときにだけ全走査で引き直す。
  private entityEventTime(passiveWarpLod: boolean): number | null {
    const revision = this.entities.collectionRevision;
    const stale = !this.cachedEventValid
      || this.cachedEventLod !== passiveWarpLod
      || this.cachedEventRevision !== revision
      || (this.cachedEventTime !== null && this.cachedEventTime <= this.simTime);
    if (!stale) return this.cachedEventTime;

    let next: number | null = null;
    for (const e of this.entities.all()) {
      if (!e.alive) continue;
      // まとめ積分に回る個体の締切で substep を切っても、その境界で解決される相互作用がない。
      if (passiveWarpLod && this.isPassiveWarpEntity(e)) continue;
      const t = e.nextSimulationEventTime(this.simTime);
      if (t !== null && (next === null || t < next)) next = t;
    }
    this.cachedEventTime = next;
    this.cachedEventValid = true;
    this.cachedEventLod = passiveWarpLod;
    this.cachedEventRevision = revision;
    return next;
  }

  // 全エンティティを dt だけ積分する。重力源はこのステップの中点(t + dt/2)で1回だけ組み、
  // 空間グリッドへ分類してから全エンティティで使い回す — 各自が積分後の新しい位置を読みに
  // 行くと、本来対称であるべき相互作用に処理順依存の誤差が入る。各エンティティは自身の位置の
  // 27近傍グリッドを引き直すだけで、分類そのものはこのステップで1回。積分後の simTime を返す。
  private substep(
    simTime: number,
    dt: number,
    passiveWarpLod: boolean,
  ): number {
    const sources = attractorsAt(this.ephemeris, this.entities, simTime + dt / 2);
    this.lastGravitySourceCount = sources.length;
    const classified = classifyAttractors(sources);
    for (const e of this.entities.all()) {
      if (passiveWarpLod && this.isPassiveWarpEntity(e)) continue;
      e.stepActual(dt, attractorsNearInto(e.state.r, classified, this.nearbyAttractorsScratch));
      this.lastOrbitSteps++;
    }

    return simTime + dt;
  }

  // 軌道積分と同じ刻み幅 simDt で全エンティティの姿勢を進める。
  private stepAttitudes(simDt: number, passiveWarpLod: boolean): void {
    for (const p of this.entities.players) p.att = stepAttitude(p.att, p.torque, simDt);

    for (const e of this.entities.enemies) if (e.alive) e.att = stepAttitude(e.att, e.torque, simDt);
    if (!passiveWarpLod) {
      for (const cs of this.entities.casings) cs.att = stepAttitude(cs.att, cs.torque, simDt);
      for (const d of this.entities.debris) d.att = stepAttitude(d.att, d.torque, simDt);
    }
    for (const ammo of this.entities.ammos) if (ammo.alive) ammo.att = stepAttitude(ammo.att, ammo.torque, simDt);
  }

  private isPassiveWarpEntity(e: GameEntity): boolean {
    return e instanceof Bullet || e instanceof DebrisPiece;
  }

  // 途中のsubstepを飛ばした弾・破片を、最終時刻まで一度だけ進める。高warp中は弾道命中・
  // 剛体接触を無効にしているため、途中の掃引判定を失ってもゲームプレイ上の相互作用はない。
  private stepPassiveWarpEntities(attractors: readonly Attractor[]): void {
    const step = (e: GameEntity): void => {
      if (!e.alive) return;
      const elapsed = this.simTime - e.state.t;
      if (elapsed <= 1e-9) return;
      e.stepActual(elapsed, attractors);
      this.lastOrbitSteps++;
      e.att = stepAttitude(e.att, e.torque, elapsed);
    };
    for (const bullet of this.entities.bullets) step(bullet);
    for (const casing of this.entities.casings) step(casing);
    for (const debris of this.entities.debris) step(debris);
  }
}
