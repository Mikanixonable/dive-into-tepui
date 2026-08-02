// 表示に使う時間依存の座標系（慣性系 ⇄ 太陽回転系・月回転系）で、位置と OrbitState の
// 順・逆変換を供給する。回転系相対の値は branded type（RelativeVec3 / RelativeOrbitState）に
// なり、変換忘れ・二重変換・慣性系との取り違えが型エラーになる（vec3.ts の Vec3 と同手法）。
//
// 各回転系の中身（姿勢と角速度）は天体暦 ephemeris.ts が持ち、ここは Frame 識別子から
// それを引いて変換に落とすだけ。回転軸が時刻とともに向きを変える系（月回転系）もあるため、
// 変換は軸と回転角ではなく (姿勢, 角速度) の対だけを前提に組み立てる。
//
// シミュレーション全体は地球中心の慣性系(ECI)で回っている。回転系はあくまで「軌道線など
// 個々の描画物」の表示用で、シーン全体を差し替えるものではない。
import { OrbitState, orbitState } from './orbital';
import { Ephemeris, FrameRotation } from './ephemeris';
import { add, cross, sub, v3, Vec3 } from './vec3';
import { Quat, qInvert, qRotate } from './attitude';

// 軌道トレースの描画に使う座標系。慣性系(ECI, 無変換)と回転系。座標系を増やすときは
// この配列と frameRotation に足す（Frame 型・isFrame・UI ボタンの検証がすべてここから派生する）。
export const FRAMES = ['inertial', 'sunRotating', 'moonRotating'] as const;
export type Frame = (typeof FRAMES)[number];

// 外部入力（DOM data 属性など）の文字列を Frame へ絞り込む型ガード。
export function isFrame(s: string): s is Frame {
  return (FRAMES as readonly string[]).includes(s);
}

// 慣性系(ECI)/回転系相対の OrbitState。デフォルトの OrbitState とは __frame の有無で非互換
// にし（asInertial 経由でしか慣性系にできない）、取り違えを型で防ぐ（vec3.ts の Vec3 と同手法）。
export type RelativeOrbitState = {
  r: Vec3; // Frame 相対位置 [m]
  v: Vec3; // Frame 相対速度 [m/s]
} & { readonly __tag: 'relativeOrbitState'; };

export type RelativeVec3 = {
  x: number;
  y: number;
  z: number;
} & {readonly __tag: 'relativeVec3'; };

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

// Frame の時刻 t における姿勢と角速度。回転系の中身は天体暦の持ち物なので、ここは
// Frame の識別子から対応する天体暦の回転基準系へ振り分けるだけ。
function frameRotation(frame: Frame, t: number, ephemeris: Ephemeris): FrameRotation {
  switch (frame) {
    case 'inertial':
      return { q: IDENTITY_QUAT, omega: v3() };
    case 'sunRotating':
      return ephemeris.sunOrbitRotationAt(t);
    case 'moonRotating':
      return ephemeris.moonOrbitRotationAt(t);
  }
}

// 慣性系 → Frame 相対（順変換, bake）。時刻 t は変換対象サンプルの絶対時刻。
export function toFramePos(frame: Frame, t: number, pos: Vec3, ephemeris: Ephemeris): RelativeVec3 {
  const { q } = frameRotation(frame, t, ephemeris);
  const r = qRotate(qInvert(q), pos);
  return { x: r.x, y: r.y, z: r.z } as RelativeVec3;
}

// Frame 相対 → 慣性系へ戻す剛体回転（un-bake）をクォータニオンで返す。SampledLine は
// bake 済み頂点（Frame 相対座標）を持つメッシュ全体を、毎フレーム group 回転として
// これで慣性系へ戻す。toInertialPos（位置単位）と同一の回転を剛体メッシュへ一括適用する版。
// THREE 非依存の Quat を返し、描画側が group.quaternion に set する。
export function toInertialQuat(frame: Frame, t: number, ephemeris: Ephemeris): Quat {
  return frameRotation(frame, t, ephemeris).q;
}

// Frame 相対 → 慣性系（逆変換, un-bake）。時刻 t は描画時刻（un-bake なら現在の simTime）。
export function toInertialPos(frame: Frame, t: number, pos: RelativeVec3, ephemeris: Ephemeris): Vec3 {
  const { q } = frameRotation(frame, t, ephemeris);
  return qRotate(q, v3(pos.x, pos.y, pos.z));
}

// 慣性系 → Frame 相対（順変換, bake）。変換時刻は state 自身が持つ絶対時刻 s.t。
// 回転系速度は v_rel = R⁻¹(v − ω×r)。
export function toFrameState(frame: Frame, s: OrbitState, ephemeris: Ephemeris): RelativeOrbitState {
  const { q, omega } = frameRotation(frame, s.t, ephemeris);
  const qi = qInvert(q);
  return { r: qRotate(qi, s.r), v: qRotate(qi, sub(s.v, cross(omega, s.r))) } as RelativeOrbitState;
}

// Frame 相対 → 慣性系（逆変換, un-bake）。時刻 t は描画時刻（un-bake なら現在の simTime）で、
// 復元された OrbitState のエポックにもなる（RelativeOrbitState は時刻を持たない — bake 時刻と
// un-bake 時刻は別物なので、どちらを持たせても取り違えを招く）。
// 慣性系速度は v = R·v_rel + ω×r（toFrameState の逆）。
export function toInertialState(frame: Frame, t: number, s: RelativeOrbitState, ephemeris: Ephemeris): OrbitState {
  const { q, omega } = frameRotation(frame, t, ephemeris);
  const r = qRotate(q, s.r);
  return orbitState(t, r, add(qRotate(q, s.v), cross(omega, r)));
}
