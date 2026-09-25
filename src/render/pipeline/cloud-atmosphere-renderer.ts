// 大気レイマーチの各標本点で、表面雲・影と同じ CloudDensityEvaluator を読む。
// 固定高度の薄い殻は作らず、液相・氷相の連続3D消散場をそのまま参加媒質へ加える。
import * as THREE from 'three/webgpu';
import { dot, max, step, uniform, vec4 } from 'three/tsl';
import { CloudDensityEvaluator } from '../cloud/cloud-density-evaluator';
import { cloudQualityPolicy } from '../cloud/cloud-quality';
import { CloudFieldSampler } from '../cloud/cloud-field-sampler';
import type { AtmosphereClouds } from '../atmosphere';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node } from '../tsl-types';

export type CloudSpecies = 'cirrus' | 'cumulus';

// render-lab から動かす表示上の調整値。cutoff はその相の局所密度率0..1の足切り、gainは
// 消散係数へ掛ける倍率、albedoは雲が太陽光を視線へ戻す割合。
export interface CloudPhaseKnob {
  readonly cutoff: FloatUniform;
  readonly gain: FloatUniform;
  readonly albedo: FloatUniform;
}

const CLOUD_PHASE_KNOBS: Readonly<Record<CloudSpecies, CloudPhaseKnob>> = {
  cirrus: { cutoff: uniform(0), gain: uniform(1), albedo: uniform(1) },
  cumulus: { cutoff: uniform(0), gain: uniform(1), albedo: uniform(0.8) },
};

export function cloudPhaseKnobOf(species: CloudSpecies): CloudPhaseKnob {
  return CLOUD_PHASE_KNOBS[species];
}

export interface CloudVolumeSample {
  // 視線方向によらない局所消散係数 [1/m]。
  readonly extinctionPerM: FloatNode;
  // 単位光学的厚みあたりに視線へ足す局所放射輝度。
  readonly sourceRadiance: Vec3Node;
}

export class CloudAtmosphereRenderer {
  private readonly fieldSampler = new CloudFieldSampler();
  private readonly bodyFromWorld: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly surfaceRadiusM: FloatUniform = uniform(1);
  private readonly density = new CloudDensityEvaluator(this.surfaceRadiusM);
  private readonly active: FloatUniform = uniform(0);
  private readonly detailFootprintScale: FloatUniform = uniform(1);
  private readonly enabled: Readonly<Record<CloudSpecies, FloatUniform>> = {
    cirrus: uniform(1),
    cumulus: uniform(1),
  };

  public set(clouds: AtmosphereClouds | null): void {
    this.active.value = clouds === null ? 0 : 1;
    if (clouds === null) return;
    this.bodyFromWorld.value.copy(clouds.bodyFromWorld);
    this.surfaceRadiusM.value = clouds.surfaceRadius;
    this.fieldSampler.bind(clouds.cloud.field);
  }

  // API名は既存の描画設定呼び出しとの互換のため維持するが、現在は「殻」ではなく相の有効/無効を切る。
  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.enabled[species].value = enabled ? 1 : 0;
  }

  public setQuality(level: number): void {
    this.detailFootprintScale.value = cloudQualityPolicy(level).detailFootprintScale;
  }

  public sampleAt(
    sphereDirection: Vec3Node,
    altitudeM: FloatNode,
    footprintM: FloatNode,
    sunDirection: Vec3Node,
    sunRadiance: Vec3Node,
  ): CloudVolumeSample {
    const bodyDirection = this.bodyFromWorld.mul(vec4(sphereDirection, 0)).xyz;
    const field = this.fieldSampler.sampleCloud(bodyDirection);
    const density = this.density.sample(
      field, bodyDirection, altitudeM, footprintM.mul(this.detailFootprintScale),
    );

    const liquidKnob = CLOUD_PHASE_KNOBS.cumulus;
    const iceKnob = CLOUD_PHASE_KNOBS.cirrus;
    // 既定cutoff=0では消散係数をそのまま通し、柱光学深さを保存する。phaseFractionを
    // 連続倍率として再度掛けるとcoverageを二重適用してしまうため、cutoffはゲートにだけ使う。
    const liquidPresence = step(liquidKnob.cutoff, density.liquidFraction)
      .mul(liquidKnob.gain).mul(this.enabled.cumulus);
    const icePresence = step(iceKnob.cutoff, density.iceFraction)
      .mul(iceKnob.gain).mul(this.enabled.cirrus);
    const liquidExtinction = density.liquidExtinctionPerM.mul(liquidPresence);
    const iceExtinction = density.iceExtinctionPerM.mul(icePresence);
    const extinctionPerM = liquidExtinction.add(iceExtinction).mul(this.active).toVar();

    // 雲の多重散乱は拡散反射の極限近似。液相/氷相をそれぞれの消散量で重み付けする。
    const illuminated = max(dot(sphereDirection, sunDirection), 0);
    const weightedAlbedo = liquidExtinction.mul(liquidKnob.albedo)
      .add(iceExtinction.mul(iceKnob.albedo))
      .div(max(liquidExtinction.add(iceExtinction), 1e-30));
    return {
      extinctionPerM,
      sourceRadiance: sunRadiance.mul(illuminated.mul(weightedAlbedo)),
    };
  }
}
