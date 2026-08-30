// 天体の表面との剛体接触。個体1つにつき、区間内で最も早く触れる天体を1体だけ解いて反発を
// 当て、当事者へ collideWithCelestialBody を呼ぶ。天体は状態を書き換えられないので個体ごとに
// 独立に解け、解決の順序も件数の上限も要らない — 物体どうしの接触
// (entity-contact-physics.ts)とは機構を共有しない。
import * as C from '../const';
import { CelestialBody, celestialBodyStateAt } from '../../physics/celestial-body';
import { distributeFixedContact } from '../../physics/collision-response';
import { firstSurfaceContact } from '../../physics/surface-contact';
import { kinematicState } from '../../physics/kinematic-state';
import { add, sameVec, scale } from '../../math/vec3';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { Stage } from '../stages/stage';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { SurfaceCandidates } from './surface-candidates';

// 天体との接触に参加するのは、独立した実体すべて。艦に取り付いた接触代理(ベルトの節点・
// 放熱板の折り)は艦本体が代表するので参加しない。
function isParticipant(e: DynamicEntity): boolean {
  return e.alive && e.attachedTo === null && isFiniteParticipant(e);
}

// 位置・速度・半径が有限か。
function isFiniteCelestialBody(a: CelestialBody): boolean {
  const { r, v } = a.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(a.radius);
}

export class SurfaceContactPhysics {
  // 解決は区間ごとに同期的に完了するので、作業配列を使い回せる。
  private readonly participantScratch: DynamicEntity[] = [];
  private readonly bodyScratch: CelestialBody[] = [];
  private readonly candidates = new SurfaceCandidates();
  private readonly nearbyScratch: CelestialBody[] = [];

  // 区間 [tStart, tEnd] で触れうる天体の下ごしらえ。判定できる天体を選び、各天体の表面が
  // その区間のあいだに届きうる範囲を求める。どちらも参加者に依らないので、区間を内側でさらに
  // 割って解く個体もこの1組で足りる。
  beginSubstep(
    celestialBodies: readonly CelestialBody[], tStart: number, tEnd: number,
  ): void {
    this.collectCelestialBodies(celestialBodies, this.bodyScratch);
    this.candidates.resetSpan(this.bodyScratch, tStart, tEnd);
  }

  // 個体1つの天体との接触。区間は beginSubstep へ渡した区間の内側であればよい。
  resolveOne(e: DynamicEntity, activeStage: Stage): void {
    if (!isParticipant(e)) return;
    this.resolveAgainstCandidates(e, activeStage);
  }

  // 区間を共有する個体をまとめて解く。顔ぶれで先に絞り込むぶん1体あたりが安くなるので、
  // **同じ区間を1歩で渡った個体をここへまとめる。** 絞り込みは次の beginSubstep まで残る。
  resolveShared(entities: readonly DynamicEntity[], activeStage: Stage): void {
    this.collectParticipants(entities, this.participantScratch);
    if (this.participantScratch.length === 0) return;
    this.candidates.narrow(this.participantScratch);
    for (const e of this.participantScratch) this.resolveAgainstCandidates(e, activeStage);
  }

  // 個体1つが区間内で最も早く触れる天体を1体だけ解き、反発を当ててから
  // collideWithCelestialBody を呼ぶ。
  private resolveAgainstCandidates(e: DynamicEntity, activeStage: Stage): void {
    const candidates = this.candidates.into(e, this.nearbyScratch);
    const hit = firstSurfaceContact(e.prevState, e.state, e.radius, candidates);
    if (hit === null) return;

    // 天体の状態は個体の区間終端の時刻へ外挿してから渡す — 天体一式は区間の開始時刻で1回
    // 組まれるので、そのままでは区間の終端と別の瞬間の値になる。
    const response = distributeFixedContact(
      { state: e.state, radius: e.radius },
      { state: celestialBodyStateAt(hit.body, e.state.t), radius: hit.body.radius },
      C.CONTACT_RESTITUTION, hit.geometry);

    const before = e.state;
    // 位置も速度も動いていなければ書き戻さない — 書き戻しは予測弧を捨てる。
    if (!sameVec(before.r, response.r) || !sameVec(before.v, response.v)) {
      e.state = kinematicState<'eci'>(before.t, response.r, response.v);
    }
    if (!response.bounced) return;
    // 反発で失われた力学エネルギーは熱になる。当事者の判断ではなく物理なので、失われるかどうか
    // を委ねる前にここで当てる。
    e.absorbHeat(response.specificEnergyLoss);
    e.collideWithCelestialBody(hit.body, {
      t: contactTime(e, response.toi),
      point: add(response.r, scale(response.normal, e.radius)),
      normal: response.normal,
      selfState: before,
      otherState: hit.body.state,
    }, activeStage);
  }

  // 参加者だけを out へ写す。out は呼び出し側が所有する。
  private collectParticipants(source: readonly DynamicEntity[], out: DynamicEntity[]): void {
    out.length = 0;
    for (const entity of source) if (isParticipant(entity)) out.push(entity);
  }

  // 判定できる天体だけを out へ写す。out は呼び出し側が所有する。
  private collectCelestialBodies(source: readonly CelestialBody[], out: CelestialBody[]): void {
    out.length = 0;
    for (const celestialBody of source) {
      if (isFiniteCelestialBody(celestialBody)) out.push(celestialBody);
    }
  }
}
