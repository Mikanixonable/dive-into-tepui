// 向き(Quat)を、極軸まわりの方位角・仰角・ロールへ分解し、また組み直す。極軸の選び方
// (自転軸・軌道面法線・黄道面法線など)は呼び出し側が決めるので、この分解の意味は
// 「その軸を天頂としたときに、どちらをどれだけ向いているか」になる。
// yaw/pitch が決めるのは LOCAL_FORWARD の向き、roll がその軸まわりの傾き。
import { Vec3, addScaled, cross, dot, lenSq, norm, projectOntoPlane, scale, v3 } from './vec3';
import {
  LOCAL_FORWARD, LOCAL_RIGHT, LOCAL_UP, Quat, qFromAxisAngle, qFromBasis, qMul, qNormalize, qRotate,
} from './quat';

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
  return qNormalize(qMul(qFromAxisAngle(offset, euler.roll), qFromBasis(offset, referenceUp)));
}

// 画面ドラッグを積んだ後の方位・仰角を返す(ロールは変えない)。dragX/dragY は画面右・画面下を
// 正とする画面上の変位で、ドラッグした向きへ視線が動くように積む。
//
// 方位を1変えたときの視線の移動量は cos(仰角) 倍しかないので、仰角側を同じだけ縮めて釣り合わせる
// (方位側を伸ばすと真上で発散する)。その縮小を厳密に積分したものが、仰角を asinh(tan) で写した
// 座標 — メルカトル図法の緯度 — の平行移動になる。この座標でなら往路と復路の増分が状態に依らず、
// ドラッグを往復させると元の向きへ厳密に戻る。
export function eulerAfterDrag(euler: PolarEuler, dragX: number, dragY: number): PolarEuler {
  const c = Math.cos(euler.roll);
  const s = Math.sin(euler.roll);
  const merc = Math.asinh(Math.tan(euler.pitch)) + (dragY * c - dragX * s);
  const pitch = Math.atan(Math.sinh(merc));
  return {
    yaw: euler.yaw + (dragX * c + dragY * s),
    pitch: Math.max(-POLAR_PITCH_LIMIT, Math.min(POLAR_PITCH_LIMIT, pitch)),
    roll: euler.roll,
  };
}

// 方位角・仰角が指す向きの、距離 dist の位置ベクトル(+Y を天頂とする球面座標)。
// 位置は視線まわりの傾きに依らないので、roll は結果に効かない。
export function sphericalOffset(euler: PolarEuler, dist: number): Vec3 {
  const cp = Math.cos(euler.pitch);
  return scale(v3(cp * Math.cos(euler.yaw), Math.sin(euler.pitch), cp * Math.sin(euler.yaw)), dist);
}

