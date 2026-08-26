// 面の向きによらない一様な環境光。ゲームプレイのために物理から外す光源で、その画素の位置へ
// 届く恒星の放射照度に一定の割合を掛け、遮蔽を受けずに届ける(DEVELOP/SPEC/RENDERING.md
// 「地球の描画」)。割合は呼び出し側(EnvironmentScene / 描画テスト環境)が書く。
import * as THREE from 'three/webgpu';
import { PI, dot, uniform } from 'three/tsl';
import type { FloatUniform, Vec3Node } from '../../tsl-types';
import type { SunLight } from '../sun-light';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';

// 恒星の放射照度へ掛ける割合の既定。強いほうが読みやすさ優先(マップビュー)、弱いほうが
// 物理に近い暗さ優先(戦闘ビュー)で、どちらを使うかは呼び出し側が決める。
export const AMBIENT_STRONG = 0.06;
export const AMBIENT_WEAK = 0.03;

export class AmbientSource implements LightSource {
  private readonly fractionUniform: FloatUniform = uniform(0);
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  constructor(private readonly sunLight: SunLight) {}

  // 恒星の放射照度へ掛ける割合。0 で消灯。
  get fraction(): number { return this.fractionUniform.value; }
  setFraction(fraction: number): void { this.fractionUniform.value = fraction; }

  hasContribution(): boolean { return this.fraction > 0; }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
  }

  // 拡散は、その画素へ届く恒星の放射照度の割合ぶん。鏡面は同じ光を放射輝度 E/π の一様な
  // 環境として映したもの — 金属面(拡散を持たない)が影の中で真っ黒に残らないための項で、
  // 粗さによる減りは持たない。
  private contribution(sample: ShadingSample): LightContribution {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    const irradiance: Vec3Node = this.sunLight.color.mul(this.sunLight.intensity)
      .div(dot(toSun, toSun)).mul(this.fractionUniform);
    return { diffuse: irradiance, specular: irradiance.div(PI) };
  }

  dispose(): void {
    this.cached?.dispose();
  }
}
