// 恒星の直射光の寄与。点光源 + GGX で、遮蔽パスの透過率を掛けて出す。
import * as THREE from 'three/webgpu';
import {
  D_GGX, F_Schlick, V_GGX_SmithCorrelated, dot, float, normalize, saturate, texture,
} from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';
import type { OcclusionPass } from '../occlusion';
import type { SunLight } from '../sun-light';
import { contributionMaterial, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';

export class SunSource implements LightSource {
  constructor(
    private readonly sunLight: SunLight,
    private readonly occlusion: OcclusionPass,
  ) {}

  hasContribution(): boolean { return true; }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    // 恒星は点光源。画素ごとに差分ベクトルを取るので、方向も逆二乗の減衰もその画素のものになる。
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    const lightDir = normalize(toSun);
    const dotNL: FloatNode = saturate(dot(sample.normal, lightDir));
    // 恒星から届く放射照度(遮蔽込み)。拡散・鏡面の両方がこれを基準に BRDF を掛ける。
    // 恒星の直射は遮蔽パスの透過率で落ち、本影では 0 になる。遮られる源が何か(天体・環・
    // メッシュ)は sun-occlusion.ts が畳み込み済みで、ここはその 1 枚だけを読む。
    const irradiance: Vec3Node = this.sunLight.color
      .mul(this.sunLight.intensity).div(dot(toSun, toSun))
      .mul(dotNL).mul(texture(this.occlusion.texture, sample.uv).r);

    const alpha = sample.roughness.mul(sample.roughness);
    const halfDir = normalize(lightDir.add(sample.viewDir));
    const dotNH = saturate(dot(sample.normal, halfDir));
    const dotNV = saturate(dot(sample.normal, sample.viewDir));
    const dotVH = saturate(dot(sample.viewDir, halfDir));
    // D_GGX/V_GGX_SmithCorrelated/F_Schlick の @types/three 上の戻り値型 OperatorNode は
    // メソッドチェインを持たない(実体は他の TSL ノードと同じプロキシで、型定義側の欠落)ため、
    // FloatNode へ読み替えてから掛け合わせる。
    const fresnel = F_Schlick({ f0: float(1), f90: float(1), dotVH }) as unknown as FloatNode;
    const visibility = V_GGX_SmithCorrelated({ alpha, dotNL, dotNV }) as unknown as FloatNode;
    const distribution = D_GGX({ alpha, dotNH }) as unknown as FloatNode;
    const ggx = fresnel.mul(visibility).mul(distribution);
    return contributionMaterial(sample, { diffuse: irradiance, specular: irradiance.mul(ggx) });
  }
}
