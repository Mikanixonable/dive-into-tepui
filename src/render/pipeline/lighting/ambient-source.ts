// 方向を持たない環境光の寄与。強さは天体照のスロットの総和から取る(向きはまだ持たない)。
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { contributionMaterial, type LightSource } from './light-source';
import type { PlanetLightSource } from './planet-light-source';
import type { ShadingSample } from './shading-sample';

export class AmbientSource implements LightSource {
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  constructor(private readonly planetLight: PlanetLightSource) {}

  hasContribution(): boolean { return true; }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, {
      diffuse: this.planetLight.ambientIrradiance(sample),
      specular: vec3(0),
    });
    return this.cached;
  }

  dispose(): void {
    this.cached?.dispose();
  }
}
