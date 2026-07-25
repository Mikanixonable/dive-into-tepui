// 回転を含む時間依存の座標系（慣性系 ⇄ 太陽回転系など）で、OrbitState(位置と速度)の
// 順・逆変換を供給する。軌道トレースの描画(SampledLine)がこのモジュールを通して座標変換する。
// クリック判定(ピッキング)は軌跡モジュール側が内部でこの変換を使って提供するので、plan-editor は
// このモジュールを直接参照しない（描画とクリック判定の基準が同じ変換に揃う）。カメラを回転系へ
// 固定する場合はカメラも同じ変換でカメラ座標を得るが、それは軌道計算とは独立に「たまたま同じ
// モジュールを参照する」だけ。FloatingOrigin と同型の座標系インフラで、慣性系(ECI)と回転系相対を
// branded type で型区別する（デフォルトの
// OrbitState は InertialOrbitState として通らず、asInertial での明示変換を必須にする。
// これで変換忘れ・二重変換・慣性系/相対系の取り違えを型で禁止する。vec3.ts の Vec3 と同手法）。
//
// シミュレーション全体は地球中心の慣性系(ECI)で回っている（envaccel.ts の第三体は差分潮汐、
// フレームは非回転）。回転系はあくまで「予測軌道など個々の描画物」の表示用で、シーン全体を
// 差し替えるものではない。
//
// 各 Frame は自分の (回転軸, 回転角, 角速度) を持つ。回転軸は Frame ごとに異なりうる
// （太陽回転系は極 Y 軸。将来の 'moonRotating' 等は白道法線など別軸になりうる）ので、
// 共通の軸を前提にせず frameAxis で Frame ごとに与える。
import { OrbitState, orbitState } from './orbital';
import { Ephemeris } from './ephemeris';
import { add, cross, rotateAxis, scale, sub, v3, Vec3 } from './vec3';
import { SUN_ROTATING_POLE } from './ephemeris';
import { Quat, qFromAxisAngle } from './attitude';

// 軌道トレースの描画に使う座標系。慣性系(ECI, 無変換)と回転系。将来 'moonRotating' 等は
// この配列に足すだけでよい（Frame 型・isFrame・UI ボタンの検証がすべてここから派生する）。
// 旧来の boolean（慣性=false / 太陽回転=true）を拡張に備えて列挙にしたもの。
export const FRAMES = ['inertial', 'sunRotating'] as const;
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

// 慣性系 → Frame 相対（順変換, bake）。時刻 t は変換対象サンプルの絶対時刻。
// 回転系速度は v_rel = R(−θ)v − ω×r_rel（ω = frameRate·frameAxis）。
export function toFramePos(frame: Frame, t: number, pos: Vec3, ephemeris: Ephemeris): RelativeVec3 {
  switch (frame) {
    case 'inertial':
      return { x: pos.x, y: pos.y, z: pos.z } as RelativeVec3;
    case 'sunRotating':
      const a = ephemeris.sunAzimuthAt(t);
      const r = rotateAxis(pos, SUN_ROTATING_POLE, -a);
      return { x: r.x, y: r.y, z: r.z } as RelativeVec3;
  }
}

// Frame 相対 → 慣性系へ戻す剛体回転（un-bake）をクォータニオンで返す。SampledLine は
// bake 済み頂点（Frame 相対座標）を持つメッシュ全体を、毎フレーム group 回転として
// これで慣性系へ戻す。回転軸は Frame ごとに異なりうる（太陽回転系は極 Y、将来の月回転系は
// 白道法線など）ため group.rotation.y のような特定軸決め打ちにはできず、frameAxis まわりの
// 回転を Quat で供給する。toInertialPos（位置単位）と同一の回転を剛体メッシュへ一括適用する版。
// THREE 非依存の Quat を返し、描画側が group.quaternion に set する。
export function toInertialQuat(frame: Frame, t: number, ephemeris: Ephemeris): Quat {
  switch (frame) {
    case 'inertial':
      return { x: 0, y: 0, z: 0, w: 1 };
    case 'sunRotating':
      return qFromAxisAngle(SUN_ROTATING_POLE, ephemeris.sunAzimuthAt(t));
  }
}

// Frame 相対 → 慣性系（逆変換, un-bake）。時刻 t は描画時刻（un-bake なら現在の simTime）。
// 慣性系速度は v = R(+θ)v_rel + ω×r（toFrame の逆）。
export function toInertialPos(frame: Frame, t: number, pos: RelativeVec3, ephemeris: Ephemeris): Vec3 {
  switch (frame) {
    case 'inertial':
      return v3(pos.x, pos.y, pos.z);
    case 'sunRotating':
      const a = ephemeris.sunAzimuthAt(t);
      const r = rotateAxis(v3(pos.x, pos.y, pos.z), SUN_ROTATING_POLE, a);
      return v3(r.x, r.y, r.z);
  }
}

// 慣性系 → Frame 相対（順変換, bake）。変換時刻は state 自身が持つ絶対時刻 s.t。
// 回転系速度は v_rel = R(−θ)v − ω×r_rel（ω = frameRate·frameAxis）。
export function toFrameState(frame: Frame, s: OrbitState, ephemeris: Ephemeris): RelativeOrbitState {
  switch (frame) {
    case 'inertial':
      return { r: s.r, v: s.v } as RelativeOrbitState;
    case 'sunRotating':
      const a = ephemeris.sunAzimuthAt(s.t);
      const omega = scale(SUN_ROTATING_POLE, ephemeris.sunAngularRateAt(s.t));
      const r = rotateAxis(s.r, SUN_ROTATING_POLE, -a);
      const v = sub(rotateAxis(s.v, SUN_ROTATING_POLE, -a), cross(omega, r));
      return { r, v } as RelativeOrbitState;
  }
}

// Frame 相対 → 慣性系（逆変換, un-bake）。時刻 t は描画時刻（un-bake なら現在の simTime）で、
// 復元された OrbitState のエポックにもなる（RelativeOrbitState は時刻を持たない — bake 時刻と
// un-bake 時刻は別物なので、どちらを持たせても取り違えを招く）。
// 慣性系速度は v = R(+θ)v_rel + ω×r（toFrame の逆）。
export function toInertialState(frame: Frame, t: number, s: RelativeOrbitState, ephemeris: Ephemeris): OrbitState {
  switch (frame) {
    case 'inertial':
      return orbitState(t, s.r, s.v);
    case 'sunRotating':
      const a = ephemeris.sunAzimuthAt(t);
      const omega = scale(SUN_ROTATING_POLE, ephemeris.sunAngularRateAt(t));
      const r = rotateAxis(s.r, SUN_ROTATING_POLE, a);
      const v = add(rotateAxis(s.v, SUN_ROTATING_POLE, a), cross(omega, r));
      return orbitState(t, r, v);
  }
}
