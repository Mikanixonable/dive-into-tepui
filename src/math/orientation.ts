// 向き(Quat)を、極軸まわりの方位角・仰角・ロールへ分解し、また組み直す。極軸の選び方
// (自転軸・軌道面法線・黄道面法線など)は呼び出し側が決めるので、この分解の意味は
// 「その軸を天頂としたときに、どちらをどれだけ向いているか」になる。
//
// 回転が写す局所基底は LOCAL_FORWARD(+Z)・LOCAL_UP(+Y)・LOCAL_RIGHT(+X) の3本で、
// yaw/pitch が決めるのは LOCAL_FORWARD の向き、roll がその軸まわりの傾き。
import { Vec3, addScaled, cross, dot, lenSq, norm, projectOntoPlane, scale, v3 } from './vec3';
import { Quat, qFromAxisAngle, qFromForwardUp, qMul, qNormalize, qRotate } from './quat';

export const LOCAL_FORWARD = v3(0, 0, 1);
export const LOCAL_UP = v3(0, 1, 0);
export const LOCAL_RIGHT = v3(1, 0, 0);

// 真上・真下では方位が定まらないので、仰角をここまでに抑える。
export const POLAR_PITCH_LIMIT = Math.PI / 2 - 1e-3;

export interface PolarEuler {
  yaw: number;
  pitch: number;
  roll: number;
}

// 極軸を天頂としたときの、方位角0の向き(reference)と方位角+90°の向き(east)。
// 極軸が LOCAL_RIGHT と平行なときだけ LOCAL_FORWARD を種にする。
function polarBasis(polar: Vec3): { reference: Vec3; east: Vec3 } {
  let reference = projectOntoPlane(LOCAL_RIGHT, polar);
  if (lenSq(reference) < 1e-8) reference = projectOntoPlane(LOCAL_FORWARD, polar);
  reference = norm(reference);
  return { reference, east: norm(cross(reference, polar)) };
}

// offset を LOCAL_FORWARD、up を LOCAL_UP へ写す回転。組めない入力(平行・零ベクトル)には
// 単位回転を返す。
export function rotationFromBasis(offset: Vec3, up: Vec3): Quat {
  return qFromForwardUp(norm(offset), norm(up)) ?? { x: 0, y: 0, z: 0, w: 1 };
}

// 極軸を天頂とする方位・仰角・ロールへ分解する。仰角は POLAR_PITCH_LIMIT で抑える。
export function eulerFromRotation(rotation: Quat, polar: Vec3): PolarEuler {
  const offset = qRotate(rotation, LOCAL_FORWARD);
  const basis = polarBasis(polar);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dot(offset, polar))));
  const horizontal = projectOntoPlane(offset, polar);
  const yaw = Math.atan2(dot(horizontal, basis.east), dot(horizontal, basis.reference));
  const up = qRotate(rotation, LOCAL_UP);
  let referenceUp = projectOntoPlane(polar, offset);
  if (lenSq(referenceUp) < 1e-8) referenceUp = projectOntoPlane(basis.reference, offset);
  referenceUp = norm(referenceUp);
  const roll = Math.atan2(dot(offset, cross(referenceUp, up)), dot(referenceUp, up));
  return { yaw, pitch: Math.max(-POLAR_PITCH_LIMIT, Math.min(POLAR_PITCH_LIMIT, pitch)), roll };
}

// eulerFromRotation の逆。仰角は同じ範囲へ抑えてから組む。
export function rotationFromEuler(euler: PolarEuler, polar: Vec3): Quat {
  const pitch = Math.max(-POLAR_PITCH_LIMIT, Math.min(POLAR_PITCH_LIMIT, euler.pitch));
  const basis = polarBasis(polar);
  const cp = Math.cos(pitch);
  const offset = addScaled(
    addScaled(scale(basis.reference, cp * Math.cos(euler.yaw)), basis.east, cp * Math.sin(euler.yaw)),
    polar,
    Math.sin(pitch),
  );
  let referenceUp = projectOntoPlane(polar, offset);
  if (lenSq(referenceUp) < 1e-8) referenceUp = projectOntoPlane(basis.reference, offset);
  return qNormalize(qMul(qFromAxisAngle(offset, euler.roll), rotationFromBasis(offset, norm(referenceUp))));
}

// 方位角 yaw・仰角 pitch・距離 dist の球面座標を、+Y を天頂とする直交座標へ直す。
export function sphericalOffset(yaw: number, pitch: number, dist: number): Vec3 {
  const cp = Math.cos(pitch);
  return scale(v3(cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)), dist);
}

