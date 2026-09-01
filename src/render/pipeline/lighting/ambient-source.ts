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

// 基準の恒星が届ける放射照度へ掛ける割合の 2 段。強いほうが読みやすさ優先(マップビュー)、
// 弱いほうが物理に近い暗さ優先(戦闘ビュー)。
export const AMBIENT_STRONG = 0.06;
export const AMBIENT_WEAK = 0.03;

// ビューの種別と描画設定から、この場面で使う割合を選ぶ。描画設定で切ったビューでは 0。
export function ambientFraction(overviewMode: boolean, graphics: GraphicsSettingsData): number {
  if (overviewMode) return graphics.overviewAmbient ? AMBIENT_STRONG : 0;
  return graphics.combatAmbient ? AMBIENT_WEAK : 0;
}

export class AmbientSource implements LightSource {
  private readonly fractionUniform: FloatUniform = uniform(0);
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  // sunLight からは減衰の中心となる位置を読む。
  constructor(private readonly sunLight: SunLight) {}

  // 基準の放射照度へ掛ける割合。0 で消灯。
  get fraction(): number { return this.fractionUniform.value; }
  setFraction(fraction: number): void { this.fractionUniform.value = fraction; }

  hasContribution(): boolean { return this.fraction > 0; }

  // 環境光の寄与のマテリアル。強さはユニフォームなので初回だけ組めば足りる。
  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
  }

  // 拡散は、その画素へ届く環境光の放射照度そのもの。鏡面は同じ光を放射輝度 E/π の一様な環境と
  // して映したもので、粗さによらず一定 — 拡散を持たない金属面が影の中で真っ黒に残らないための項。
  private contribution(sample: ShadingSample): LightContribution {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    const irradiance: Vec3Node = vec3(REFERENCE_STAR_RADIANT_INTENSITY)
      .div(dot(toSun, toSun)).mul(this.fractionUniform);
    return { diffuse: irradiance, specular: irradiance.div(PI) };
  }

  // 組んだマテリアルを解放する。
  dispose(): void {
    this.cached?.dispose();
  }
}
