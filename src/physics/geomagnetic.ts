// 地球磁場の双極子近似と、磁気トルカが出せるトルク。磁場は距離の3乗に反比例して弱まり、
// 月周辺やラグランジュ点では磁気トルカが実質的に働かなくなる。
import { qFromAxisAngle, qRotate } from './attitude';
import { Vec3, cross, lenSq, v3 } from './vec3';
import { ECI_POLE } from './ecliptic';
import { R_EARTH } from './solar-system';

// 双極子軸が自転軸(ECI の Y)から傾いている角度 [rad]。
export const GEOMAGNETIC_TILT = (11.0 * Math.PI) / 180;

// 赤道上・地表における磁束密度 [T]。双極子モーメント 7.94e22 A·m^2 を μ0/4π·m/R^3 に入れた値。
export const GEOMAGNETIC_EQUATOR_FIELD = 3.07e-5;

// 地磁気北極の方向(ECI 単位ベクトル)。自転軸から GEOMAGNETIC_TILT だけ春分点側へ倒した
// 向きに置く。方位を ECI に固定するのは、双極子軸の自転を地表の経度と結びつけずに扱う
// ためであり、軌道1周(90分)の間の磁場の変化は機体の公転が支配的でこの固定に影響されない。
export const GEOMAGNETIC_POLE: Vec3 = qRotate(qFromAxisAngle(v3(0, 0, 1), -GEOMAGNETIC_TILT), ECI_POLE);

// ECI 位置 r における磁束密度ベクトル(ECI [T])。地心では向きが定まらないため v3() を返す。
export function geomagneticField(r: Vec3): Vec3 {
  const d2 = lenSq(r);
  if (d2 <= 0 || !Number.isFinite(d2)) return v3();

  // B = B0 (R/d)^3 [3(m̂·r̂)r̂ − m̂]。双極子モーメント m̂ は地磁気北極と逆を向く。
  const d = Math.sqrt(d2);
  const ux = r.x / d;
  const uy = r.y / d;
  const uz = r.z / d;
  const p = GEOMAGNETIC_POLE;
  const cosLat = ux * p.x + uy * p.y + uz * p.z;
  const scale = GEOMAGNETIC_EQUATOR_FIELD * (R_EARTH / d) ** 3;
  return v3(
    scale * (p.x - 3 * cosLat * ux),
    scale * (p.y - 3 * cosLat * uy),
    scale * (p.z - 3 * cosLat * uz),
  );
}

// 磁気モーメント moment [A·m^2] が磁束密度 field [T] から受けるトルク τ = m × B [N·m]。
// 両者は同じ座標系で与え、返り値もその座標系となる。
export function magneticTorque(moment: Vec3, field: Vec3): Vec3 {
  return cross(moment, field);
}
