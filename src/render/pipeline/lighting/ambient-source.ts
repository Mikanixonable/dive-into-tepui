// 方向を持たない環境光の寄与。地球照の代用の暫定値で、向きを持たないので遮蔽も受けない。
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import type { SunLight } from '../sun-light';
import { contributionMaterial, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';

export class AmbientSource implements LightSource {
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  constructor(private readonly sunLight: SunLight) {}

  hasContribution(): boolean { return true; }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, {
      diffuse: vec3(this.sunLight.ambientColor.mul(this.sunLight.ambientIntensity)),
      specular: vec3(0),
    });
    return this.cached;
  }

  dispose(): void {
    this.cached?.dispose();
  }
}
