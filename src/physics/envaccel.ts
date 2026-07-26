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

// スカラー計算版。大量のオブジェクト生成を避けるための最適化版。
export function envAccelScalar(
  rx: number, ry: number, rz: number,
  vx: number, vy: number, vz: number,
  sunPos: Vec3, moonPos: Vec3, bcInv: number,
  out: { x: number, y: number, z: number }
): void {
  out.x = 0; out.y = 0; out.z = 0;

  // Drag
  if (bcInv > 0) {
    const rMag = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const rho = atmosphericDensity(rMag - R_EARTH);
    if (rho >= 1e-15) {
      const vrx = vx - EARTH_OMEGA * rz;
      const vry = vy;
      const vrz = vz + EARTH_OMEGA * rx;
      const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
      out.x += vrx * k;
      out.y += vry * k;
      out.z += vrz * k;
    }
  }

  // J2
  const r2 = rx * rx + ry * ry + rz * rz;
  const rl = Math.sqrt(r2);
  const k = (-1.5 * 1.08262668e-3 * 3.986004418e14 * 6.378137e6 * 6.378137e6) / (r2 * r2 * rl);
  const f = (5 * ry * ry) / r2;
  out.x += k * rx * (1 - f);
  out.y += k * ry * (3 - f);
  out.z += k * rz * (1 - f);

  // Third Body (Sun)
  const sdx = sunPos.x - rx, sdy = sunPos.y - ry, sdz = sunPos.z - rz;
  const sd3 = Math.pow(sdx * sdx + sdy * sdy + sdz * sdz, 1.5);
  const sb3 = Math.pow(sunPos.x * sunPos.x + sunPos.y * sunPos.y + sunPos.z * sunPos.z, 1.5);
  out.x += (MU_SUN * sdx) / sd3 - (MU_SUN * sunPos.x) / sb3;
  out.y += (MU_SUN * sdy) / sd3 - (MU_SUN * sunPos.y) / sb3;
  out.z += (MU_SUN * sdz) / sd3 - (MU_SUN * sunPos.z) / sb3;

  // Third Body (Moon)
  const mdx = moonPos.x - rx, mdy = moonPos.y - ry, mdz = moonPos.z - rz;
  const md3 = Math.pow(mdx * mdx + mdy * mdy + mdz * mdz, 1.5);
  const mb3 = Math.pow(moonPos.x * moonPos.x + moonPos.y * moonPos.y + moonPos.z * moonPos.z, 1.5);
  out.x += (MU_MOON * mdx) / md3 - (MU_MOON * moonPos.x) / mb3;
  out.y += (MU_MOON * mdy) / md3 - (MU_MOON * moonPos.y) / mb3;
  out.z += (MU_MOON * mdz) / md3 - (MU_MOON * moonPos.z) / mb3;
}
