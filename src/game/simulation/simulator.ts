// 実シミュレーションの更新(軌道積分・剛体接触・慣性姿勢積分)。simTime/lastSimDt を保持する。
//
// 予測(game/simulation/predictor.ts の Predictor)との役割の違いは2点で、二重性はこの2点に
// 由来する。統一はできない。
//  1. 同時性。こちらは生存する全個体(破片まで含めて多数)を、同じ1つの瞬間で同時に進める。
//     同時だからこそ、重力源と表面を持つ天体の絞り込みをサブステップに1つだけ組んで全個体で
//     使い回せるし、個体どうしの剛体接触も解ける — 接触は両者が同じ瞬間にいて初めて意味を持つ。
//  2. 刻みの決まり方。こちらは毎フレーム simTime + simDt へ必ず到達しなければならないので、
//     刻みはそのフレームの時間送りから決まる。予測は追い越されない範囲で先へ伸びればよいので、
//     1フレームの歩数を予算で切って足りなければ遅れる。
// **この2点に起因しない部分は、両者で同じ答えでなければならない** — 個体1つと解析天体の
// 関係(どの天体が引くか・表面へ到達したか・大気で焼失したか・刻みをどこまで広げてよいか)。
// 探し方が違うのは同時性から来る正当な差だが、答えが違ってよい理由はない。
import { stepAttitude } from '../../physics/attitude';
import type { KinematicState } from '../../physics/kinematic-state';
import * as C from '../const';
import { attractorsNearInto, classifyAttractors } from './attractors';
import { EntityManager } from './entity-manager';
import { Player } from '../player/player';
import type { GameEntity } from '../game-entity/game-entity';
import { nearestAtmosphereBody, type CelestialBody } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import type { Stage } from '../stages/stage';
import { EntityContactPhysics } from './entity-contact-physics';
import { SurfaceContactPhysics } from './surface-contact-physics';
import { v3 } from '../../physics/vec3';
import { reentryAwareMaxStep, simulationMaxStep, simulationStepDuration } from './time-step';
import type { NanWatchdog } from '../nan-watchdog';
import { FrameSections, SECTION } from '../../frame-sections';
import type { PerfCounts } from '../../perf-meter';

export class Simulator {
  private readonly surfaceContactPhysics = new SurfaceContactPhysics();
  private readonly entityContactPhysics = new EntityContactPhysics();

