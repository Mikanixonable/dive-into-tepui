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

// 環境光の色味。恒星の色(太陽光は暖色、set() で毎フレーム更新)とは独立した固定値。
// 描画テスト環境のフォワード経路が同じ色の THREE.AmbientLight を置くので、値の正本として
// ここから公開する。
export const AMBIENT_COLOR = new THREE.Color(0x8899bb);

// 環境光の放射照度。地球照(地球が反射して低軌道の物体を照らす光)の代用で置いた暫定値。
// **低軌道での明るさに合わせただけの手書きの定数で、位置によらず一定に足される** —
// 太陽から遠いほど直射を上回っていく。方向を持たないので遮蔽も受けない。
export const AMBIENT_IRRADIANCE = SUN_IRRADIANCE_1AU * 0.093;

// 本影の中にも届く光の量(星明かり・地球照ぶん)を、恒星と同じ向きから来る一定量で代用した
// もの。恒星の放射照度に対する割合で、ライティングパスが直射ぶんと分け合う。
export const SHADOW_MIN_SUN = 0.04;

export class SunLight {
  private readonly positionUniform: Vec3Uniform;
  private readonly radiusUniform: FloatUniform;
  private readonly colorUniform: ColorUniform;
  private readonly intensityUniform: FloatUniform;
  private readonly ambientIntensityUniform: FloatUniform;
  private readonly ambientColorUniform: ColorUniform;

  constructor() {
    this.positionUniform = uniform(new THREE.Vector3(0, 1, 0));
    this.radiusUniform = uniform(1);
    this.colorUniform = uniform(new THREE.Color(1, 1, 1));
    this.intensityUniform = uniform(0);
    this.ambientIntensityUniform = uniform(0);
    this.ambientColorUniform = uniform(AMBIENT_COLOR.clone());
  }

  // 恒星の描画座標での位置・半径・色・放射強度(距離の二乗で割ると放射照度になる量)・
  // 環境光強度を1フレーム分まとめて書く。
  set(
    position: THREE.Vector3,
    radius: number,
    color: THREE.Color,
    intensity: number,
    ambientIntensity: number,
  ): void {
    this.positionUniform.value.copy(position);
    this.radiusUniform.value = radius;
    this.colorUniform.value.copy(color);
    this.intensityUniform.value = intensity;
    this.ambientIntensityUniform.value = ambientIntensity;
  }

  get position(): Vec3Uniform { return this.positionUniform; }

  // 恒星の半径 [m]。遮蔽パスが本影と半影を分けるのに要る。
  get radius(): FloatNode { return this.radiusUniform; }

  get color(): ColorUniform { return this.colorUniform; }

  // 放射強度。シェーディング点から恒星までの距離の二乗で割ると、その点の放射照度になる。
  get intensity(): FloatNode { return this.intensityUniform; }

  // 環境光の色。恒星光と違って方向を持たない固定値。
  get ambientColor(): ColorUniform { return this.ambientColorUniform; }

  // 環境光強度。方向を持たないので遮蔽も受けない。
  get ambientIntensity(): FloatNode { return this.ambientIntensityUniform; }
}
