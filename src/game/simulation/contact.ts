// 剛体球どうしの接触の列挙・解決。collides を立てた GameEntity と、逆質量0(無限質量)の
// 天体を参加者とし、双方へ collideWith を呼ぶ — ダメージ・音・エフェクトはここでは一切扱わない
// (それぞれの GameEntity 自身の責務)。
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, len, scale, sub } from '../../physics/vec3';
import { SpatialGrid } from '../../physics/spatial-grid';
import { GameEntity } from '../game-entity/game-entity';
import type { Player } from '../player/player';
import { resolveSphereCollision } from '../../physics/collision-response';
import type { Attractor } from '../../physics/attractor';
import type { Stage } from '../stages/stage';

// 1回の接触を、受け手から見た形で記述する。self/other は受け手ごとに入れ替えて組み直す
// (normal も向きが反転する)ので、同じ解決結果から自分用と相手用の2つを作る。
export interface Contact {
  readonly t: number; // 接触時刻 [sim s]
  readonly point: Vec3; // 接触点(ECI)
  readonly normal: Vec3; // self → other 向きの単位法線
  readonly selfState: KinematicState; // 接触直前(反応前)の自分
  readonly otherState: KinematicState; // 接触直前(反応前)の相手
  readonly impulse: number; // 剛体解決で生じた力積の大きさ [N·s]。離反中なら 0
}

const RESTITUTION = 0.4;

// 位置・速度・半径・質量がすべて有限で、質量が正であるか。1つでも欠けたエンティティを
// 空間グリッドへ入れる前に落とす — 非有限座標はセル添字自体を壊す。
function isFiniteParticipant(e: GameEntity): boolean {
  const { r, v } = e.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(e.radius) && Number.isFinite(e.mass) && e.mass > 0;
}

function isFiniteAttractor(a: Attractor): boolean {
  const { r, v } = a.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(a.radius);
}

export class ContactPhysics {
  // entities は接触参加エンティティ(EntityManager.all() が一本化して渡す)。attractors は
  // このフレームの重力源一覧を天体側の接触相手として渡す(逆質量0)。player はマガジンベルトを
  // 持つ艦としてだけ別に渡す。
  resolve(
    dt: number,
    simTime: number,
    player: Player,
    entities: GameEntity[],
    attractors: readonly Attractor[],
    activeStage: Stage,
  ): void {
    const p = player;
    const beltActive = p.alive && dt > 1e-6;
    const participants = entities.filter(e => e.alive && e.collides && isFiniteParticipant(e));
    if (beltActive) {
      participants.push(...p.belt.collisionSections(dt, p.state.r, p.state.v, p.att).filter(isFiniteParticipant));
    }
    const bodies = attractors.filter(isFiniteAttractor);
    this.resolveEntityPairs(participants, simTime, activeStage);
    this.resolveAttractorPairs(participants, bodies, simTime, activeStage);
    if (beltActive) {
      p.belt.applyCollisionSections(dt, p.state.r, p.state.v, p.att);
    }
  }

  // 候補ペアを空間グリッドの27近傍列挙で絞り込んでから接触を解決する。
  private resolveEntityPairs(entities: GameEntity[], simTime: number, activeStage: Stage): void {
    const n = entities.length;
    let maxRadius = 0;
    let maxMove = 0;
    for (const e of entities) {
      if (e.radius > maxRadius) maxRadius = e.radius;
      const move = len(sub(e.state.r, e.prevState.r));
      if (move > maxMove) maxMove = move;
    }
    // 重なり判定(半径和)と直前substepの線分TOI判定(移動量)、双方が拾いうる最大距離の
    // 2倍ずつを足した値をセル一辺にする — これ以上離れた27近傍の外のペアは、どちらの
    // 判定式でも接触しえない。
    const cellSize = 2 * (maxRadius + maxMove) || 1;
    const grid = new SpatialGrid<number>(cellSize);
    for (let k = 0; k < n; k++) grid.insert(k, entities[k]!.state.r);

    for (let i = 0; i < n; i++) {
      const a = entities[i]!;
      for (const j of grid.neighbors(a.state.r)) {
        if (j <= i) continue;
        const b = entities[j]!;
        if (!a.contactsWith(b, simTime) || !b.contactsWith(a, simTime)) continue;
        this.resolveEntityPair(a, b, activeStage);
      }
    }
  }

  // 天体は毎フレーム少数(登録全体)なので空間グリッドへは載せず、参加者との総当たりで解決する。
  private resolveAttractorPairs(
    entities: GameEntity[],
    bodies: readonly Attractor[],
    simTime: number,
    activeStage: Stage,
  ): void {
    for (const e of entities) {
      for (const body of bodies) {
        if (!e.contactsWith(body, simTime)) continue;
        this.resolveAttractorPair(e, body, activeStage);
      }
    }
  }

  // 接触していれば a/b の state を補正後の値へ差し替え、反発が起きたときだけ両者へ
  // collideWith を順不同で呼ぶ(接触時点の値は Contact に持たせてあるので、呼び出し順に
  // 結果は依存しない)。
  private resolveEntityPair(a: GameEntity, b: GameEntity, activeStage: Stage): void {
    const pa = a.prevState, pb = b.prevState;
    const sweptValid = pa.t < a.state.t && pb.t < b.state.t
      && Math.abs(pa.t - pb.t) <= 1e-6 && Math.abs(a.state.t - b.state.t) <= 1e-6;
    const response = resolveSphereCollision(
      { r: a.state.r, v: a.state.v, radius: a.radius, invMass: 1 / a.mass },
      { r: b.state.r, v: b.state.v, radius: b.radius, invMass: 1 / b.mass },
      RESTITUTION,
      sweptValid ? pa.r : undefined,
      sweptValid ? pb.r : undefined,
    );
    if (response === null) return;
    const aState = a.state, bState = b.state;
    a.state = kinematicState(aState.t, response.rA, response.vA);
    b.state = kinematicState(bState.t, response.rB, response.vB);
    if (response.impulse === 0) return;

    const point = add(response.rA, scale(response.normal, a.radius));
    a.collideWith(b, {
      t: aState.t, point, normal: response.normal,
      selfState: aState, otherState: bState, impulse: response.impulse,
    }, activeStage);
    b.collideWith(a, {
      t: bState.t, point, normal: scale(response.normal, -1),
      selfState: bState, otherState: aState, impulse: response.impulse,
    }, activeStage);
  }

  // 天体側は逆質量0(無限質量)で解決するので、天体自身は動かず自分側だけが反発する。
  private resolveAttractorPair(e: GameEntity, body: Attractor, activeStage: Stage): void {
    const response = resolveSphereCollision(
      { r: e.state.r, v: e.state.v, radius: e.radius, invMass: 1 / e.mass },
      { r: body.state.r, v: body.state.v, radius: body.radius, invMass: 0 },
      RESTITUTION,
    );
    if (response === null) return;
    const eState = e.state;
    e.state = kinematicState(eState.t, response.rA, response.vA);
    if (response.impulse === 0) return;

    const point = add(response.rA, scale(response.normal, e.radius));
    e.collideWith(body, {
      t: eState.t, point, normal: response.normal,
      selfState: eState, otherState: body.state, impulse: response.impulse,
    }, activeStage);
  }
}