  simTime: number;
  lastSimDt = 0;
  lastSubsteps = 0;
  lastGravitySourceCount = 0;
  // 今フレームに走った軌道積分(GameEntity.stepActual)の呼び出し回数。
  lastIntegratedSteps = 0;
  // 今フレームに予測列から消費した(積分を省いた)延べ数。
  lastFollowedSteps = 0;
  // エンティティ側の最小イベント時刻の控えと、それを求めたときの顔ぶれの世代。
  private cachedEventTime: number | null = null;
  private cachedEventValid = false;
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
    this.simTime = initialSimTime;
  }

  private readonly nearbyAttractorsScratch: Parameters<typeof attractorsNearInto>[2] = [];

  // dt 分のシミュレーションを進める。simDt をサブステップに分割して積分し、剛体接触(弾命中含む)・姿勢積分を行う。
  // 物体どうしの接触を解決してよいかは呼び出し側が決めて canResolveEntityContacts で渡す
  // (天体との接触は倍率に依らず常に解く)。
  // nanWatchdog は軌道積分・姿勢積分・剛体接触・ベルトの各境界ごとに自機を検査する
  // (checkPlayer は軽量なので substep ごとに呼んでよい)。
  advance(
    dt: number,
    simDt: number,
    player: Player | null,
    activeStage: Stage,
    canResolveEntityContacts: boolean,
    nanWatchdog: NanWatchdog,
  ): void {
    this.lastSubsteps = 0;
    this.lastGravitySourceCount = 0;
    this.lastIntegratedSteps = 0;
    this.lastFollowedSteps = 0;
    const targetTime = this.simTime + simDt;
    while (this.simTime < targetTime - 1e-9) {
      const maxStep = this.adaptiveMaxStep(simDt);
      const eventTime = this.nextEventTime(activeStage);
      const subDt = simulationStepDuration(this.simTime, targetTime, maxStep, eventTime);
      // 浮動小数点の丸めでゼロ刻みになったイベントは現在時刻で消費して前進を保証する。
      if (subDt <= 1e-9) {
        activeStage.applySimulationEvents(this.simTime);
        this.entities.cleanup(
          0, this.simTime, activeStage, player?.state.r ?? v3(), this.atmosphereBodies());
        continue;
      }

      this.sections.enter(SECTION.orbit);
      // 重力源はこのサブステップの中点で1回だけ組み、全エンティティで使い回す。
      const sources = this.ephemeris.gravityAttractorsAt(this.simTime + subDt / 2);
      this.lastGravitySourceCount = sources.length;
      // 遮蔽体はサブステップ開始時刻の窓を使う。遮蔽の幾何はステップ内の天体の移動にほとんど
      // 左右されないので中点で組み直す意味が無く、前のサブステップの終端で組んだ窓と同じ
      // 時刻なのでそのまま使い回せる。
      this.substep(
        subDt, sources, this.surfaceBodies(),
        this.ephemeris.atmosphereCelestialBodiesAt(this.simTime + subDt / 2));
      this.simTime += subDt;
      this.sections.exit(SECTION.orbit);
      this.lastSubsteps++;
      nanWatchdog.checkPlayer('simulator.advance(軌道積分)', player, this.simTime, dt, subDt);
      this.sections.enter(SECTION.attitude);
      this.stepAttitudes(subDt);
      this.sections.exit(SECTION.attitude);
      nanWatchdog.checkPlayer('simulator.advance(姿勢積分)', player, this.simTime, dt, subDt);
      const surfaceBodies = this.surfaceBodies();
      for (const p of this.entities.players) {
        p.stepEnvironment(subDt, this.ephemeris, this.simTime, surfaceBodies);
      }
      // 天体との接触は倍率にも種別にも依らず、物体どうしの接触より先に解く。
      this.sections.enter(SECTION.contact);
      this.surfaceContactPhysics.resolveSurfaceContacts(
        this.entities.all(), surfaceBodies, activeStage);
      this.sections.exit(SECTION.contact);
      nanWatchdog.checkPlayer('simulator.advance(天体接触)', player, this.simTime, dt, subDt);
      if (canResolveEntityContacts) {
        // 放熱板の折りは EntityManager に登録された実体ではなく、艦の姿勢から毎 substep
        // 置き直す接触代理なので、参加者リストへこの場で合流させる。
        this.contactEntitiesScratch.length = 0;
        this.contactEntitiesScratch.push(...this.entities.all());
        for (const p of this.entities.players) {
          if (!p.alive) continue;
          this.contactEntitiesScratch.push(...p.collisionFolds(this.simTime));
        }
        this.sections.enter(SECTION.contact);
        this.entityContactPhysics.resolveEntityContacts(
          this.simTime, this.contactEntitiesScratch, activeStage);
        this.sections.exit(SECTION.contact);
        nanWatchdog.checkPlayer('simulator.advance(接触)', player, this.simTime, dt, subDt);
      }
      activeStage.applySimulationEvents(this.simTime);
      // 期限切れ弾が同じsubstepの接触解決へ進まないよう、既知境界の直後に回収する。
      this.entities.cleanup(
        subDt, this.simTime, activeStage, player?.state.r ?? v3(), this.atmosphereBodies());
    }

    // ベルトは実dtで解く艦にくっついた局所シミュレーションなので、substepループの外で
    // フレームに1回だけ解決する。
    if (canResolveEntityContacts && player) {
      this.sections.enter(SECTION.contact);
      this.entityContactPhysics.resolveBelt(
        dt, this.simTime, player, this.entities.all(), activeStage,
      );
      this.sections.exit(SECTION.contact);
      nanWatchdog.checkPlayer('simulator.advance(ベルト)', player, this.simTime, dt, this.lastSimDt);
    }

    this.lastSimDt = simDt;
  }

  // 生存する艦の高度と、このフレームの時間送り simDt から、今フレームのサブステップ上限 [s]
  // を求める。simDt 由来の下駄は通常時の上限へ掛ける — 返り値へ掛けると再突入中の 1s 上限まで
  // 押し上げてしまい、再突入優先が壊れる。
  private adaptiveMaxStep(simDt: number): number {
    this.adaptiveStatesScratch.length = 0;
    // 加熱・動圧の積分結果が存続を左右し、その帰結をプレイヤーが観測するのは艦だけ。
    // 他の種別は大気圏に入れば失われるだけで、いつどれだけの精度で失われるかはプレイの結果を変えない。
    for (const p of this.entities.players) {
      if (p.alive) this.adaptiveStatesScratch.push(p.state);
    }
    for (const e of this.entities.enemies) {
      if (e.alive) this.adaptiveStatesScratch.push(e.state);
    }
    return reentryAwareMaxStep(
      this.adaptiveStatesScratch,
      this.ephemeris.atmosphereCelestialBodiesAt(this.simTime),
      simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT),
    );
  }

  // ステージと生存エンティティが持つ次イベント時刻のうち最も早いものを返す。無ければ null。
  // ステージ側の時刻は艦の現在の Δv と加速度から毎回決まる生きた値なので毎回引き直す。
  private nextEventTime(activeStage: Stage): number | null {
    const stage = activeStage.nextSimulationEventTime(this.simTime);
    const entity = this.entityEventTime();
    if (stage === null) return entity;
    if (entity === null) return stage;
    return Math.min(stage, entity);
  }

  // 生存エンティティが持つ次イベント時刻のうち最も早いもの。無ければ null。エンティティ側の
  // 締切は固定の絶対時刻なので、保持した時刻を simTime が越えたときと、エンティティの顔ぶれの
  // 世代が変わったときにだけ全走査で引き直す。
  private entityEventTime(): number | null {
    const revision = this.entities.collectionRevision;
    const stale = !this.cachedEventValid
      || this.cachedEventRevision !== revision
      || (this.cachedEventTime !== null && this.cachedEventTime <= this.simTime);
    if (!stale) return this.cachedEventTime;

    let next: number | null = null;
    for (const e of this.entities.all()) {
      if (!e.alive) continue;
      const t = e.nextSimulationEventTime(this.simTime);
      if (t !== null && (next === null || t < next)) next = t;
    }
    this.cachedEventTime = next;
    this.cachedEventValid = true;
    this.cachedEventRevision = revision;
    return next;
  }

  // このサブステップで表面を持つ相手として扱う天体。表面を持つかは重力を及ぼすかとは
  // 無関係なので、登録天体の全数を返す。
  private surfaceBodies(): readonly CelestialBody[] {
    return this.ephemeris.celestialBodiesAt(this.simTime);
  }

  // このサブステップで大気を持つ相手として扱う天体。焼失の判定に表面の窓は要らない。
  private atmosphereBodies(): readonly CelestialBody[] {
    return this.ephemeris.atmosphereCelestialBodiesAt(this.simTime);
  }

  // 全エンティティを、渡された重力源 sources に対して dt だけ積分する。sources・occluders・
  // atmosphereSources は呼び出し側がこのステップで1回だけ組んだものを全エンティティで共有し、
  // 重力源の分類もここで1回だけ行う。遮蔽体は登録天体の全数をそのまま渡す — 太陽を隠せるかは
  // 半径と位置の幾何で決まり、重力を及ぼすかとは無関係なので絞り込まない。
  // 抗力を掛ける大気は個体ごとに最も近い1体を選ぶ。
  // 予測列がこのサブステップ終端の時刻を持っていればそれを先端にして積分を省く — ある時間帯の
  // 状態を決める積分を常にちょうど1本に保つ。
  private substep(
    dt: number,
    sources: readonly CelestialBody[],
    occluders: readonly CelestialBody[],
    atmosphereSources: readonly CelestialBody[],
  ): void {
    const classified = classifyAttractors(sources);
    const t = this.simTime + dt;
    for (const e of this.entities.all()) {
      const near = attractorsNearInto(e.state.r, classified, this.nearbyAttractorsScratch);
      if (e.followPredicted(t, near)) {
        this.lastFollowedSteps++;
        continue;
      }
      e.stepActual(dt, near, occluders, nearestAtmosphereBody(e.state.r, atmosphereSources));
      this.lastIntegratedSteps++;
    }
  }

  // 軌道積分と同じ刻み幅 simDt で、姿勢を持つ生存エンティティの姿勢を進める。
  private stepAttitudes(simDt: number): void {
    for (const e of this.entities.all()) {
      if (!e.alive || !e.hasAttitude) continue;
      e.att = stepAttitude(e.att, e.torque, simDt);
    }
  }

  // 負荷確認ウィンドウが読む、直近フレームの積分規模。
  perfCounts(): Pick<PerfCounts, 'simSubsteps' | 'simIntegrated' | 'simFollowed' | 'gravitySources'> {
    return {
      simSubsteps: this.lastSubsteps,
      simIntegrated: this.lastIntegratedSteps,
      simFollowed: this.lastFollowedSteps,
      gravitySources: this.lastGravitySourceCount,
    };
  }
}
