// 実シミュレーションの更新。simTime/lastSimDt を保持し、サブステップの区切りとその区間の天体窓を
// 決め、個体どうしの接触を解く。予測(Predictor)とは、全個体を同じ瞬間で同時に進めることと、
// 毎フレーム simTime + simDt へ必ず到達することだけが違う。**それ以外 — 個体1つと天体の関係
// (どの天体が引くか・表面へ到達したか・大気で焼失したか・刻みをどこまで広げてよいか)は、両者で
// 同じ答えでなければならない。**
import type {
  DynamicReactionServices, DynamicSimulationParticipant, DynamicSimulationRoster, SimulationControlled,
  SimulationLifecycle,
} from './dynamic-simulation-participant';
import type { EntityRegistry } from './entity-registry';
import type { FrameCelestialBodies } from '../celestial/celestial-bodies';
import type { StageOutcome } from '../stages/stage-outcome';
import type { StageSimulationEvents } from '../stages/stage-simulation-events';
import { EntityContactPhysics } from './entity-contact-physics';
import { engagementZones } from './engagement-zone';
import { SurfaceContactPhysics } from './surface-contact-physics';
import { SubstepCelestialBodies } from './substep-celestial-bodies';
import { NextEventTime } from './next-event-time';
import { v3 } from '../../math/vec3';
import { simulationMaxStep, simulationStepDuration, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT } from './time-step';
import type { NanWatchdog } from './nan-watchdog';
import { FrameSections, SECTION } from '../frame-sections';
import type { PerfCounts } from '../perf-counts';
import type { CelestialBody } from '../../physics/celestial-body';

// ゼロ長サブステップが連続してよい回数。超えたらそのフレームぶんを一括で消費する。丸め誤差で
// 刻みが 0 のまま進まなくなる個体への保険で、正常時は同時刻のイベント消費に数回使う程度。
const SIMULATION_STALL_MAX_ZERO_STEPS = 8;

export class Simulator {
  private readonly surfaceContactPhysics = new SurfaceContactPhysics();
  private readonly entityContactPhysics = new EntityContactPhysics();

  public simTime: number;
  public lastSimDt = 0;
  private lastSubsteps = 0;
  private lastGravitySourceCount = 0;
  // 今フレームに走った軌道積分の延べ数。
  private lastIntegratedSteps = 0;
  // 今フレームに予測列から消費した(積分を省いた)延べ数。
  private lastFollowedSteps = 0;
  private readonly nextEventTime = new NextEventTime();
  // ゼロ長サブステップが連続した回数。simTime が実際に進んだら 0 へ戻す。
  private consecutiveZeroSteps = 0;
  private readonly contactEntitiesScratch: DynamicSimulationParticipant[] = [];
  // このサブステップを1歩で渡った個体。区間が揃っているので、天体接触をまとめて解ける。
  private readonly sharedIntervalScratch: DynamicSimulationParticipant[] = [];
  // このサブステップの天体窓。
  private readonly bodies = new SubstepCelestialBodies();

  // initialSimTime はシミュレーションの開始時刻。
  public constructor(
    private readonly roster: DynamicSimulationRoster,
    private readonly lifecycle: SimulationLifecycle,
    private readonly registry: EntityRegistry,
    private readonly windows: FrameCelestialBodies,
    private readonly sections: FrameSections,
    initialSimTime = 0,
  ) {
    this.simTime = initialSimTime;
  }

