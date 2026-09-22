// 薬莢の表示寸法から組んだカプセル形状と、その接触判定。
import { qRotate } from '../../../math/quat';
import { add, addScaled, dot, lenSq, sub, v3, type Vec3 } from '../../../math/vec3';
import type { ContactGeometry } from '../../../physics/collision-response';
import {
  capsuleCapsuleContact, sweptCapsuleCapsuleContact, capsuleSphereContact,
  sweptSphereCapsuleContact, type Capsule,
} from '../../../physics/capsule-contact';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { EntityContactParticipant } from '../dynamic-simulation-participant';

// casing.json の縦方向の外形を、表示側の y 軸補正後の長さへ合わせる [m]。
export const CASING_CAPSULE_HALF_LENGTH = 0.7333333333333334;
export const CASING_CAPSULE_RADIUS = 0.231;
export const CASING_CYLINDER_HALF_LENGTH = CASING_CAPSULE_HALF_LENGTH;
export const CASING_CYLINDER_RADIUS = CASING_CAPSULE_RADIUS;
const CASING_LOCAL_CENTER_Y = -0.013333333333333308;
const CASING_LOCAL_AXIS = v3(0, 1, 0);

// 原点から見た物理形状の外接半径 [m]。形状の中心が原点からずれるぶんを含む。
export const CASING_COLLISION_BOUND_RADIUS = Math.hypot(
  CASING_CAPSULE_HALF_LENGTH + Math.abs(CASING_LOCAL_CENTER_Y), CASING_CAPSULE_RADIUS,
);

// 薬莢同士の接触で外接球が触れうる最大距離の2乗 [m^2]。
const CASING_PAIR_BOUND_DISTANCE_SQ = (2 * CASING_COLLISION_BOUND_RADIUS) ** 2;

// 姿勢を持つ当事者 self の、状態 state・姿勢 attitude での薬莢のカプセル。
function casingCapsule(self: { readonly att: Attitude }, state: KinematicState, attitude = self.att): Capsule {
  return {
    center: add(state.r, qRotate(attitude.q, v3(0, CASING_LOCAL_CENTER_Y, 0))),
    axis: qRotate(attitude.q, CASING_LOCAL_AXIS),
    halfLength: CASING_CAPSULE_HALF_LENGTH,
    radius: CASING_CAPSULE_RADIUS,
  };
}

// 状態 selfState・姿勢 selfAttitude の薬莢 self と球の接触。触れていなければ null。
export function casingSphereCollision(
  self: EntityContactParticipant, sphereCenter: Vec3,
  sphereRadius: number, selfState: KinematicState, selfAttitude = self.att,
) {
  const d = sub(sphereCenter, selfState.r);
  const maxDist = CASING_COLLISION_BOUND_RADIUS + sphereRadius;
  if (lenSq(d) > maxDist * maxDist) return null;
  return capsuleSphereContact(casingCapsule(self, selfState, selfAttitude), sphereCenter, sphereRadius);
}

// 前の歩から今の歩へ動く球と、薬莢 self の最初の接触と、その時刻の歩内での割合 toi。触れていなければ
// null。
export function casingSweptSphereCollision(
  self: EntityContactParticipant,
  previousSphereCenter: Vec3,
  sphereCenter: Vec3,
  sphereRadius: number,
  _previousSelfState: KinematicState,
  selfState: KinematicState,
  _previousSelfAttitude = self.prevAtt,
  selfAttitude = self.att,
) {
  // 掃引中の回転は近似で無視し、終端姿勢のカプセルを動かす。
  void _previousSelfAttitude;
  return sweptSphereCapsuleContact(
    casingCapsule(self, selfState, selfAttitude), previousSphereCenter, sphereCenter, sphereRadius,
  );
}

// 薬莢 self と、相手 other が薬莢のときのカプセルどうしの接触。相手が薬莢でないか触れていなければ null。
export function casingEntityCollision(
  self: EntityContactParticipant, other: EntityContactParticipant,
  selfState: KinematicState, otherState: KinematicState,
): ContactGeometry | null {
  if (other.contactKind !== 'casing') return null;
  const d = sub(otherState.r, selfState.r);
  if (lenSq(d) > CASING_PAIR_BOUND_DISTANCE_SQ) return null;
  const hit = capsuleCapsuleContact(casingCapsule(self, selfState), casingCapsule(other, otherState));
  return hit === null ? null : {
    normal: hit.normal,
    toi: 1,
    pushOut: hit.depth,
    contactPoint: hit.point,
  };
}

// 前の歩から今の歩へ動く薬莢どうしの最初の接触。相手が薬莢でないか触れていなければ null。
export function casingSweptEntityCollision(
  self: EntityContactParticipant, other: EntityContactParticipant,
  previousSelfState: KinematicState, selfState: KinematicState,
  previousOtherState: KinematicState, otherState: KinematicState,
): ContactGeometry | null {
  if (other.contactKind !== 'casing') return null;

  // 区間内の相対重心間距離の最小値を求め、外接球の和を超える場合はカプセル判定を呼ばず早期棄却する。
  const r0 = sub(previousOtherState.r, previousSelfState.r);
  const r1 = sub(otherState.r, selfState.r);
  const v = sub(r1, r0);
  const vSq = lenSq(v);
  const t = vSq > 1e-12 ? Math.max(0, Math.min(1, -dot(r0, v) / vSq)) : 0;
  const closest = addScaled(r0, v, t);
  if (lenSq(closest) > CASING_PAIR_BOUND_DISTANCE_SQ) return null;

  // 今の歩のカプセルどうしを、前の歩の中心から掃引する
  const currentSelf = casingCapsule(self, selfState);
  const currentOther = casingCapsule(other, otherState);
  const previousSelfCenter = casingCapsule(self, previousSelfState).center;
  const previousOtherCenter = casingCapsule(other, previousOtherState).center;
  const swept = sweptCapsuleCapsuleContact(
    currentSelf, currentOther, previousSelfCenter, previousOtherCenter,
  );
  return swept === null ? null : {
    normal: swept.hit.normal,
    toi: swept.toi,
    pushOut: swept.hit.depth,
    contactPoint: swept.hit.point,
  };
}
