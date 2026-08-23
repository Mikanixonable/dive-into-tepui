// シーンを照らす恒星光の値。「どこから・どれだけの光が届くか」だけを答え、素材の反射特性
// (法線・粗さ・アルベド)には関知しない — ライティングパス(light-prepass.ts)がここを読んで
// 照度バッファを書き、マテリアルパスがそこへ反射率を掛けるという分業の境界そのもの。
// EnvironmentScene が毎フレーム set() で書き込み、RenderPipeline がインスタンスを所有する。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { ColorUniform, FloatNode, FloatUniform, Vec3Uniform } from '../tsl-types';

// 環境光の色味。恒星の色(太陽光は暖色、set() で毎フレーム更新)とは独立した固定値で、
// game/const.ts の管理対象ではない(environment-scene.ts の THREE.AmbientLight と同じ値)。
const AMBIENT_COLOR = new THREE.Color(0x8899bb);

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
