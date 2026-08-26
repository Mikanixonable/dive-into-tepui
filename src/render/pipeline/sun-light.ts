// シーンを照らす恒星光の値。「どこから・どれだけの光が届くか」だけを答え、素材の反射特性
// (法線・粗さ・アルベド)には関知しない — ライティングパス(light-prepass.ts)がここを読んで
// 照度バッファを書き、マテリアルパスがそこへ反射率を掛けるという分業の境界そのもの。
// EnvironmentScene が毎フレーム set() で書き込み、RenderPipeline がインスタンスを所有する。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { AU } from '../../physics/planet-orbit';
import type { ColorUniform, FloatNode, FloatUniform, Vec3Uniform } from '../tsl-types';

// 描画が扱う放射照度の単位。1 天文単位で太陽から届く放射照度をこの値に取る。
//
// 単位は SI ではなく `SOLAR_CONSTANT / π = 433.2 W/m²` で、1 天文単位での値が π になるよう
// 選んである。ランバート BRDF の 1/π がこれを打ち消すので、**太陽に正対したアルベド A の
// 完全拡散面は 1 天文単位で表示値 A になる** — 露出係数を持たずに済むのはこのため。
export const SUN_IRRADIANCE_1AU = Math.PI;

// 恒星の放射強度。SUN_IRRADIANCE_1AU は 1 天文単位で受ける放射照度なので、そのぶんの逆二乗を
// 戻したもの。set() の intensity にはこれを渡す。
export const SUN_RADIANT_INTENSITY = SUN_IRRADIANCE_1AU * AU * AU;

// 恒星から distance [m] の点が受ける放射照度。画素ごとの陰影はライティングパスが同じ量を
// GPU 側で引くが、前方描画の環や輝点は CPU 側で要る。
export function sunIrradianceAtDistance(distance: number): number {
  return SUN_RADIANT_INTENSITY / (distance * distance);
}

// 恒星光の色。5772 K(太陽の実効温度)の黒体を sRGB へ写した色にほぼ一致する。
export const SUN_COLOR = new THREE.Color(0xfff4e0);

export class SunLight {
  private readonly positionUniform: Vec3Uniform;
  private readonly radiusUniform: FloatUniform;
  private readonly colorUniform: ColorUniform;
  private readonly intensityUniform: FloatUniform;

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

  // 恒星の半径 [m]。遮蔽パスが本影と半影を分けるのに要る。
  get radius(): FloatNode { return this.radiusUniform; }

  get color(): ColorUniform { return this.colorUniform; }

  // 放射強度。シェーディング点から恒星までの距離の二乗で割ると、その点の放射照度になる。
  get intensity(): FloatNode { return this.intensityUniform; }
}
