// 環境加速度の合成: 大気抵抗(bcInv = 0 で省略) + J2(地球扁平) + 月・太陽の
// 第三体(潮汐)摂動。ゲーム本体(game/environment.ts)と軌道計画の数値予測
// (physics/predict.ts)が同じ力の列挙を共有するための唯一の定義箇所。
// THREE/DOM 非依存の純関数。
import { R_EARTH, SIDEREAL_DAY, j2AccelInto, thirdBodyAccelAdd } from './orbital';
import { MU_MOON, MU_SUN } from './ephemeris';
import { atmosphericDensity } from './atmosphere';
import { Vec3, len, v3 } from './vec3';

export const EARTH_OMEGA = (2 * Math.PI) / SIDEREAL_DAY; // 地球自転角速度 [rad/s](Y軸=北極まわり)

// 地球と共回転する大気に対する対気速度: v - ω×r, ω = (0, ω, 0)
export function airspeed(r: Vec3, v: Vec3): Vec3 {
  return v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
}

// envAccelInto ホットパス用スクラッチ(単一スレッド前提)
const J2_SCRATCH = v3();

// out に書き込んで返す。bcInv は弾道係数の逆数 Cd·A/m(0 なら大気抵抗を省略)。
// RK4 の全ステージ × 全エンティティ × サブステップで呼ばれるホットパスなので、
// 大気抵抗は(専用の Vec3 を作らず)直接数値演算でインライン化し、割り当てを
// 抑える。J2・第三体項は共有の純関数(orbital.ts、テストで数値検証済み)を使う。
export function envAccelInto(
  out: Vec3,
  r: Vec3,
  v: Vec3,
  sunPos: Vec3,
  moonPos: Vec3,
  bcInv: number,
): Vec3 {
  const rho = bcInv > 0 ? atmosphericDensity(len(r) - R_EARTH) : 0;
  if (rho >= 1e-15) {
    const vrx = v.x - EARTH_OMEGA * r.z;
    const vry = v.y;
    const vrz = v.z + EARTH_OMEGA * r.x;
    const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
    out.x = vrx * k;
    out.y = vry * k;
    out.z = vrz * k;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  // J2 は加算合成: j2AccelInto はスクラッチに書き、成分を out へ足す
  const j = j2AccelInto(J2_SCRATCH, r);
  out.x += j.x;
  out.y += j.y;
  out.z += j.z;
  thirdBodyAccelAdd(out, r, sunPos, MU_SUN);
  thirdBodyAccelAdd(out, r, moonPos, MU_MOON);
  return out;
}
