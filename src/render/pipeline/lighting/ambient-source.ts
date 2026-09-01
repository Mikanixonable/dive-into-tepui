// 面の向きによらない一様な環境光。ゲームプレイのために物理から外す光源で、恒星の色にも明るさにも
// 依らない無彩色の定数を、恒星からの距離の逆二乗で減衰させて遮蔽なしに届ける
// (DEVELOP/SPEC/RENDERING.md「地球の描画」)。強さは setFraction() で毎フレーム受ける。
import * as THREE from 'three/webgpu';
import { PI, dot, uniform, vec3 } from 'three/tsl';
import type { FloatUniform, Vec3Node } from '../../tsl-types';
import { REFERENCE_STAR_RADIANT_INTENSITY, type SunLight } from '../sun-light';
import type { GraphicsSettingsData } from '../../graphics-settings';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';

// 1 天文単位での放射照度の基準(SUN_IRRADIANCE_1AU)へ掛ける割合の 2 段。強いほうが読みやすさ
// 優先(マップビュー)、弱いほうが物理に近い暗さ優先(戦闘ビュー)。
export const AMBIENT_STRONG = 0.06;
export const AMBIENT_WEAK = 0.03;

// 基準の放射照度へ掛ける割合。マップビューでは読みやすさのため強く、戦闘ビューでは弱く、
// どちらも描画設定で切れる。
export function ambientFraction(overviewMode: boolean, graphics: GraphicsSettingsData): number {
  if (overviewMode) return graphics.overviewAmbient ? AMBIENT_STRONG : 0;
  return graphics.combatAmbient ? AMBIENT_WEAK : 0;
}

export class AmbientSource implements LightSource {
  private readonly fractionUniform: FloatUniform = uniform(0);
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  // 恒星からは位置だけを読む — 減衰の中心を知るためで、その色と放射強度は参照しない。
  constructor(private readonly sunLight: SunLight) {}

  // 基準の放射照度へ掛ける割合。0 で消灯。
  get fraction(): number { return this.fractionUniform.value; }
  setFraction(fraction: number): void { this.fractionUniform.value = fraction; }

  hasContribution(): boolean { return this.fraction > 0; }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
  }

  // 拡散は、その画素へ届く環境光の放射照度そのもの。放射強度には恒星のものではなく描画の目盛りの
  // 基準(1 天文単位で SUN_IRRADIANCE_1AU を届ける量)を使い、恒星の色と放射強度から切り離す —
  // 影の中がその恒星の色へ染まらないため。鏡面は同じ光を放射輝度 E/π の一様な環境として映した
  // もの — 金属面(拡散を持たない)が影の中で真っ黒に残らないための項で、粗さによる減りは持たない。
  private contribution(sample: ShadingSample): LightContribution {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    const irradiance: Vec3Node = vec3(REFERENCE_STAR_RADIANT_INTENSITY)
      .div(dot(toSun, toSun)).mul(this.fractionUniform);
    return { diffuse: irradiance, specular: irradiance.div(PI) };
  }

  dispose(): void {
    this.cached?.dispose();
  }
}
