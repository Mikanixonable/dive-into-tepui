// 雲のGPU評価。積雲は固定半径の1点シェルではなく、2D雲場を高度方向へ広げた密度を視線と
// 太陽光路へ積分する。巻雲だけは従来の薄い層として残るが、積雲の見え・大気散乱・雲影は
// cloudDensityAt() を共有する。
import * as THREE from 'three/webgpu';
import {
  If, Loop, abs, dot, exp, float, fract, length, max, min, normalize, sqrt, texture, uniform,
  vec2, vec3, vec4,
} from 'three/tsl';
import { sphereMeshUv } from '../celestial-surface';
import { CLOUD_ALBEDO, CLOUD_TOP_SPAN, EMPTY_CLOUD_FIELD } from '../cloud/cumulus-shape';
import { cloudDensityAt } from '../cloud/cloud-density';
import type { AtmosphereClouds } from '../atmosphere';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';

// 大気の中へ固定層として立てるのは巻雲だけ。積雲は cloudDensityAt の体積積分で描く。
export const CLOUD_SHELL_SPECIES = ['cirrus', 'cumulus'] as const;
export type CloudSpecies = (typeof CLOUD_SHELL_SPECIES)[number];

const MAX_SHELL_OPTICAL_DEPTH = 5;
const MIN_SHELL_THICKNESS = 1;
const CLOUD_LIGHT_STEPS = 8;
const CLOUD_ANISOTROPY = 0.35;

export interface CloudShellKnob {
  readonly cutoff: FloatUniform;
  readonly gain: FloatUniform;
  readonly albedo: FloatUniform;
  readonly bottomAltitude: FloatUniform;
  readonly topAltitude: FloatUniform;
}

export const CLOUD_SHELL_KNOB: Readonly<Record<CloudSpecies, CloudShellKnob>> = {
  cirrus: {
    cutoff: uniform(0), gain: uniform(1), albedo: uniform(1),
    bottomAltitude: uniform(15e3), topAltitude: uniform(16e3),
  },
  // 旧 render-lab の入力を壊さないためだけの互換ノブ。積雲は固定殻として評価しない。
  cumulus: {
    cutoff: uniform(0.05), gain: uniform(1), albedo: uniform(1),
    bottomAltitude: uniform(0), topAltitude: uniform(2e3),
  },
};

export function shellAltitudeOf(species: CloudSpecies): FloatNode {
  const knob = CLOUD_SHELL_KNOB[species];
  return knob.bottomAltitude.add(knob.topAltitude).mul(0.5);
}

export interface CloudShellSample {
  readonly transmittance: FloatNode;
  readonly radiance: Vec3Node;
}

export interface CloudMediumSample {
  readonly extinction: Vec3Node;
  // 単位消散あたりの放射輝度。AtmosphereLayer が大気の媒質と合成する。
  readonly source: Vec3Node;
}

function opticalDepthOf(field: Vec4Node): FloatNode {
  const knob = CLOUD_SHELL_KNOB.cirrus;
  return min(max(field.b.sub(knob.cutoff), 0).mul(knob.gain), MAX_SHELL_OPTICAL_DEPTH);
}

const cloudPhase = (cosTheta: FloatNode): FloatNode => {
  const g = float(CLOUD_ANISOTROPY);
  const squared = g.mul(g);
  const denominator = max(float(1).add(squared).sub(g.mul(cosTheta).mul(2)), 1e-4);
  return float(1).sub(squared).div(denominator.mul(sqrt(denominator)));
};

export class CloudScattering {
  private readonly field = texture(EMPTY_CLOUD_FIELD);
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  private readonly surfaceRadius: FloatUniform;
  private readonly volumeEnabled: FloatUniform;
  private readonly shellEnabled: Readonly<Record<CloudSpecies, FloatUniform>> = {
    cirrus: uniform(1),
    // 積雲は固定殻として描かない。旧設定 API の型互換用に常時無効のスロットだけ残す。
    cumulus: uniform(0),
  };

  public constructor() {
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
    this.surfaceRadius = uniform(1);
    this.volumeEnabled = uniform(1);
  }

