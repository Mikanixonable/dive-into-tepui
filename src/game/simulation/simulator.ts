// 実シミュレーションの更新。simTime/lastSimDt を保持し、サブステップの区切りと、その区間の
// 天体窓を決める。個体1つを1区間進めること自体は GameEntity.stepSimulation の責務で、ここは
// 「いつ区切るか」「その瞬間に何があるか」「誰と誰が相互作用するか」だけを持つ。
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
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { Player } from '../player/player';
import type { GameEntity } from '../game-entity/game-entity';
import type { CelestialBody } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import type { Stage } from '../stages/stage';
import { EntityContactPhysics } from './entity-contact-physics';
import { SurfaceContactPhysics } from './surface-contact-physics';
import { SubstepBodies } from './substep-bodies';
import { NextEventTime } from './next-event-time';
import { v3 } from '../../physics/vec3';
import { simulationMaxStep, simulationStepDuration } from './time-step';
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
  // 今フレームに走った軌道積分の延べ数。
  lastIntegratedSteps = 0;
  // 今フレームに予測列から消費した(積分を省いた)延べ数。
  lastFollowedSteps = 0;
  private readonly nextEventTime = new NextEventTime();
  private readonly contactEntitiesScratch: GameEntity[] = [];
  // このサブステップを1歩で渡った個体。区間が揃っているので、天体接触をまとめて解ける。
  private readonly sharedIntervalScratch: GameEntity[] = [];
  // このサブステップの天体窓。
  private readonly bodies = new SubstepBodies();

  // entities/ephemeris/sections は参照として保持する。initialSimTime はシミュレーションの開始時刻。
  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly sections: FrameSections,
    initialSimTime = 0,
  ) {
    this.simTime = initialSimTime;
  }

  // dt 分のシミュレーションを進める。simDt をサブステップへ割り、各サブステップで全個体を
  // 進めてから剛体接触(弾命中含む)を解く。
  // 物体どうしの接触を解決してよいかは呼び出し側が決めて canResolveEntityContacts で渡す
  // (天体との接触は倍率に依らず常に解く)。
  // nanWatchdog は個体の前進・天体接触・物体どうしの接触・ベルトの各境界ごとに自機を検査する
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
      const maxStep = simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
      const eventTime = this.nextEventTime.at(this.simTime, activeStage, this.entities);
      const subDt = simulationStepDuration(this.simTime, targetTime, maxStep, eventTime);
      // 浮動小数点の丸めでゼロ刻みになったイベントは現在時刻で消費して前進を保証する。
      if (subDt <= 1e-9) {
        activeStage.applySimulationEvents(this.simTime);
        this.entities.cleanup(
          0, this.simTime, activeStage, player?.state.r ?? v3(), this.atmosphereBodies());
        continue;
      }

      this.sections.enter(SECTION.orbit);
      // 天体の窓も、表面へ触れうる相手の絞り込みも、このサブステップで1組だけ組んで全個体で
      // 使い回す。内側で細分する個体の各歩も同じ組で足りる。
      this.bodies.reset(this.ephemeris, this.simTime, subDt);
      this.lastGravitySourceCount = this.bodies.gravitySourceCount;
      this.surfaceContactPhysics.beginSubstep(
        this.bodies.surface, this.simTime, this.simTime + subDt);
      this.substep(subDt, activeStage);
      this.simTime += subDt;
      this.sections.exit(SECTION.orbit);
      this.lastSubsteps++;
      nanWatchdog.checkPlayer('simulator.advance(個体の前進)', player, this.simTime, dt, subDt);
      // 天体との接触は倍率にも種別にも依らず、物体どうしの接触より先に解く。細分した個体は
      // 内側の刻みで解き終えているので、ここで解くのは1歩で渡った側だけ — 二重に解くと反発が
      // 二度当たる。
      this.sections.enter(SECTION.contact);
      this.surfaceContactPhysics.resolveShared(this.sharedIntervalScratch, activeStage);
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

  // このサブステップで大気を持つ相手として扱う天体。焼失の判定に表面の窓は要らない。
  private atmosphereBodies(): readonly CelestialBody[] {
    return this.ephemeris.atmosphereCelestialBodiesAt(this.simTime);
  }

  // 生存する全個体を dt だけ進める。個体どうしに依存が無いので、順序は結果を変えない
  // (依存があるのは物体どうしの接触だけで、それはサブステップの境界で解く)。
  //
  // 濃い大気が dt より短い刻みを要求する個体は、この区間を内側で割って進む。その1歩ごとに
  // 天体表面への到達も解く — 状態だけを細かく積んで判定を粗いままにすると、加熱の山を踏み外し、
  // 地表への到達を跨いで地面の下を積み続ける。1歩で渡った個体は区間が揃っているので、
  // sharedIntervalScratch へ集めてまとめて解く。
  //
  // 重力源の絞り込みと大気天体の選択は個体ごとに1回。細分の内側では引き直さない — 天体位置は
  // 各段の時刻へ外挿されるし、絞り込みの顔ぶれはサブステップの中で変わらない。
  private substep(dt: number, activeStage: Stage): void {
    this.sharedIntervalScratch.length = 0;
    for (const e of this.entities.all()) {
      if (!e.alive) continue;
      // 抗力をもう積めない個体は、進める前に失う — 積んでも正確な軌道は得られない。
      if (e.outpacedByDrag(dt, this.bodies.atmosphere)) {
        e.alive = false;
        continue;
      }
      const near = this.bodies.attractorsNear(e.state.r);
      const atmosphereBody = this.bodies.atmosphereBodyNear(e.state.r);
      const divisions = e.substepDivisions(dt, this.bodies.atmosphere);
      const step = dt / divisions;
      for (let i = 0; i < divisions && e.alive; i++) {
        const integrated = e.stepSimulation(
          step, near, this.bodies.surface, atmosphereBody, this.ephemeris, activeStage);
        if (integrated) this.lastIntegratedSteps++;
        else this.lastFollowedSteps++;
        if (divisions > 1) this.surfaceContactPhysics.resolveOne(e, activeStage);
      }
      if (divisions === 1) this.sharedIntervalScratch.push(e);
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
