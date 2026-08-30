// 実シミュレーションの更新。simTime/lastSimDt を保持し、サブステップの区切りと、その区間の
// 天体窓を決める。個体1つを1区間進めること自体は DynamicEntity.stepSimulation の責務で、ここは
// 「いつ区切るか」「その瞬間に何があるか」「誰と誰が相互作用するか」だけを持つ。
//
// 予測(game/dynamic/predictor.ts の Predictor)との役割の違いは2点で、二重性はこの2点に
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
import { DynamicSystem } from './dynamic-system';
import { Player } from '../player/player';
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { CelestialBody, CelestialBodyWindows } from '../../physics/celestial-body';
import type { Stage } from '../stages/stage';
import { EntityContactPhysics } from './entity-contact-physics';
import { SurfaceContactPhysics } from './surface-contact-physics';
import { SubstepCelestialBodies } from './substep-celestial-bodies';
import { NextEventTime } from './next-event-time';
import { v3 } from '../../math/vec3';
import { simulationMaxStep, simulationStepDuration } from './time-step';
import type { NanWatchdog } from './nan-watchdog';
import { FrameSections, SECTION } from '../../frame-sections';
import type { PerfCounts } from '../../perf-meter';

// ゼロ長サブステップ(丸めで刻みが0になったイベント消費)が連続してこの回数を超えたら
// Simulator.advance が simTime を強制前進させる。イベント予告と実際の消滅判定が
// 丸め誤差でずれた個体が残ると刻みが0のまま進まなくなるための保険で、正常時は1回で
// 収まる(同時刻の複数イベントの消費に数回使う程度)。
const SIMULATION_STALL_MAX_ZERO_STEPS = 8;

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
  // ゼロ長サブステップが連続した回数。simTime が実際に進んだら 0 へ戻す。
  private consecutiveZeroSteps = 0;
  private readonly contactEntitiesScratch: DynamicEntity[] = [];
  // このサブステップを1歩で渡った個体。区間が揃っているので、天体接触をまとめて解ける。
  private readonly sharedIntervalScratch: DynamicEntity[] = [];
  // このサブステップの天体窓。
  private readonly bodies = new SubstepCelestialBodies();

  // entities/windows/sections は参照として保持する。initialSimTime はシミュレーションの開始時刻。
  constructor(
    private readonly entities: DynamicSystem,
    private readonly windows: CelestialBodyWindows,
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
    while (this.simTime < targetTime) {
      const maxStep = simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
      const eventTime = this.nextEventTime.at(this.simTime, activeStage, this.entities);
      const subDt = simulationStepDuration(this.simTime, targetTime, maxStep, eventTime);
      // 丸めで前進しない刻みになったイベントは現在時刻で消費して前進を保証する。**絶対秒の
      // しきい値では判定しない** — simTime の分解能は |simTime|·2⁻⁵² なので、固定の ε は
      // 元期の選び方しだいで意味を失う(CODING-RULE 1.9)。足しても進まないことを直接見る。
      if (this.simTime + subDt <= this.simTime) {
        this.consecutiveZeroSteps++;
        // eventTime は simTime 以上のはずだが、丸めで両者の差が 1 ULP 未満に潰れると
        // subDt が 0 になり simTime が動かない。その場合は eventTime へ直接そろえて
        // 差を1回で消費する — 据え置くと次回も同じ差のまま同じ個体を何度も問い直し続ける。
        if (eventTime !== null && eventTime > this.simTime) this.simTime = eventTime;
        // それでも進まない(eventTime が無い、または既に追い越されている)個体が残ると
        // ゼロ刻みが終わらない。このフレームぶんを一括で消費して打ち切り、無音のフリーズ
        // ではなく検知できる形にする。**微小量を足して逃げない** — |simTime| が大きい構成では
        // ULP 未満の加算が no-op になり、砦そのものが効かなくなる。
        if (this.consecutiveZeroSteps > SIMULATION_STALL_MAX_ZERO_STEPS) {
          console.error(
            `[Simulator] ゼロ刻みが${this.consecutiveZeroSteps}回連続。simTime=${this.simTime} `
            + `eventTime=${eventTime} entities=${this.entities.all().length} — このフレームぶんを一括消費`);
          this.simTime = targetTime;
          this.consecutiveZeroSteps = 0;
        }
        activeStage.applySimulationEvents(this.simTime);
        this.entities.cleanup(
          0, this.simTime, activeStage, player?.state.r ?? v3(), this.atmosphereBodies());
        continue;
      }
      this.consecutiveZeroSteps = 0;

      this.sections.enter(SECTION.orbit);
      // 天体の窓も、表面へ触れうる相手の絞り込みも、このサブステップで1組だけ組んで全個体で
      // 使い回す。内側で細分する個体の各歩も同じ組で足りる。
      this.bodies.reset(this.windows, this.simTime, subDt);
      this.lastGravitySourceCount = this.bodies.gravitySourceCount;
      // このサブステップの終端は絶対時刻で1つだけ決め、全個体もこの値へ着地させる
      // (substep)。刻み幅を各自で積ませると、細分した個体の先端時刻が丸め誤差ぶん
      // simTime から外れ、履歴を持たない種別(弾・薬莢)が表示時刻と一致しなくなる。
      const endTime = this.simTime + subDt;
      this.surfaceContactPhysics.beginSubstep(this.bodies.surface, this.simTime, endTime);
      this.substep(endTime, subDt, activeStage);
      this.simTime = endTime;
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
        // 放熱板の折りは DynamicSystem に登録された実体ではなく、艦の姿勢から毎 substep
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
    return this.windows.atmosphereCelestialBodiesAt(this.simTime);
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
  //
  // **最後の1歩は endTime までの残りを刻み幅に採る。** 刻み幅を足し込むと、細分した個体の
  // 先端時刻が dt/divisions の丸めぶん endTime から外れる。履歴を持たない種別(弾・薬莢)は
  // 先端1件しか残さないので、そのずれがそのまま「表示時刻の状態を答えられない」= 非表示に
  // なる。残りを引く形なら、近い2つの差は誤差なく求まるので必ず endTime へ着地する。
  private substep(endTime: number, dt: number, activeStage: Stage): void {
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
          i === divisions - 1 ? endTime - e.state.t : step,
          near, this.bodies.surface, atmosphereBody, this.bodies.star, activeStage);
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
