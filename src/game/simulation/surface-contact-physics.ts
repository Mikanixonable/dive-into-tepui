// 天体の表面との剛体接触。個体1つにつき、区間内で最も早く触れる天体を1体だけ解いて反発を
// 当て、当事者へ collideWith を呼ぶ。天体は状態を書き換えられないので個体ごとに独立に解け、
// 解決の順序も件数の上限も要らない — 物体どうしの接触(entity-contact-physics.ts)とは
// 機構を共有しない。
import * as C from '../const';
import { Attractor, attractorStateAt } from '../../physics/attractor';
import { FixedContactResponse, resolveFixedSphereCollision } from '../../physics/collision-response';
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

// 天体の状態は、この個体の区間の両端の時刻へ外挿してから渡す — 天体一式はサブステップの
// 中点で1回組まれるので、そのままでは区間の両端と別の瞬間の値になる。
function computeResponse(e: GameEntity, body: Attractor): FixedContactResponse | null {
  const sweptValid = e.prevState.t < e.state.t;
  return resolveFixedSphereCollision(
    { state: e.state, radius: e.radius },
    { state: attractorStateAt(body, e.state.t), radius: body.radius },
    C.CONTACT_RESTITUTION,
    sweptValid ? e.prevState : undefined,
    sweptValid ? attractorStateAt(body, e.prevState.t) : undefined,
  );
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
    let earliest: FixedContactResponse | null = null;
    let hitBody: Attractor | null = null;
    for (const body of this.candidates.into(e, this.nearbyScratch)) {
      if (!e.contactsWith(body, simTime)) continue;
      const response = computeResponse(e, body);
      if (response === null) continue;
      if (earliest === null || response.toi < earliest.toi) {
        earliest = response;
        hitBody = body;
      }
    }
    if (earliest === null || hitBody === null) return;

    const before = e.state;
    // 位置も速度も動いていなければ書き戻さない — 書き戻しは予測弧を捨てる。
    if (!sameVec(before.r, earliest.r) || !sameVec(before.v, earliest.v)) {
      e.state = kinematicState(before.t, earliest.r, earliest.v);
    }
    if (!earliest.bounced) return;
    e.collideWith(hitBody, {
      t: contactTime(e, earliest.toi),
      point: add(earliest.r, scale(earliest.normal, e.radius)),
      normal: earliest.normal,
      selfState: before,
      otherState: hitBody.state,
    }, activeStage);
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
