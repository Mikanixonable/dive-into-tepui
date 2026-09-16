// 薬莢の表示寸法から組んだ物理形状。描画メッシュを参照せず、姿勢に応じた円柱近似へ変換する。
import { qRotate } from '../../../math/quat';
import { add, v3, type Vec3 } from '../../../math/vec3';
import type { ContactGeometry } from '../../../physics/collision-response';
import {
  cylinderCylinderContact, sweptCylinderCylinderContact, cylinderSphereContact,
  sweptSphereCylinderContact, type Cylinder,
} from '../../../physics/cylinder-contact';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { DynamicMotion } from '../dynamic-motion';

// casing.json の縦方向の外形を、表示側の y 軸補正後の長さへ合わせる [m]。
export const CASING_CYLINDER_HALF_LENGTH = 0.7333333333333334;
export const CASING_CYLINDER_RADIUS = 0.231;
const CASING_LOCAL_CENTER_Y = -0.013333333333333308;
const CASING_LOCAL_AXIS = v3(0, 1, 0);

// 物理形状の中心が Object3D の原点からずれるため、空間グリッドへ渡す外接半径を別に持つ。
export const CASING_COLLISION_BOUND_RADIUS = Math.hypot(
  CASING_CYLINDER_HALF_LENGTH + Math.abs(CASING_LOCAL_CENTER_Y), CASING_CYLINDER_RADIUS,
);

function casingCylinder(self: DynamicMotion, state: KinematicState, attitude = self.att): Cylinder {
  return {
    center: add(state.r, qRotate(attitude.q, v3(0, CASING_LOCAL_CENTER_Y, 0))),
    axis: qRotate(attitude.q, CASING_LOCAL_AXIS),
    halfLength: CASING_CYLINDER_HALF_LENGTH,
    radius: CASING_CYLINDER_RADIUS,
  };
}

export function casingSphereCollision(
  self: DynamicMotion, sphereCenter: Vec3,
  sphereRadius: number, selfState: KinematicState, selfAttitude = self.att,
) {
  return cylinderSphereContact(casingCylinder(self, selfState, selfAttitude), sphereCenter, sphereRadius);
}

export function casingSweptSphereCollision(
  self: DynamicMotion,
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

export function casingEntityCollision(
  self: DynamicMotion, other: DynamicMotion,
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

export function casingSweptEntityCollision(
  self: DynamicMotion, other: DynamicMotion,
  previousSelfState: KinematicState, selfState: KinematicState,
  previousOtherState: KinematicState, otherState: KinematicState,
): ContactGeometry | null {
  if (other.contactKind !== 'casing') return null;
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