  public set(clouds: AtmosphereClouds | null, surfaceRadius: number): void {
    this.active.value = clouds === null ? 0 : 1;
    this.surfaceRadius.value = surfaceRadius;
    if (clouds === null) return;
    this.bodyFromWorld.value.copy(clouds.bodyFromWorld);
    this.field.value = clouds.field;
  }

  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.shellEnabled[species].value = enabled ? 1 : 0;
  }

  public setVolumeEnabled(enabled: boolean): void {
    this.volumeEnabled.value = enabled ? 1 : 0;
  }

  public present(species: CloudSpecies): BoolNode {
    return this.active.mul(this.shellEnabled[species]).greaterThan(0);
  }

  // 視線上の積雲密度。field と高度だけを読むため、視線積分と太陽光路積分から同じ評価を呼べる。
  public mediumAt(
    offset: Vec3Node, altitude: FloatNode, rayDir: Vec3Node, sunDir: Vec3Node,
    sunDirInSphere: Vec3Node, sunRadiance: Vec3Node,
    viewTransmittance: FloatNode,
  ): CloudMediumSample {
    const density = float(0).toVar();
    IfActive(this.active.mul(this.volumeEnabled), () => {
      const field = this.fieldAt(normalize(offset));
      density.assign(cloudDensityAt(field, altitude));
    });
    const sunTransmittance = this.sunTransmittanceAt(offset, sunDirInSphere);
    const source = sunRadiance
      .mul(sunTransmittance)
      .mul(viewTransmittance)
      .mul(CLOUD_ALBEDO)
      .mul(cloudPhase(dot(rayDir, sunDir)));
    return { extinction: vec3(density), source };
  }

  // 交点から恒星まで同じ密度場をたどった透過率。固定半径の積雲シェル交差ではなく、各サンプルの
  // 高度で cloudDensityAt を評価する。blue noise は使わず、光路の中点則を保つ。
  private sunTransmittanceAt(
    offset: Vec3Node, sunDir: Vec3Node,
  ): FloatNode {
    const outerRadius = this.surfaceRadius.add(CLOUD_TOP_SPAN);
    const along = dot(offset, sunDir);
    const discriminant = outerRadius.mul(outerRadius).sub(dot(offset, offset)).add(along.mul(along));
    const exit = max(sqrt(max(discriminant, 0)).sub(along), 0);
    const stepLength = exit.div(CLOUD_LIGHT_STEPS);
    const opticalDepth = float(0).toVar();
    Loop({ start: 0, end: CLOUD_LIGHT_STEPS, type: 'int', condition: '<' }, ({ i }) => {
      const sampleOffset = offset.add(sunDir.mul(stepLength.mul(float(i).add(0.5))));
      const radius = max(length(sampleOffset), 1e-6);
      const field = this.fieldAt(sampleOffset.div(radius));
      const altitude = radius.sub(this.surfaceRadius);
      opticalDepth.addAssign(cloudDensityAt(field, altitude).mul(stepLength));
    });
    return exp(opticalDepth.negate());
  }

  // 固定層の巻雲へ、交点1つぶんの透過率と放射輝度を返す。
  public scatteredAt(
    shellRadius: FloatNode, offset: Vec3Node, rayDir: Vec3Node,
    sunDir: Vec3Node, sunRadiance: Vec3Node,
  ): CloudShellSample {
    const knob = CLOUD_SHELL_KNOB.cirrus;
    const up = offset.div(shellRadius);
    const field = this.fieldAt(up);
    const opticalDepth = opticalDepthOf(field).mul(this.active).mul(this.shellEnabled.cirrus);
    const thickness = max(knob.topAltitude.sub(knob.bottomAltitude), MIN_SHELL_THICKNESS);
    const grazingCosine = sqrt(thickness.mul(0.5).div(shellRadius));
    const airmass = max(abs(dot(up, rayDir)), grazingCosine).reciprocal();
    const covered = exp(opticalDepth.mul(airmass).negate()).oneMinus();
    return {
      transmittance: covered.oneMinus(),
      radiance: sunRadiance.mul(covered.mul(max(dot(up, sunDir), float(0))).mul(knob.albedo)),
    };
  }

  private fieldAt(up: Vec3Node): Vec4Node {
    const uv = sphereMeshUv(this.bodyFromWorld.mul(vec4(up, 0)).xyz);
    return this.field.sample(vec2(fract(uv.x), uv.y)).level(float(0));
  }
}

// TSL の If はこのファイルの評価ノードを読みやすく保つための小さな構文補助。コールバック内で
// texture fetch を行うので、雲が無いスロットでは積雲の密度取得を条件分岐の内側へ置ける。
function IfActive(active: FloatNode, body: () => void): void {
  If(active.greaterThan(0.5), body);
}
