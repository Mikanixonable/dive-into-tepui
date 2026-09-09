// 積雲の恒星方向透過率を、共有CloudVolumeの密度から積分する。cloudTop/inside割合は使わず、
// 大気と不透明表面と同じ連続密度を固定タップで評価する。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, clamp, dot, exp, float, max, normalize, uniform, vec4,
} from 'three/tsl';
import { CloudFieldSampler, type CloudLodMode } from '../../cloud/cloud-field-sampler';
import { CloudVolume } from '../../cloud/cloud-volume';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { SunLight } from '../sun-light';

export interface ShadowCumulus {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly axes: THREE.Vector3;
  readonly topAltitude: number;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly field: THREE.Texture;
}

const SHADOW_TAPS = 8;
const MAX_LIGHT_PATH = 3e5;
const STEP_BLUR = 2;

export class CloudShadowRenderer {
  private readonly center: Vec3Uniform;
  private readonly surfaceRadius: FloatUniform;
  private readonly axes: Vec3Uniform;
  private readonly topAltitude: FloatUniform;
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  private readonly fieldSampler = new CloudFieldSampler();
  private readonly volume: CloudVolume;

  constructor(private readonly sunLight: SunLight) {
    this.center = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);
    this.axes = uniform(new THREE.Vector3(1, 1, 1));
    this.topAltitude = uniform(0);
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
    this.volume = new CloudVolume(this.fieldSampler);
  }

  set(cumulus: ShadowCumulus | null): void {
    this.active.value = cumulus === null ? 0 : 1;
    if (cumulus === null) return;
    this.center.value.copy(cumulus.center);
    this.surfaceRadius.value = cumulus.surfaceRadius;
    this.axes.value.copy(cumulus.axes);
    this.topAltitude.value = cumulus.topAltitude;
    this.bodyFromWorld.value.copy(cumulus.bodyFromWorld);
    this.fieldSampler.setTexture(cumulus.field);
  }

  casts(): boolean { return this.active.value > 0; }

  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.fieldSampler.setLodSampling(mode, fixedLevel);
  }

  // worldPosから恒星までの光路を、雲の上端または最大光路までSHADOW_TAPSで積分する。
  // 密度[1/m]×実距離[m]がtauとなり、最終的な透過率はexp(-tau)である。
  transmittance(worldPos: Vec3Node, footprint: FloatNode): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    return Fn(() => {
      const result = float(1).toVar();
      If(this.active.greaterThan(0.5), () => {
        const bodyRadius = max(this.surfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.center));
        const rayDir = normalize(this.toShellSpace(sunDir));
        const along = dot(offset, rayDir);
        const shellRadius = float(1).add(this.topAltitude.div(bodyRadius));
        const pathInShell = max(
          shellRadius.mul(shellRadius).sub(dot(offset, offset)).add(along.mul(along)), 0,
        ).sqrt().sub(along);
        const path = clamp(pathInShell.mul(bodyRadius), 0, MAX_LIGHT_PATH);
        const stepLength = path.div(SHADOW_TAPS);
        const sampleWidth = max(footprint, stepLength.mul(STEP_BLUR));
        const opticalDepth = float(0).toVar();
        Loop({ start: 0, end: SHADOW_TAPS, type: 'int', condition: '<' }, ({ i }) => {
          const sampleOffset = offset.add(rayDir.mul(stepLength.div(bodyRadius)
            .mul(float(i).add(0.5))));
          const bodyOffset = sampleOffset.mul(bodyRadius);
          const density = this.volume.densityAt(
            bodyOffset, bodyRadius, sampleWidth,
          ).cumulus;
          opticalDepth.addAssign(density.mul(stepLength));
        });
        result.assign(exp(opticalDepth.negate()));
      });
      return result;
    })();
  }

  private toShellSpace(worldVec: Vec3Node): Vec3Node {
    return this.bodyFromWorld.mul(vec4(worldVec, 0)).xyz.div(this.axes);
  }
}
