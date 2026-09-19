// 太陽の静的事実。
import * as THREE from 'three/webgpu';
import { StarDef } from '../../../physics/celestial-body-def';
import { AU, SOLAR_CONSTANT } from '../../../physics/astronomical-unit';

export const MU_SUN = 1.32712440018e20; // 太陽重力定数 [m^3/s^2]
export const R_SUN = 6.957e8; // [m]

export const SUN: StarDef = {
  id: 'sun', mu: MU_SUN, radius: R_SUN,
  radiantIntensity: SOLAR_CONSTANT * AU * AU, // [W/sr] 1天文単位での放射照度が太陽定数になる量
};

// 大気外で昼光へホワイトバランスされた太陽色。円盤と照明はこの1値から導く。
const SUN_COLOR = 0xffffff;

export const SUN_LIGHT_COLOR = new THREE.Color(SUN_COLOR);
export const SUN_SURFACE_COLOR = SUN_COLOR;
