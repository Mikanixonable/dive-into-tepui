// 太陽の静的事実。放射強度は書かない — 描画の放射照度の目盛りが「1 天文単位で太陽から届く量」
// で定義されているので、太陽の放射強度はその基準値(REFERENCE_STAR_RADIANT_INTENSITY)そのもの
// になる。
import * as THREE from 'three/webgpu';
import { StarDef } from '../../../physics/celestial-body-def';
import { MU_SUN, R_SUN } from './constants';

export const SUN: StarDef = { id: 'sun', mu: MU_SUN, radius: R_SUN };

// 大気外で昼光へホワイトバランスされた太陽色。円盤と照明はこの1値から導く。
const SUN_COLOR = 0xffffff;

export const SUN_LIGHT_COLOR = new THREE.Color(SUN_COLOR);
export const SUN_SURFACE_COLOR = SUN_COLOR;
