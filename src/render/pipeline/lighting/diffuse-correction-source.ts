// 符号付き近傍補正を拡散照度にだけ加える光源。
import type * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { contributionMaterial, type LightSource } from './light-source';
import type { DiffuseCorrection } from '../screen-space/diffuse-correction';
import type { ShadingSample } from './shading-sample';

export class DiffuseCorrectionSource implements LightSource {
  private builtMaterial: THREE.MeshBasicNodeMaterial | null = null;
  private enabled = false;

  public constructor(private readonly correction: DiffuseCorrection) {}

  public setEnabled(enabled: boolean): void { this.enabled = enabled; }

  public hasContribution(): boolean { return this.enabled; }

  // 同じ signed target をライトプリパスの拡散だけへ加算する。面の無い画素は contributionMaterial が除く。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.builtMaterial ??= contributionMaterial(sample, {
      diffuse: this.correction.at(sample), specular: vec3(0),
    });
    return this.builtMaterial;
  }

  // 遅延生成した加算マテリアルを解放する。
  public dispose(): void { this.builtMaterial?.dispose(); }
}
