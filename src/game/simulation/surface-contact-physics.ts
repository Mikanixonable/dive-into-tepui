// 天体の表面との剛体接触。個体1つにつき、区間内で最も早く触れる天体を1体だけ解いて反発を
// 当て、当事者へ collideWith を呼ぶ。天体は状態を書き換えられないので個体ごとに独立に解け、
// 解決の順序も件数の上限も要らない — 物体どうしの接触(entity-contact-physics.ts)とは
// 機構を共有しない。
import * as C from '../const';
import { Attractor, attractorStateAt } from '../../physics/attractor';
import { distributeFixedContact } from '../../physics/collision-response';
import { firstSurfaceContact } from '../../physics/surface-contact';
import { kinematicState } from '../../physics/kinematic-state';
import { add, sameVec, scale } from '../../physics/vec3';
import { GameEntity } from '../game-entity/game-entity';
import type { Stage } from '../stages/stage';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { SurfaceCandidates } from './surface-candidates';

// 位置・速度・半径が有限か。
function isFiniteAttractor(a: Attractor): boolean {
  const { r, v } = a.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(a.radius);
}

export class SurfaceContactPhysics {
  // 解決は Simulator の substep ごとに同期的に完了するため、作業配列を使い回せる。
  private readonly participantScratch: GameEntity[] = [];
  private readonly bodyScratch: Attractor[] = [];
  private readonly candidates = new SurfaceCandidates();
  private readonly nearbyScratch: Attractor[] = [];

  // 1 substep ぶんの天体との接触。時間加速倍率にも collides にも依らず、独立した実体すべてが
  // 参加する。
  resolveSurfaceContacts(
    simTime: number,
    entities: readonly GameEntity[],
    attractors: readonly Attractor[],
    activeStage: Stage,
  ): void {
    this.collectParticipants(entities, this.participantScratch);
    if (this.participantScratch.length === 0) return;
    this.collectAttractors(attractors, this.bodyScratch);
    this.candidates.reset(this.participantScratch, this.bodyScratch);
    for (const e of this.participantScratch) this.resolveOne(e, simTime, activeStage);
  }

  // 個体1つが区間内で最も早く触れる天体を1体だけ解き、反発を当ててから collideWith を呼ぶ。
  private resolveOne(e: GameEntity, simTime: number, activeStage: Stage): void {
    const candidates = this.acceptedCandidates(e, simTime);
    const hit = firstSurfaceContact(e.prevState, e.state, e.radius, candidates);
    if (hit === null) return;

    // 天体の状態は個体の区間終端の時刻へ外挿してから渡す — 天体一式はサブステップの中点で
    // 1回組まれるので、そのままでは区間の終端と別の瞬間の値になる。
    const response = distributeFixedContact(
      { state: e.state, radius: e.radius },
      { state: attractorStateAt(hit.body, e.state.t), radius: hit.body.radius },
      C.CONTACT_RESTITUTION, hit.geometry);

    const before = e.state;
    // 位置も速度も動いていなければ書き戻さない — 書き戻しは予測弧を捨てる。
    if (!sameVec(before.r, response.r) || !sameVec(before.v, response.v)) {
      e.state = kinematicState(before.t, response.r, response.v);
    }
    if (!response.bounced) return;
    e.collideWith(hit.body, {
      t: contactTime(e, response.toi),
      point: add(response.r, scale(response.normal, e.radius)),
      normal: response.normal,
      selfState: before,
      otherState: hit.body.state,
    }, activeStage);
  }

  // 絞り込みを通り、かつ個体自身が接触を受け入れる天体だけ。
  private acceptedCandidates(e: GameEntity, simTime: number): readonly Attractor[] {
    const near = this.candidates.into(e, this.nearbyScratch);
    let w = 0;
    for (const body of near) if (e.contactsWith(body, simTime)) near[w++] = body;
    near.length = w;
    return near;
  }

  // 天体との接触に参加するのは、独立した実体すべて。艦に取り付いた接触代理(ベルトの節点・
  // 放熱板の折り)は艦本体が代表するので参加しない。
  private collectParticipants(source: readonly GameEntity[], out: GameEntity[]): void {
    out.length = 0;
    for (const entity of source) {
      if (entity.alive && entity.attachedTo === null && isFiniteParticipant(entity)) out.push(entity);
    }
  }

  private collectAttractors(source: readonly Attractor[], out: Attractor[]): void {
    out.length = 0;
    for (const attractor of source) {
      if (isFiniteAttractor(attractor)) out.push(attractor);
    }
  }
}
