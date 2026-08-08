// 天体そのものの向き — 自転軸と、非軸対称な重力場が基準とする主軸座標系の長軸。
// 「天体がどこにいるか」(ephemeris.ts)とは別の問い。THREE/DOM 非依存の純関数。
import { qFromAxisAngle, qRotate } from './attitude';
import { Vec3, addScaled, cross, dot, norm } from './vec3';

// カッシーニ状態にある同期回転衛星の自転軸(単位ベクトル、ECI)。自転軸・軌道面法線・
// 黄道極は同一平面上にあり、自転軸は黄道極を挟んで軌道面法線の反対側で obliquity [rad]
// だけ傾く。軌道面法線が歳差すればこの軸も同じ周期で追従する。
export function cassiniSpinAxis(eclipticPole: Vec3, orbitNormal: Vec3, obliquity: number): Vec3 {
  const tiltAxis = cross(eclipticPole, orbitNormal);
  return norm(qRotate(qFromAxisAngle(norm(tiltAxis), -obliquity), eclipticPole));
}

// 主軸座標系の長軸(単位ベクトル、ECI)。reference を極に直交する成分だけ残して正規化する。
// 非軸対称重力場の C22 項は cos2λ の2回対称性を持つため、向きの符号は結果に影響しない。
export function principalLongAxis(pole: Vec3, reference: Vec3): Vec3 {
  return norm(addScaled(reference, pole, -dot(reference, pole)));
}
