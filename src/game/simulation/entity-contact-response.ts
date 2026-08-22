// 接触ペア1組の反発の計算。当事者2体の現在状態から、押し戻し後の位置・速度と接触の幾何を
// 出す。球でない当たり形状(基地)の吸収もここが引き受けるので、解決器の側は種別を見ない。
import * as C from '../const';
import { KinematicState } from '../../physics/kinematic-state';
import { sub, scale, len } from '../../physics/vec3';
import { GameEntity } from '../game-entity/game-entity';
import { Base } from '../game-entity/base';
import {
  CollisionResponse, ContactGeometry,
  distributeSphereContact, resolveSphereCollision,
} from '../../physics/collision-response';

// 基地の当たり形状は球ではないので、幾何だけを基地自身へ問い、受け持ちの分配は球どうしと
// 共有する。触れていなければ null。
function baseContactGeometry(
  base: Base, other: GameEntity, baseWork: KinematicState, otherWork: KinematicState, baseIsA: boolean,
): ContactGeometry | null {
  if (len(sub(otherWork.r, baseWork.r)) > base.radius + other.radius) return null;
  const hit = base.testSphereCollision(otherWork.r, other.radius);
  if (!hit) return null;
  // hit.normal は基地から相手へ向くので、a → b の向きへ揃える。
  return {
    normal: baseIsA ? hit.normal : scale(hit.normal, -1),
    toi: 1,
    pushOut: hit.depth,
  };
}

// aWork/bWork は解決の途中経過を含む「いまの状態」で、a.state とは限らない。
export function entityContactResponse(
  a: GameEntity, aWork: KinematicState, b: GameEntity, bWork: KinematicState,
): CollisionResponse | null {
  const bodyA = { state: aWork, radius: a.radius, invMass: 1 / a.contactMass };
  const bodyB = { state: bWork, radius: b.radius, invMass: 1 / b.contactMass };
  if (!(bodyA.invMass + bodyB.invMass > 0)) return null;

  const base = a instanceof Base ? a : (b instanceof Base ? b : null);
  if (base) {
    const baseIsA = base === a;
    const geometry = baseContactGeometry(
      base, baseIsA ? b : a, baseIsA ? aWork : bWork, baseIsA ? bWork : aWork, baseIsA);
    return geometry === null
      ? null : distributeSphereContact(bodyA, bodyB, C.CONTACT_RESTITUTION, geometry);
  }

  // 両者の prevState→state が同じ区間(時刻がほぼ一致)を成すときだけ掃引TOIを試す —
  // ずれていれば異なる瞬間の直前位置を結ぶ線分になり、掃引の意味を失う。
  const sweptValid = a.prevState.t < a.state.t && b.prevState.t < b.state.t
    && Math.abs(a.prevState.t - b.prevState.t) <= 1e-6 && Math.abs(a.state.t - b.state.t) <= 1e-6;
  return resolveSphereCollision(
    bodyA, bodyB, C.CONTACT_RESTITUTION,
    sweptValid ? a.prevState : undefined,
    sweptValid ? b.prevState : undefined,
  );
}
