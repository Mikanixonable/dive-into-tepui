// 太陽輻射圧によるキャノンボールモデルの加速度。物体を反射率一定の球とみなし、姿勢によらず
// 太陽 - 物体を結ぶ直線方向にのみ力が働くとする。THREE/DOM 非依存の純関数。
import type { CelestialMotion } from './celestial-motion';
import { AU } from './planet-orbit';
import { Vec3, v3 } from '../math/vec3';

export const SPEED_OF_LIGHT = 299792458; // 真空中の光速 [m/s](SI 定義値)
// 1天文単位における太陽の全波長放射照度 [W/m^2]。距離の2乗に反比例して弱まる。
export const SOLAR_CONSTANT = 1361;
// 完全吸収面が受ける輻射圧 [N/m^2]。放射照度を光速で割ったもので、独立した測定値ではない。
export const SOLAR_PRESSURE_1AU = SOLAR_CONSTANT / SPEED_OF_LIGHT;
// 位置 r の物体が太陽から受ける輻射圧加速度。srpCoeff は輻射圧係数と断面積質量比の積
// C_R·A/m [m^2/kg] で、0 なら寄与ゼロ。sunlit は日照率 0..1(本影で 0)。
export function srpAccel(
  r: Vec3, sun: CelestialMotion, sunPivot: number, srpCoeff: number, sunlit: number,
): Vec3 {
  if (srpCoeff === 0 || sunlit === 0) return v3();
  const s = sun.positionAt(sunPivot, sunPivot);
  const dx = r.x - s.x;
  const dy = r.y - s.y;
  const dz = r.z - s.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1) return v3();

  // 大きさは距離の2乗に反比例し、向きは太陽から物体へ向かう単位ベクトル。
  const d = Math.sqrt(d2);
  const k = (sunlit * srpCoeff * SOLAR_PRESSURE_1AU * AU * AU) / (d2 * d);
  return v3(dx * k, dy * k, dz * k);
}
