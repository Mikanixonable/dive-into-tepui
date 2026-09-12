// 接触ペア1組の反発の計算。当事者2体の現在状態から、押し戻し後の位置・速度と接触の幾何を出す。
import { KinematicState } from '../../physics/kinematic-state';
import { sub, scale, len, type Vec3 } from '../../math/vec3';
import type { SphereHit } from '../../math/triangle-mesh';
import type { EntityContactParticipant } from './dynamic-simulation-participant';
import {
  CollisionResponse, ContactGeometry,
  distributeSphereContact, resolveSphereCollision,
} from '../../physics/collision-response';

// 剛体接触の反発係数。天体の表面でも物体どうしでも同じ値を使う。
export const CONTACT_RESTITUTION = 0.4;

// タンパク質の球列など、球の外接半径ではなく種別固有の当たり形状を持つ側の狭域判定。
// 接触解決器へ渡す法線は常に a → b に揃える。
function customContactGeometry(
  a: EntityContactParticipant, aWork: KinematicState,
  b: EntityContactParticipant, bWork: KinematicState,
  sweptValid: boolean,
): ContactGeometry | null {
  if (!sweptValid && len(sub(bWork.r, aWork.r)) > a.radius + b.radius) return null;

  const makeSweptGeometry = (
    hit: { readonly hit: SphereHit; readonly toi: number },
    normal: Vec3,
  ): ContactGeometry => ({
    normal,
    toi: hit.toi,
    pushOut: hit.hit.depth,
    contactPoint: hit.hit.point,
  });

  if (sweptValid) {
    const sweptEntityA = a.testCustomSweptEntityCollision(
      b, a.prevState, aWork, b.prevState, bWork,
    );
    if (sweptEntityA !== null) return sweptEntityA;
    const sweptEntityB = b.testCustomSweptEntityCollision(
      a, b.prevState, bWork, a.prevState, aWork,
    );
    if (sweptEntityB !== null) {
      return {
        ...sweptEntityB,
        normal: scale(sweptEntityB.normal, -1),
      };
    }
  }

  const hitA = a.testCustomEntityCollision(b, aWork, bWork);
  if (hitA !== null) return hitA;

  const hitB = b.testCustomEntityCollision(a, bWork, aWork);
  if (hitB !== null) return {
    ...hitB,
    normal: scale(hitB.normal, -1),
  };

  // 両者が固有形状を持つ組は、外接球を使った近似へ戻すと形状の外側で接触する。
  if (a.usesCustomEntityCollision() && b.usesCustomEntityCollision()) return null;

  if (sweptValid) {
    const sweptA = a.testCustomSweptSphereCollision(
      b.prevState.r, bWork.r, b.radius, a.prevState, aWork,
    );
    if (sweptA !== null) return makeSweptGeometry(sweptA, sweptA.hit.normal);

    const sweptB = b.testCustomSweptSphereCollision(
      a.prevState.r, aWork.r, a.radius, b.prevState, bWork,
    );
    if (sweptB !== null) return makeSweptGeometry(sweptB, scale(sweptB.hit.normal, -1));
  }

  const sphereHitA = a.testCustomSphereCollision(bWork.r, b.radius, aWork);
  if (sphereHitA !== null) {
    return { normal: sphereHitA.normal, toi: 1, pushOut: sphereHitA.depth, contactPoint: sphereHitA.point };
  }

  const sphereHitB = b.testCustomSphereCollision(aWork.r, a.radius, bWork);
  if (sphereHitB !== null) {
    return { normal: scale(sphereHitB.normal, -1), toi: 1, pushOut: sphereHitB.depth, contactPoint: sphereHitB.point };
  }
  return null;
}

// aWork/bWork は解決の途中経過を含む「いまの状態」で、a.state とは限らない。
export function entityContactResponse(
  a: EntityContactParticipant, aWork: KinematicState,
  b: EntityContactParticipant, bWork: KinematicState,
): CollisionResponse | null {
  const bodyA = { state: aWork, radius: a.radius, invMass: 1 / a.contactMass };
  const bodyB = { state: bWork, radius: b.radius, invMass: 1 / b.contactMass };
  if (!(bodyA.invMass + bodyB.invMass > 0)) return null;

  const sweptValid = a.prevState.t < a.state.t && b.prevState.t < b.state.t
    // 同一サブステップの個体は同じ endTime へビット一致で着地するので、この 1e-6 は
    // |simTime| が大きい構成では実質 === に締まるだけで、緩む方向には効かない。
    && Math.abs(a.prevState.t - b.prevState.t) <= 1e-6 && Math.abs(a.state.t - b.state.t) <= 1e-6;

  if (a.usesCustomSphereCollision() || b.usesCustomSphereCollision()
    || a.usesCustomEntityCollision() || b.usesCustomEntityCollision()) {
    const custom = customContactGeometry(a, aWork, b, bWork, sweptValid);
    return custom === null
      ? null : distributeSphereContact(bodyA, bodyB, CONTACT_RESTITUTION, custom);
  }

  // 両者の prevState→state が同じ区間(時刻がほぼ一致)を成すときだけ掃引TOIを試す —
  // ずれていれば異なる瞬間の直前位置を結ぶ線分になり、掃引の意味を失う。
  return resolveSphereCollision(
    bodyA, bodyB, CONTACT_RESTITUTION,
    sweptValid ? a.prevState : undefined,
    sweptValid ? b.prevState : undefined,
  );
}
