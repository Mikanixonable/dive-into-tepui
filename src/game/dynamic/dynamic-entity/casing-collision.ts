// 薬莢の表示寸法から組んだ物理形状。描画メッシュを参照せず、姿勢に応じた円柱近似へ変換する。
import { qRotate } from '../../../math/quat';
import { add, v3, type Vec3 } from '../../../math/vec3';
import type { ContactGeometry } from '../../../physics/collision-response';
import {
  cylinderCylinderContact, sweptCylinderCylinderContact, cylinderSphereContact,
  sweptSphereCylinderContact, type Cylinder,
} from '../../../physics/cylinder-contact';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { EntityContactParticipant } from '../dynamic-simulation-participant';

// casing.json の縦方向の外形を、表示側の y 軸補正後の長さへ合わせる [m]。
export const CASING_CYLINDER_HALF_LENGTH = 0.7333333333333334;
export const CASING_CYLINDER_RADIUS = 0.231;
const CASING_LOCAL_CENTER_Y = -0.013333333333333308;
const CASING_LOCAL_AXIS = v3(0, 1, 0);

// 物理形状の中心が Object3D の原点からずれるため、空間グリッドへ渡す外接半径を別に持つ。
export const CASING_COLLISION_BOUND_RADIUS = Math.hypot(
  CASING_CYLINDER_HALF_LENGTH + Math.abs(CASING_LOCAL_CENTER_Y), CASING_CYLINDER_RADIUS,
);

// 姿勢を持つ当事者 self の、状態 state・姿勢 attitude での薬莢の円柱。
function casingCylinder(self: { readonly att: Attitude }, state: KinematicState, attitude = self.att): Cylinder {
  return {
    center: add(state.r, qRotate(attitude.q, v3(0, CASING_LOCAL_CENTER_Y, 0))),
    axis: qRotate(attitude.q, CASING_LOCAL_AXIS),
    halfLength: CASING_CYLINDER_HALF_LENGTH,
    radius: CASING_CYLINDER_RADIUS,
  };
}

// 状態 selfState・姿勢 selfAttitude の薬莢 self と球の接触。触れていなければ null。
export function casingSphereCollision(
  self: EntityContactParticipant, sphereCenter: Vec3,
  sphereRadius: number, selfState: KinematicState, selfAttitude = self.att,
) {
  return cylinderSphereContact(casingCylinder(self, selfState, selfAttitude), sphereCenter, sphereRadius);
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
  // 薬莢は回転を持たない円柱近似なので、掃引中も終端姿勢だけを使う。
  void _previousSelfAttitude;
  return sweptSphereCylinderContact(
    casingCylinder(self, selfState, selfAttitude), previousSphereCenter, sphereCenter, sphereRadius,
  );
}

// 薬莢 self と、相手 other が薬莢のときの円柱どうしの接触。相手が薬莢でないか触れていなければ null。
export function casingEntityCollision(
  self: EntityContactParticipant, other: EntityContactParticipant,
  selfState: KinematicState, otherState: KinematicState,
): ContactGeometry | null {
  if (other.contactKind !== 'casing') return null;
  const hit = cylinderCylinderContact(casingCylinder(self, selfState), casingCylinder(other, otherState));
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
  // 今の歩の円柱どうしを、前の歩の中心から掃引する
  const currentSelf = casingCylinder(self, selfState);
  const currentOther = casingCylinder(other, otherState);
  const previousSelfCenter = casingCylinder(self, previousSelfState).center;
  const previousOtherCenter = casingCylinder(other, previousOtherState).center;
  const swept = sweptCylinderCylinderContact(
    currentSelf, currentOther, previousSelfCenter, previousOtherCenter,
  );
  return swept === null ? null : {
    normal: swept.hit.normal,
    toi: swept.toi,
    pushOut: swept.hit.depth,
    contactPoint: swept.hit.point,
  };
}
