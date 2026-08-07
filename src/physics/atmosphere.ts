// 区分指数大気密度モデル(Vallado, "Fundamentals of Astrodynamics and
// Applications" の CIRA-72 / U.S. Standard Atmosphere 準拠テーブル)と、
// その大気による対気速度・抗力加速度。THREE/DOM 非依存の純粋関数。
import { R_EARTH, SIDEREAL_DAY } from './orbital-state';
import { Vec3, len, v3 } from './vec3';

// [基準高度 h0 [km], 基準密度 ρ0 [kg/m^3], スケールハイト H [km]]
const TABLE: readonly [number, number, number][] = [
  [0, 1.225, 7.249],
  [25, 3.899e-2, 6.349],
  [30, 1.774e-2, 6.682],
  [40, 3.972e-3, 7.554],
  [50, 1.057e-3, 8.382],
  [60, 3.206e-4, 7.714],
  [70, 8.77e-5, 6.549],
  [80, 1.905e-5, 5.799],
  [90, 3.396e-6, 5.382],
  [100, 5.297e-7, 5.877],
  [110, 9.661e-8, 7.263],
  [120, 2.438e-8, 9.473],
  [130, 8.484e-9, 12.636],
  [140, 3.845e-9, 16.149],
  [150, 2.07e-9, 22.523],
  [180, 5.464e-10, 29.74],
  [200, 2.789e-10, 37.105],
  [250, 7.248e-11, 45.546],
  [300, 2.418e-11, 53.628],
  [350, 9.518e-12, 53.298],
  [400, 3.725e-12, 58.515],
  [450, 1.585e-12, 60.828],
  [500, 6.967e-13, 63.822],
  [600, 1.454e-13, 71.835],
  [700, 3.614e-14, 88.667],
  [800, 1.17e-14, 124.64],
  [900, 5.245e-15, 181.05],
  [1000, 3.019e-15, 268.0],
];

// 高度 alt [m] における大気密度 [kg/m^3]。1000 km 超も最終区間で外挿する。
export function atmosphericDensity(alt: number): number {
  const hKm = Math.max(0, alt / 1000);
  let row = TABLE[0]!;
  for (let i = TABLE.length - 1; i >= 0; i--) {
    if (hKm >= TABLE[i]![0]) {
      row = TABLE[i]!;
      break;
    }
  }
  return row[1] * Math.exp(-(hKm - row[0]) / row[2]);
}

export const EARTH_OMEGA = (2 * Math.PI) / SIDEREAL_DAY; // 地球自転角速度 [rad/s](Y軸=北極まわり)

// 地球と共回転する大気に対する対気速度: v - ω×r, ω = (0, ω, 0)
export function airspeed(r: Vec3, v: Vec3): Vec3 {
  return v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
}

// 大気抵抗の加速度。bcInv は弾道係数の逆数 Cd·A/m(0 なら抵抗なし = ゼロベクトル)。
export function dragAccel(r: Vec3, v: Vec3, bcInv: number): Vec3 {
  const rho = bcInv > 0 ? atmosphericDensity(len(r) - R_EARTH) : 0;
  if (rho < 1e-15) return v3();
  const { x: vrx, y: vry, z: vrz } = airspeed(r, v);
  const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
  return v3(vrx * k, vry * k, vrz * k);
}
