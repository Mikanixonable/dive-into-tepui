// 面の向きによらない一様な環境光。ゲームプレイのために物理から外す光源で、恒星の色にも明るさにも
// 依らない無彩色の定数を、恒星からの距離の逆二乗で減衰させ、太陽の影に遮られずに届ける
// (DEVELOP/SPEC/RENDERING.md「地球の描画」)。遮蔽を読むときは、近くの構造が空を塞ぐぶん弱める。
// 強さは setFraction() で毎フレーム受ける。
import * as THREE from 'three/webgpu';
import { PI, dot, select, uniform, vec3 } from 'three/tsl';
import type { BoolUniform, FloatUniform, Vec3Node } from '../../tsl-types';
import { REFERENCE_RADIANT_INTENSITY, type SunLight } from '../sun-light';
import type { GraphicsSettingsData } from '../../graphics-settings';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';
import type { ScreenSpaceLight } from '../screen-space/screen-space-light';

// 1 天文単位で SUN_IRRADIANCE_1AU になる放射照度へ掛ける割合。
const AMBIENT_FRACTION = 0.03;

// 描画設定から、この場面で使う割合を選ぶ。切ってあれば 0。
export function ambientFraction(graphics: GraphicsSettingsData): number {
  return graphics.ambient ? AMBIENT_FRACTION : 0;
}

export class AmbientSource implements LightSource {
  private readonly fractionUniform: FloatUniform = uniform(0);
  private materialValue: THREE.MeshBasicNodeMaterial | null = null;
  // 設定を切り替えても同じシェーダで鏡面照度を描く。
  private readonly occluded: BoolUniform = uniform(false);

  // sunLight からは減衰の中心となる位置を読む。screenSpaceLight は近くの構造が空を塞ぐ割合で、
  // setOccluded(true) のあいだ読む。
  constructor(private readonly sunLight: SunLight, private readonly screenSpaceLight: ScreenSpaceLight) {}

  // 基準の放射照度へ掛ける割合。0 で消灯。
  get fraction(): number { return this.fractionUniform.value; }
  setFraction(fraction: number): void { this.fractionUniform.value = fraction; }

  // 遮蔽を読むか(描画設定「遮蔽と照り返し」がオフでないか)を設定する。
  public setOccluded(occluded: boolean): void { this.occluded.value = occluded; }

  hasContribution(): boolean { return this.fraction > 0; }

  // 環境光の寄与のマテリアル。強さと遮蔽の有無はユニフォームで切り替える。
  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.materialValue ??= contributionMaterial(sample, this.contribution(sample));
    return this.materialValue;
  }

  // 受け手 sample へ届く環境光の放射照度。空が遮られないとしたときの値で、消灯していれば 0。
  public irradiance(sample: ShadingSample): Vec3Node {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    return vec3(REFERENCE_RADIANT_INTENSITY).div(dot(toSun, toSun)).mul(this.fractionUniform);
  }

  // 拡散は、その画素へ届く環境光の放射照度そのもの。鏡面は同じ光を放射輝度 E/π の一様な環境と
  // して映したもので、粗さによらず一定 — 拡散を持たない金属面が影の中で真っ黒に残らないための項。
  // 遮蔽が有効なら拡散だけを近くの構造が空を塞ぐぶん弱める。
  private contribution(sample: ShadingSample): LightContribution {
    const irradiance = this.irradiance(sample);
    const radiance = irradiance.div(PI);
    return {
      diffuse: irradiance.mul(select(this.occluded, this.screenSpaceLight.ambientVisibility(sample), 1)),
      specular: radiance,
    };
  }

  // 組んだマテリアルを解放する。
  dispose(): void {
    this.materialValue?.dispose();
  }
}
