// 環境加速度の合成: 大気抵抗(bcInv = 0 で省略) + J2(地球扁平) + 月・太陽の
// 第三体(潮汐)摂動。ゲーム本体(orbit-entity/simulator.ts)と軌道計画の数値予測
// (physics/predict.ts)が同じ力の列挙を共有するための唯一の定義箇所。
// THREE/DOM 非依存の純関数。
import { R_EARTH, SIDEREAL_DAY, j2Accel, thirdBodyAccel } from './orbital';
import { MU_MOON, MU_SUN } from './ephemeris';
import { atmosphericDensity } from './atmosphere';
import { Vec3, add, len, v3 } from './vec3';

export const EARTH_OMEGA = (2 * Math.PI) / SIDEREAL_DAY; // 地球自転角速度 [rad/s](Y軸=北極まわり)

// 地球と共回転する大気に対する対気速度: v - ω×r, ω = (0, ω, 0)
export function airspeed(r: Vec3, v: Vec3): Vec3 {
  return v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
}

// 大気抵抗の加速度。bcInv は弾道係数の逆数 Cd·A/m(0 なら抵抗なし = ゼロベクトル)。
function dragAccel(r: Vec3, v: Vec3, bcInv: number): Vec3 {
  const rho = bcInv > 0 ? atmosphericDensity(len(r) - R_EARTH) : 0;
  if (rho < 1e-15) return v3();
  const { x: vrx, y: vry, z: vrz } = airspeed(r, v);
  const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
  return v3(vrx * k, vry * k, vrz * k);
}

// 大気抵抗 + J2 + 太陽・月の第三体摂動の合成。
export function envAccel(r: Vec3, v: Vec3, sunPos: Vec3, moonPos: Vec3, bcInv: number): Vec3 {
  const drag = dragAccel(r, v, bcInv);
  const j2 = j2Accel(r);
  const sun = thirdBodyAccel(r, sunPos, MU_SUN);
  const moon = thirdBodyAccel(r, moonPos, MU_MOON);
  return add(add(add(drag, j2), sun), moon);
}
