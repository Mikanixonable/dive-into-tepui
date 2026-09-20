// 黄道基準の座標系と ECI(Y=北極)の関係。黄道傾斜角は J2000 相当の固定値を使う近似で、
// 分点歳差(25,772年周期。1000年で赤道の向きが約5.6°動く)は扱わない — ECI の定義そのもの
// (自転軸・J2 対称軸・大気の共回転・天球グリッドが揃って前提とする基準)を動かす設計判断が
// 別途必要なため、この近似の範囲外として扱う。
import { Quat, qFromAxisAngle } from '../math/quat';
import { Vec3, v3 } from '../math/vec3';

export const ECLIPTIC_OBLIQUITY_RAD = (23.439291 * Math.PI) / 180;

const COS_ECLIPTIC_OBLIQUITY = Math.cos(ECLIPTIC_OBLIQUITY_RAD);
const SIN_ECLIPTIC_OBLIQUITY = Math.sin(ECLIPTIC_OBLIQUITY_RAD);

// ECI の極軸(Y)。
export const ECI_POLE: Vec3 = v3(0, 1, 0);

// 標準赤道座標 (X=春分点, Z=北極, 右手系) → ECI (Y=北極)。
// Xstd→X, Zstd→Y, Ystd→-Z(行列式 +1 の回転)。
function stdToEci(xs: number, ys: number, zs: number): Vec3 {
  return v3(xs, zs, -ys);
}

// 赤経・赤緯 [deg] が指す方向の単位ベクトル(ECI)。
export function raDecToEci(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * (Math.PI / 180);
  const dec = decDeg * (Math.PI / 180);
  const cd = Math.cos(dec);
  return stdToEci(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec));
}

// 黄道座標(xe,ye 黄道面内, ze 黄道北極) → 標準赤道座標 → ECI。
export function eclToEci(xe: number, ye: number, ze: number): Vec3 {
  return stdToEci(xe, ye * COS_ECLIPTIC_OBLIQUITY - ze * SIN_ECLIPTIC_OBLIQUITY, ye * SIN_ECLIPTIC_OBLIQUITY + ze * COS_ECLIPTIC_OBLIQUITY);
}

// ECI → 黄道座標(eclToEci の逆変換)。
export function eciToEcl(v: Vec3): Vec3 {
  return v3(v.x, v.y * SIN_ECLIPTIC_OBLIQUITY - v.z * COS_ECLIPTIC_OBLIQUITY, v.y * COS_ECLIPTIC_OBLIQUITY + v.z * SIN_ECLIPTIC_OBLIQUITY);
}

// 黄道座標系の基底軸(成分は黄道座標での値)。
export const ECL_VERNAL = v3(1, 0, 0); // 春分点方向
export const ECL_POLE_ECI = eclToEci(0, 0, 1); // 黄道北極を ECI で表したもの

// Z 上向きの黄道基底(x,y=黄道面内, z=黄道北極)→ ECI。回転基準系の姿勢
// (kepler-orbit.ts の keplerOrbitRotation が組む q)を表すのに使う。
// eclToEci と同一の回転をクォータニオンで表したもの。春分点(X)まわりに黄道傾斜角 − 90° 回すと
// 黄道基底が ECI 基底へ重なる。
export const Q_ECL_TO_ECI: Quat = qFromAxisAngle(ECL_VERNAL, ECLIPTIC_OBLIQUITY_RAD - Math.PI / 2);

// Y 上向きの黄道基底(x=春分点, y=黄道北極, z=…)→ ECI。stateFromOrbitalElements は Y=極 の基底を
// 前提にしているため、黄道基準の軌道要素(kepler-orbit.ts の keplerOrbitState)から
// stateFromOrbitalElements で組んだ状態は、この回転で ECI へ移す。
export const Q_ECLY_TO_ECI: Quat = qFromAxisAngle(v3(1, 0, 0), ECLIPTIC_OBLIQUITY_RAD);