  // simDt ぶんシミュレーションを進める。サブステップごとに全個体を進めてから、天体・物体どうしの
  // 接触を解く。物体どうしの接触は canEngage のときに限り、交戦圏の内側で解く。
  public advance(
    dt: number,
    simDt: number,
    controlled: SimulationControlled | null,
    activeStage: StageOutcome & StageSimulationEvents,
    canEngage: boolean,
    nanWatchdog: NanWatchdog,
  ): void {
    this.lastSubsteps = 0;
    this.lastGravitySourceCount = 0;
    this.lastIntegratedSteps = 0;
    this.lastFollowedSteps = 0;
    this.surfaceContactPhysics.candidateBodies = 0;
    this.entityContactPhysics.candidatePairs = 0;
    this.entityContactPhysics.participants = 0;
    const services: DynamicReactionServices = { activeStage, registry: this.registry };
    const targetTime = this.simTime + simDt;
    // 天体の顔ぶれと表面候補の絞り込みはこのフレームで1組だけ組んで全サブステップで使い回す。
    if (this.simTime < targetTime) {
      this.bodies.resetFrame(this.windows, this.simTime, simDt);
      this.lastGravitySourceCount = this.bodies.gravitySourceCount;
      this.surfaceContactPhysics.beginFrame(
        this.bodies.surface, this.bodies.framePivot, this.simTime, targetTime);
    }
    while (this.simTime < targetTime) {
      const maxStep = simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT);
      const eventTime = this.nextEventTime.at(this.simTime, activeStage, this.roster);
      const subDt = simulationStepDuration(this.simTime, targetTime, maxStep, eventTime);
      // 丸めで前進しない刻みのイベントは現在時刻で消費する。判定は固定の ε ではなく「足しても
      // 進まないか」で見る — simTime の分解能は |simTime| に比例する(CODING-RULE 1.9)。
      if (this.simTime + subDt <= this.simTime) {
        this.consecutiveZeroSteps++;
        // eventTime との差が 1 ULP 未満に潰れたら、eventTime へ直接そろえて差を1回で消費する。
        if (eventTime !== null && eventTime > this.simTime) this.simTime = eventTime;
        // それでも進まない個体が残るなら、このフレームぶんを一括で消費して検知できる形で打ち切る。
        // 微小量を足して逃げると、|simTime| が大きいとき ULP 未満の加算が no-op になる。
        if (this.consecutiveZeroSteps > SIMULATION_STALL_MAX_ZERO_STEPS) {
          console.error(
            `[Simulator] ゼロ刻みが${this.consecutiveZeroSteps}回連続。simTime=${this.simTime} `
            + `eventTime=${eventTime} entities=${this.roster.allMotions().length} — このフレームぶんを一括消費`);
          this.simTime = targetTime;
          this.consecutiveZeroSteps = 0;
        }
        activeStage.applySimulationEvents(this.simTime);
        this.lifecycle.cleanup(
          0, this.simTime, activeStage, controlled?.state.r ?? v3(), this.atmosphereBodies());
        continue;
      }
      this.consecutiveZeroSteps = 0;

      this.sections.enter(SECTION.orbit);
      // 天体の位置を厳密に引く時刻は、このサブステップの中点。
      this.bodies.beginSubstep(this.simTime, subDt);
      // 終端は絶対時刻で1つだけ決め、全個体をこの値へ着地させる。
      const endTime = this.simTime + subDt;
      this.surfaceContactPhysics.beginSubstep(this.bodies.pivot);
      this.substep(endTime, subDt, services);
      this.simTime = endTime;
      this.sections.exit(SECTION.orbit);
      this.lastSubsteps++;
      nanWatchdog.checkControlled('simulator.advance(個体の前進)', controlled, this.simTime, dt, subDt);
      // 天体との接触を物体どうしより先に解く。細分した個体は内側で解き終えているので、ここでは
      // 1歩で渡った個体に限る — 二重に解くと反発が二度当たる。
      this.sections.enter(SECTION.celestialContact);
      this.surfaceContactPhysics.resolveShared(this.sharedIntervalScratch, services);
      this.sections.exit(SECTION.celestialContact);
      nanWatchdog.checkControlled('simulator.advance(天体接触)', controlled, this.simTime, dt, subDt);
      // 接触代理は交戦圏があるときに限って組む — 交戦圏の組まれない倍率で組むと、代理が
      // substep 幅そのままの粗い刻みで解かれて発散する。
      const zones = engagementZones(this.roster.allMotions(), canEngage);
      if (zones.length > 0) {
        this.sections.enter(SECTION.entityContact);
        // 接触代理を参加者へ合流させて解き、解決後に本体へ書き戻す。
        this.contactEntitiesScratch.length = 0;
        for (const entity of this.roster.allMotions()) {
          this.contactEntitiesScratch.push(entity);
          if (entity.alive) {
            for (const proxy of entity.contactProxies(this.simTime, subDt)) {
              this.contactEntitiesScratch.push(proxy);
            }
          }
        }
        this.entityContactPhysics.resolveEntityContacts(
          this.simTime, this.contactEntitiesScratch, zones, services);
        for (const entity of this.roster.allMotions()) {
          if (entity.alive) entity.applyContactProxies(subDt);
        }
        this.sections.exit(SECTION.entityContact);
        nanWatchdog.checkControlled('simulator.advance(接触)', controlled, this.simTime, dt, subDt);
      }
      activeStage.applySimulationEvents(this.simTime);
      // 期限切れ弾が同じsubstepの接触解決へ進まないよう、既知境界の直後に回収する。
      this.lifecycle.cleanup(
        subDt, this.simTime, activeStage, controlled?.state.r ?? v3(), this.atmosphereBodies());
    }

