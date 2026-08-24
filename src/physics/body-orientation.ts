// 天体そのものの向き — 自転軸と、その軸まわりの自転位相(本初子午線の向き)。
// 「天体がどこにいるか」(ephemeris.ts)とは別の問い。THREE/DOM 非依存の純関数。
import { Quat, qFromAxisAngle, qFromForwardUp, qRotate } from './attitude';
import { ECI_POLE } from './ecliptic';
import { Vec3, addScaled, cross, dot, len, norm, v3 } from './vec3';

// 自転軸が ECI の極と平行なとき、赤道の交線が定まらない代わりに使う基準方向(春分点)。
const VERNAL: Vec3 = v3(1, 0, 0);

// カッシーニ状態にある同期回転衛星の自転軸(単位ベクトル、ECI)。自転軸・軌道面法線・
// 黄道極は同一平面上にあり、自転軸は黄道極を挟んで軌道面法線の反対側で obliquity [rad]
// だけ傾く。軌道面法線が歳差すればこの軸も同じ周期で追従する。
export function cassiniSpinAxis(eclipticPole: Vec3, orbitNormal: Vec3, obliquity: number): Vec3 {
  const tiltAxis = cross(eclipticPole, orbitNormal);
  return norm(qRotate(qFromAxisAngle(norm(tiltAxis), -obliquity), eclipticPole));
}

// reference を pole に直交する成分だけ残して正規化した単位ベクトル(ECI)。
export function orthogonalizedTo(pole: Vec3, reference: Vec3): Vec3 {
  return norm(addScaled(reference, pole, -dot(reference, pole)));
}

// 自転位相 0 が指す方向(単位ベクトル、ECI)。IAU の自転位相 W と同じく、天体の赤道が
// ECI の赤道に対して持つ昇交点を基準に取る。
export function spinPhaseRef(axis: Vec3): Vec3 {
  const node = cross(ECI_POLE, axis);
  return len(node) < 1e-9 ? orthogonalizedTo(axis, VERNAL) : norm(node);
}

// 本初子午線が meridian の向きを指すときの自転位相 [rad]。meridian は axis に直交していなくてよい。
export function spinPhaseOf(axis: Vec3, meridian: Vec3): number {
  const ref = spinPhaseRef(axis);
  const m = orthogonalizedTo(axis, meridian);
  return Math.atan2(dot(cross(ref, m), axis), dot(ref, m));
}

// 自転位相 spinAngle [rad] のときの本初子午線の向き(単位ベクトル、ECI)。
export function meridianDirection(axis: Vec3, spinAngle: number): Vec3 {
  return norm(qRotate(qFromAxisAngle(axis, spinAngle), spinPhaseRef(axis)));
}

// 自転軸 axis を持つ天体の赤道面を基準面とする座標系(z = 自転軸、x = 自転位相 0 の方向)
// から ECI への回転。軌道要素をこの面の上で測るときの基準面として使う。
export function equatorBasisToEci(axis: Vec3): Quat {
  // 与える up は自転軸に直交するように組むので、qFromForwardUp の退化条件には当たらない。
  return qFromForwardUp(axis, cross(axis, spinPhaseRef(axis)))!;
}

// 自転軸 axis・自転位相 spinAngle の天体に固定した座標系(z = 自転軸、x = 本初子午線の向き)
// から ECI への回転。参照フレームの自転回転系の姿勢に使う。
export function meridianBasisToEci(axis: Vec3, spinAngle: number): Quat {
  // up は自転軸に直交するように組むので、qFromForwardUp の退化条件には当たらない。
  return qFromForwardUp(axis, cross(axis, meridianDirection(axis, spinAngle)))!;
}

// 自転軸と自転位相から組む天体の姿勢。モデル座標の +Y が自転軸、+Z が本初子午線を向く。
export function spinOrientation(axis: Vec3, spinAngle: number): Quat | null {
  return qFromForwardUp(meridianDirection(axis, spinAngle), axis);
}

// 天体固定の緯度 [rad](北極方向が正)・経度 [rad, (-pi, pi]、本初子午線から自転方向へ測る)。
export interface LatLon {
  readonly latRad: number;
  readonly lonRad: number;
}

// position(天体中心相対、ECI)を、自転軸 axis・自転位相 spinAngle の天体表面座標へ変換する。
// 経度は本初子午線(meridianDirection)を 0 とし、自転が進む向き(cross(axis, meridian))を正に取る。
export function latLonOf(position: Vec3, axis: Vec3, spinAngle: number): LatLon {
  const r = norm(position);
  const latRad = Math.asin(Math.max(-1, Math.min(1, dot(r, axis))));
  const meridian = meridianDirection(axis, spinAngle);
  const east = cross(axis, meridian);
  const lonRad = Math.atan2(dot(r, east), dot(r, meridian));
  return { latRad, lonRad };
}
