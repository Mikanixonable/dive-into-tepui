// 雲fieldを連続体積へ変換する大気側の窓口。CloudVolumeが返す密度を光学積分へ渡し、
// ここは天体固定への変換と局所散乱の入力だけを所有する。cloudTopの交点は作らない。
import * as THREE from 'three/webgpu';
import { greaterThan, max, uniform, vec3, vec4 } from 'three/tsl';
import { CloudFieldSampler, type CloudLodMode } from '../cloud/cloud-field-sampler';
import { CloudVolume } from '../cloud/cloud-volume';
import type { AtmosphereClouds } from '../atmosphere';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node } from '../tsl-types';

export const CLOUD_VOLUME_ALBEDO = 0.8;

export const CLOUD_VOLUME_SPECIES = ['cirrus', 'cumulus'] as const;
export type CloudSpecies = (typeof CLOUD_VOLUME_SPECIES)[number];

export interface CloudVolumeMedium {
  readonly extinction: Vec3Node;
  readonly source: Vec3Node;
}

export class CloudAtmosphereRenderer {
  private readonly fieldSampler = new CloudFieldSampler();
  private readonly volume = new CloudVolume(this.fieldSampler);
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  private readonly enabled: Readonly<Record<CloudSpecies, FloatUniform>> = {
    cirrus: uniform(1), cumulus: uniform(1),
  };

  public constructor() {
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
  }

  public set(clouds: AtmosphereClouds | null): void {
    this.active.value = clouds === null ? 0 : 1;
    if (clouds === null) return;
    this.bodyFromWorld.value.copy(clouds.bodyFromWorld);
    this.fieldSampler.setTexture(clouds.field);
  }

  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.enabled[species].value = enabled ? 1 : 0;
  }

  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.fieldSampler.setLodSampling(mode, fixedLevel);
  }

  // 連続雲が有効なrayでは、境界の取りこぼしを散らすためのblue noiseを使わない。密度を
  // 中点積分する体積へ位相ジッタを掛けると、薄い柱が画素ごとに消えるためである。
  public hasVolume(): BoolNode {
    return greaterThan(this.active.mul(this.enabled.cirrus.add(this.enabled.cumulus)), 0);
  }

  // offsetとrayDirは大気積分器の真球空間、sunDirは点から恒星への真球空間方向、
  // groundRadiusとfootprintは[m]。密度はCloudVolumeから一度だけ取得し、複数speciesを
  // 密度加重した局所sourceへまとめる。
  public mediumAt(
    offset: Vec3Node, rayDir: Vec3Node, sunDir: Vec3Node, sunRadiance: Vec3Node,
    groundRadius: FloatNode, footprint: FloatNode,
  ): CloudVolumeMedium {
    const bodyOffset = this.bodyFromWorld.mul(vec4(offset, 0)).xyz;
    const bodyRay = this.bodyFromWorld.mul(vec4(rayDir, 0)).xyz;
    const bodySun = this.bodyFromWorld.mul(vec4(sunDir, 0)).xyz;
    const density = this.volume.densityAt(bodyOffset, groundRadius, footprint);
    const cirrus = density.cirrus.mul(this.active).mul(this.enabled.cirrus);
    const cumulus = density.cumulus.mul(this.active).mul(this.enabled.cumulus);
    const extinctionScalar = cirrus.add(cumulus);
    // 雲粒の散乱は局所の恒星輝度を直接sourceへ置く。rayMarch側が区間透過を一度だけ
    // 掛けるため、ここではcloud自身の透過率を再適用しない。
    const phase = max(bodyRay.dot(bodySun), 0).mul(0.75).add(0.25);
    const source = sunRadiance.mul(
      cirrus.add(cumulus).mul(CLOUD_VOLUME_ALBEDO).mul(phase),
    ).div(max(extinctionScalar, 1e-30));
    return {
      extinction: vec3(extinctionScalar),
      source,
    };
  }
}
