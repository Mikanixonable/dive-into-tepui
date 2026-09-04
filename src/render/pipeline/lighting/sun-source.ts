// 恒星の直射光の寄与。光源モデルの設定で「点光源 + GGX」と「一様球の閉じた解 + LTC」を
// 選ぶ。どちらも遮蔽パスの透過率を掛けて出す。
import * as THREE from 'three/webgpu';
import { PI, clamp, dot, length, max, normalize, saturate, texture } from 'three/tsl';
import { ggxSpecularFactor } from './ggx';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import { sphereIrradianceFactor, type SphereSpecular } from './sphere-light';
import type { FloatNode, Vec3Node } from '../../tsl-types';
import type { OcclusionPass } from '../occlusion';
import type { SunLight } from '../sun-light';
import type { ShadingSample } from './shading-sample';

// 光源モデルの選択値。graphics-settings.ts の sunLightModel の選択肢と対応する。
const SUN_LIGHT_MODEL = { point: 0, sphere: 1 } as const;

export class SunSource implements LightSource {
  // モードごとに 1 枚を遅延生成して持つ。切り替えのたびに作り直すと、シェーダの再コンパイルが
  // フレームを止める。
  private readonly materials = new Map<number, THREE.MeshBasicNodeMaterial>();

  public constructor(
    private readonly sunLight: SunLight,
    private readonly occlusion: OcclusionPass,
    private readonly sphereSpecular: SphereSpecular,
    private model: number,
  ) {}

  // 描画設定 sunLightModel の値をそのまま受ける。次の material() から効く。
  public setModel(model: number): void { this.model = model; }

  public hasContribution(): boolean { return true; }

  // 現在の光源モデルのマテリアル。モードごとに初回だけ組む。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    const cached = this.materials.get(this.model);
    if (cached !== undefined) return cached;
    const contribution = this.model === SUN_LIGHT_MODEL.sphere
      ? this.sphereContribution(sample) : this.pointContribution(sample);
    const material = contributionMaterial(sample, contribution);
    this.materials.set(this.model, material);
    return material;
  }

  // 恒星を点として扱う寄与。放射照度は差分ベクトルの逆二乗、鏡面は GGX。
  private pointContribution(sample: ShadingSample): LightContribution {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    const lightDir = normalize(toSun);
    const dotNL: FloatNode = saturate(dot(sample.normal, lightDir));
    // 恒星から届く放射照度(遮蔽込み)。拡散・鏡面の両方がこれへ BRDF を掛ける。
    const irradiance: Vec3Node = this.sunLight.color
      .mul(this.sunLight.intensity).div(dot(toSun, toSun))
      .mul(dotNL).mul(texture(this.occlusion.texture, sample.uv).r);
    return { diffuse: irradiance, specular: irradiance.mul(ggxSpecularFactor(sample, lightDir)) };
  }

  // 恒星を視半径を持つ一様球として扱う寄与(sphere-light.ts)。1 天文単位では点光源の値と
  // 一致し、視半径が効く近距離で終端の柔らかさと円盤のハイライトが出る。
  private sphereContribution(sample: ShadingSample): LightContribution {
    const center = sample.viewPositionOf(this.sunLight.position);
    const toSun = center.sub(sample.position);
    const distSqr = dot(toSun, toSun);
    const dist = max(length(toSun), 1);
    // 半径 0(主星の無いレジストリの置き光源)でも放射輝度が定義されるよう 1 m を床にする。
    const radius = max(this.sunLight.radius, 1);
    const transmittance = texture(this.occlusion.texture, sample.uv).r;

    const cosBeta = dot(sample.normal, toSun.div(dist));
    const sinSigmaSqr = clamp(radius.mul(radius).div(distSqr), 0, 1);
    const diffuse: Vec3Node = this.sunLight.color.mul(this.sunLight.intensity).div(distSqr)
      .mul(sphereIrradianceFactor(cosBeta, sinSigmaSqr)).mul(transmittance);

    // 鏡面は一様球の放射輝度 L = 放射強度 / (π R²) に、球光源の鏡面の係数を掛ける。
    const radiance: Vec3Node = this.sunLight.color
      .mul(this.sunLight.intensity).div(radius.mul(radius).mul(PI));
    const specular: Vec3Node = radiance
      .mul(this.sphereSpecular.factor(sample, center, radius)).mul(transmittance);
    return { diffuse, specular };
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    for (const material of this.materials.values()) material.dispose();
  }
}