    this.lastSimDt = simDt;
  }

  // このサブステップで大気を持つ相手として扱う天体。焼失の判定に表面の窓は要らない。
  private atmosphereBodies(): readonly CelestialBody[] {
    return this.windows.atmosphereMotions;
  }

  // 生存する全個体を dt だけ進め、終端 endTime へ着地させる。濃い大気が細かい刻みを要求する個体は
  // 区間を内側で割り、その1歩ごとに天体表面への到達も解く。1歩で渡った個体は区間が揃っているので、
  // sharedIntervalScratch へ集める。
  private substep(endTime: number, dt: number, services: DynamicReactionServices): void {
    this.sharedIntervalScratch.length = 0;
    for (const e of this.roster.allMotions()) {
      if (!e.alive) continue;
      // 抗力をもう積めない個体は、進める前に失う — 積んでも正確な軌道は得られない。
      if (e.outpacedByDrag(dt, this.bodies.atmosphere, this.bodies.pivot)) {
        e.alive = false;
        continue;
      }
      // 重力源と大気天体の選択は個体ごとに1回 — 顔ぶれはサブステップの中で変わらない。
      const near = this.bodies.attractorsNear(e.state.r);
      const atmosphereBody = this.bodies.atmosphereBodyNear(e.state.r);
      const divisions = e.substepDivisions(dt, this.bodies.atmosphere, this.bodies.pivot);
      const step = dt / divisions;
      for (let i = 0; i < divisions && e.alive; i++) {
        // 最後の1歩は endTime までの残りを刻みに採る — 足し込むと丸めで endTime から外れ、先端1件しか
        // 残さない弾・薬莢が表示時刻の状態を答えられなくなる。
        const integrated = e.stepSimulation(
          i === divisions - 1 ? endTime - e.state.t : step,
          near, this.bodies.surface, atmosphereBody, this.bodies.star,
          this.bodies.pivot, services);
        if (integrated) this.lastIntegratedSteps++;
        else this.lastFollowedSteps++;
        // 細分した個体は各歩で表面到達を解く — 判定を粗いままにすると、加熱の山を踏み外し、
        // 地表を跨いで地面の下を積み続ける。
        if (divisions > 1) {
          // 細分の各歩で解く天体接触も天体接触の値段なので、軌道積分を出てから計る。
          this.sections.switchTo(SECTION.orbit, SECTION.celestialContact);
          this.surfaceContactPhysics.resolveOne(e, services);
          this.sections.switchTo(SECTION.celestialContact, SECTION.orbit);
        }
      }
      if (divisions === 1) this.sharedIntervalScratch.push(e);
    }
  }

  // 直近フレームの積分規模と接触候補の件数。
  public perfCounts(): Pick<PerfCounts,
  'simSubsteps' | 'simIntegrated' | 'simFollowed' | 'gravitySources'
  | 'surfaceCandidates' | 'contactPairs' | 'contactParticipants'> {
    return {
      simSubsteps: this.lastSubsteps,
      simIntegrated: this.lastIntegratedSteps,
      simFollowed: this.lastFollowedSteps,
      gravitySources: this.lastGravitySourceCount,
      surfaceCandidates: this.surfaceContactPhysics.candidateBodies,
      contactPairs: this.entityContactPhysics.candidatePairs,
      contactParticipants: this.entityContactPhysics.participants,
    };
  }
}
