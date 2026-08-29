// 太陽の静的事実。放射強度は書かない — 描画の放射照度の目盛りが「1 天文単位で太陽から届く量」
// で定義されているので、太陽の放射強度はその基準値(REFERENCE_STAR_RADIANT_INTENSITY)そのもの
// になる。
import * as THREE from 'three/webgpu';
import { StarDef } from '../../../physics/celestial-motion';
import { MU_SUN, R_SUN } from '../../../physics/solar-system/constants';

export const SUN: StarDef = { id: 'sun', mu: MU_SUN, radius: R_SUN };

// 太陽光の色。5772 K(太陽の実効温度)の黒体を sRGB へ写した色にほぼ一致する。
export const SUN_LIGHT_COLOR = new THREE.Color(0xfff4e0);

// 太陽面の色。実球体と点像が同じ色を名乗る — 表示が切り替わったところで色みが変わらない。
export const SUN_SURFACE_COLOR = 0xfff3d0;
