// 接触ペア1組の反発の計算。当事者2体の現在状態から、押し戻し後の位置・速度と接触の幾何を出す。
import type { KinematicState } from '../../physics/kinematic-state';
import { sub, scale, len, type Vec3 } from '../../math/vec3';
import type { SphereHit } from '../../math/triangle-mesh';
import {
  compoundCylinderCompoundContact, compoundCylinderSphereContact,
  sweptCompoundCylinderCompoundContact, sweptCompoundCylinderSphereContact,
  type CompoundCylinderContact, type RigidPose,
} from '../../physics/compound-cylinder-contact';
import type { EntityContactParticipant } from './dynamic-simulation-participant';
import {
  type CollisionResponse, type ContactGeometry,
  distributeSphereContact, resolveSphereCollision,
} from '../../physics/collision-response';

// 剛体接触の反発係数。天体の表面でも物体どうしでも同じ値を使う。
export const CONTACT_RESTITUTION = 0.4;

function reverseContactGeometry(geometry: ContactGeometry): ContactGeometry {
  return {
    ...geometry,
    normal: scale(geometry.normal, -1),
    moduleIdA: geometry.moduleIdB ?? null,
    moduleIdB: geometry.moduleIdA ?? null,
  };
}

// compound shape は DynamicMotion の重心を原点とする。姿勢の履歴は動力学側が提供する
// optional な prevAtt を優先し、古い参加者実装では終端姿勢を始点にも使う。
type AttitudeHistoryParticipant = EntityContactParticipant;

function poseOf(
  entity: AttitudeHistoryParticipant, state: KinematicState, previous: boolean,
): RigidPose {
  const attitude = previous ? entity.prevAtt : entity.att;
  return { position: state.r, rotation: attitude.q };
}

function compoundGeometry(hit: CompoundCylinderContact & { readonly toi?: number }): ContactGeometry {
  return {
    normal: hit.normal,
    toi: hit.toi ?? 1,
    pushOut: hit.depth,
    contactPoint: hit.point,
    moduleIdA: hit.moduleIdA,
    moduleIdB: hit.moduleIdB,
  };
}

function compoundContactGeometry(
  a: AttitudeHistoryParticipant, aWork: KinematicState,
  b: AttitudeHistoryParticipant, bWork: KinematicState,
  sweptValid: boolean,
): ContactGeometry | null {
  const shapeA = a.compoundShape;
  const shapeB = b.compoundShape;
  if (shapeA === null && shapeB === null) return null;

  if (shapeA !== null && shapeB !== null) {
    if (sweptValid) {
      const swept = sweptCompoundCylinderCompoundContact(
        shapeA, poseOf(a, a.prevState, true), poseOf(a, aWork, false),
        shapeB, poseOf(b, b.prevState, true), poseOf(b, bWork, false),
      );
      if (swept !== null) return compoundGeometry(swept);
    }
    const hit = compoundCylinderCompoundContact(
      shapeA, poseOf(a, aWork, false), shapeB, poseOf(b, bWork, false),
    );
    return hit === null ? null : compoundGeometry(hit);
  }

  if (shapeA !== null) {
    if (sweptValid) {
      const swept = sweptCompoundCylinderSphereContact(
        shapeA, poseOf(a, a.prevState, true), poseOf(a, aWork, false),
        b.prevState.r, bWork.r, b.radius,
      );
      if (swept !== null) return compoundGeometry(swept);
    }
    const hit = compoundCylinderSphereContact(shapeA, poseOf(a, aWork, false), bWork.r, b.radius);
    return hit === null ? null : compoundGeometry(hit);
  }

  if (shapeB === null) return null;

  // 判定プリミティブが返す B(compound) → A(sphere) の法線・接触点を、本関数の引数順 A → B へ反転する。
  if (sweptValid) {
    const swept = sweptCompoundCylinderSphereContact(
      shapeB, poseOf(b, b.prevState, true), poseOf(b, bWork, false),
      a.prevState.r, aWork.r, a.radius,
    );
    if (swept !== null) return reverseContactGeometry(compoundGeometry(swept));
  }
  const hit = compoundCylinderSphereContact(shapeB, poseOf(b, bWork, false), aWork.r, a.radius);
  return hit === null ? null : reverseContactGeometry(compoundGeometry(hit));
}

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
      return reverseContactGeometry(sweptEntityB);
    }
  }

  const hitA = a.testCustomEntityCollision(b, aWork, bWork);
  if (hitA !== null) return hitA;

  const hitB = b.testCustomEntityCollision(a, bWork, aWork);
  if (hitB !== null) return reverseContactGeometry(hitB);

  // 両者が固有形状を持つ組は、外接球を使った近似へ戻すと形状の外側で接触する。
  if (a.usesCustomEntityCollision() && b.usesCustomEntityCollision()) return null;

  if (sweptValid) {
    const sweptA = a.testCustomSweptSphereCollision(
      b.prevState.r, bWork.r, b.radius, a.prevState, aWork,
      a.prevAtt, a.att,
    );
    if (sweptA !== null) return makeSweptGeometry(sweptA, sweptA.hit.normal);

    const sweptB = b.testCustomSweptSphereCollision(
      a.prevState.r, aWork.r, a.radius, b.prevState, bWork,
      b.prevAtt, b.att,
    );
    if (sweptB !== null) return reverseContactGeometry(makeSweptGeometry(sweptB, sweptB.hit.normal));
  }

  const sphereHitA = a.testCustomSphereCollision(bWork.r, b.radius, aWork, a.att);
  if (sphereHitA !== null) {
    return { normal: sphereHitA.normal, toi: 1, pushOut: sphereHitA.depth, contactPoint: sphereHitA.point };
  }

  const sphereHitB = b.testCustomSphereCollision(aWork.r, a.radius, bWork, b.att);
  if (sphereHitB !== null) {
    return reverseContactGeometry({ normal: sphereHitB.normal, toi: 1, pushOut: sphereHitB.depth, contactPoint: sphereHitB.point });
  }

  // protein／mesh の既存固有形状を優先し、その次に compound の正確な狭域判定を使う。
  // compound が外れた場合は外接球へ戻さず、形状間の空間を接触にしない。
  const compound = compoundContactGeometry(
    a as AttitudeHistoryParticipant, aWork,
    b as AttitudeHistoryParticipant, bWork,
    sweptValid,
  );
  if (compound !== null || a.compoundShape !== null || b.compoundShape !== null) return compound;
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
    || a.usesCustomEntityCollision() || b.usesCustomEntityCollision()
    || a.compoundShape !== null || b.compoundShape !== null) {
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
