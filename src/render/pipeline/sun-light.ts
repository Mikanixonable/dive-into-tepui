// シーンを照らす恒星光の値。「どこから・どれだけの光が届くか」だけを答え、素材の反射特性
// (法線・粗さ・アルベド)には関知しない — 光源と、それへ反射率を掛ける側との分業の境界そのもの。
// 値は毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { AU } from '../../physics/astronomical-unit';
import type { ColorUniform, FloatNode, FloatUniform, Vec3Uniform } from '../tsl-types';

// 描画が扱う放射照度の目盛り。1 天文単位で太陽から届く放射照度をこの値に取る。
//
// 単位は SI ではなく `SOLAR_CONSTANT / π = 433.2 W/m²` で、1 天文単位での値が π になるよう
// 選んである。ランバート BRDF の 1/π がこれを打ち消すので、**太陽に正対したアルベド A の
// 完全拡散面は 1 天文単位で表示値 A になる** — 露出係数を持たずに済むのはこのため。
// 恒星ごとの色と放射強度は恒星の側が持ち、set() で渡される。
export const SUN_IRRADIANCE_1AU = Math.PI;

// 目盛りの基準になる恒星の放射強度 — 1 天文単位で SUN_IRRADIANCE_1AU を届ける量で、上の
// 目盛りの定義を放射強度として書き直したもの。放射強度が分かっていない恒星にもこれを与える。
export const REFERENCE_STAR_RADIANT_INTENSITY = SUN_IRRADIANCE_1AU * AU * AU;

// 恒星を持たない星系で仮に置く光源。**基準強度どおりの放射照度が届く距離**へ、色の手がかりが
// 無いので無彩色で、半径 0(誰も遮らない)で置く。
export const STARLESS_SUN_DISTANCE = AU;
export const STARLESS_SUN_RADIUS = 0;
export const STARLESS_SUN_COLOR = new THREE.Color(1, 1, 1);

// 放射強度 intensity の恒星から distance [m] の点が受ける放射照度(CPU 側で引く版)。
export function irradianceAtDistance(intensity: number, distance: number): number {
  return intensity / (distance * distance);
}

export class SunLight {
  private readonly positionUniform: Vec3Uniform;
  private readonly radiusUniform: FloatUniform;
  private readonly colorUniform: ColorUniform;
  private readonly intensityUniform: FloatUniform;

  // set() が書くまでは放射強度 0(無光)。
  constructor() {
    this.positionUniform = uniform(new THREE.Vector3(0, 1, 0));
    this.radiusUniform = uniform(1);
    this.colorUniform = uniform(new THREE.Color(1, 1, 1));
    this.intensityUniform = uniform(0);
  }

  // 恒星の描画座標での位置・半径・色・放射強度(距離の二乗で割ると放射照度になる量)を
  // 1フレーム分まとめて書く。
  set(position: THREE.Vector3, radius: number, color: THREE.Color, intensity: number): void {
    this.positionUniform.value.copy(position);
    this.radiusUniform.value = radius;
    this.colorUniform.value.copy(color);
    this.intensityUniform.value = intensity;
  }

  get position(): Vec3Uniform { return this.positionUniform; }

  // 恒星の半径 [m]。
  get radius(): FloatNode { return this.radiusUniform; }

  get color(): ColorUniform { return this.colorUniform; }

  // 放射強度。シェーディング点から恒星までの距離の二乗で割ると、その点の放射照度になる。
  get intensity(): FloatNode { return this.intensityUniform; }
}
