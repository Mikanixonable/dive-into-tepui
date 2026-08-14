// シーンを照らす恒星光の値。「どこから・どれだけの光が届くか」だけを答え、素材の反射特性
// (法線・粗さ・アルベド)には関知しない — ライティングパス(light-prepass.ts)がここを読んで
// 照度バッファを書き、マテリアルパスがそこへ反射率を掛けるという分業の境界そのもの。
// EnvironmentScene が毎フレーム set() で書き込み、RenderPipeline がインスタンスを所有する。
import * as THREE from 'three/webgpu';
import { float, uniform } from 'three/tsl';
import { SHADOW_MIN_AMBIENT, SHADOW_MIN_SUN } from '../../game/const';
import type { ColorUniform, FloatNode, FloatUniform, Vec3Uniform } from '../tsl-types';

// 環境光の色味。恒星の色(太陽光は暖色、set() で毎フレーム更新)とは独立した固定値で、
// game/const.ts の管理対象ではない(environment-scene.ts の THREE.AmbientLight と同じ値)。
const AMBIENT_COLOR = new THREE.Color(0x8899bb);

export class SunLight {
  private readonly directionUniform: Vec3Uniform;
  private readonly colorUniform: ColorUniform;
  private readonly intensityUniform: FloatUniform;
  private readonly ambientIntensityUniform: FloatUniform;
  private readonly ambientColorUniform: ColorUniform;
  // CPU 側(physics/shadow.ts の sunlitFactor)で求めた恒星の日照率(0=完全遮蔽、1=全開)。
  private readonly sunlitFactorUniform: FloatUniform;

  // 恒星の視半径 [rad]。0 = 点光源。面光源(球光源)へ切り替える将来の拡張点として型に
  // 持たせるだけで、現行のライティングパスはまだ読まない。
  angularRadius = 0;

  constructor() {
    this.directionUniform = uniform(new THREE.Vector3(0, 1, 0));
    this.colorUniform = uniform(new THREE.Color(1, 1, 1));
    this.intensityUniform = uniform(0);
    this.ambientIntensityUniform = uniform(0);
    this.ambientColorUniform = uniform(AMBIENT_COLOR.clone());
    this.sunlitFactorUniform = uniform(1);
  }

  // 恒星方向(描画原点から見た単位方向)・色・照度(受け手が実際に浴びる値 — 逆二乗込み)・
  // 環境光強度・恒星の日照率を1フレーム分まとめて書く。
  set(
    direction: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    ambientIntensity: number,
    sunlitFactor: number,
  ): void {
    this.directionUniform.value.copy(direction);
    this.colorUniform.value.copy(color);
    this.intensityUniform.value = intensity;
    this.ambientIntensityUniform.value = ambientIntensity;
    this.sunlitFactorUniform.value = sunlitFactor;
  }

  get direction(): Vec3Uniform { return this.directionUniform; }
  get color(): ColorUniform { return this.colorUniform; }
  get intensity(): FloatNode { return this.intensityUniform; }

  // 環境光の色。恒星光と違って方向を持たない固定値。
  get ambientColor(): ColorUniform { return this.ambientColorUniform; }

  // 環境光強度そのものに日照率の下限を織り込んで返す。環境光は特定方向からの遮蔽を持たず、
  // シャドウマップに置き換わる対象でもないため、恒星のように可視率を独立した関数へは分けない。
  get ambientIntensity(): FloatNode {
    const floor = float(SHADOW_MIN_AMBIENT).add(float(1 - SHADOW_MIN_AMBIENT).mul(this.sunlitFactorUniform));
    return this.ambientIntensityUniform.mul(floor);
  }

  // シェーディング点における恒星自身の可視率(0=完全遮蔽・1=全開)。今はCPU側で求めた
  // 日照率へ影の下限を掛けるだけだが、シャドウマップが実装されたらここが深度比較による
  // 問い合わせへ置き換わる、遮蔽問い合わせの継ぎ目そのもの。
  sunVisibility(): FloatNode {
    return float(SHADOW_MIN_SUN).add(float(1 - SHADOW_MIN_SUN).mul(this.sunlitFactorUniform));
  }
}
