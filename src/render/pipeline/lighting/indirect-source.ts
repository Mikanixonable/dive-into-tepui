// 照り返しの光源。近くの明るい面と自己発光する面が返す光を、拡散の光として足す。
import type * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { contributionMaterial, type LightSource } from './light-source';
import type { ScreenSpaceLight } from '../screen-space/screen-space-light';
import type { ShadingSample } from './shading-sample';

export class IndirectSource implements LightSource {
  // 初回の material() で組む。
  private builtMaterial: THREE.MeshBasicNodeMaterial | null = null;
  // 描画設定「遮蔽と照り返し」が照り返しを集めるか。
  private enabled = false;

  // screenSpaceLight は近くの面が返す光の放射照度の読み口。
  public constructor(private readonly screenSpaceLight: ScreenSpaceLight) {}

  // 描画設定「遮蔽と照り返し」が照り返しを集めるかを設定する。
  public setEnabled(enabled: boolean): void { this.enabled = enabled; }

  public hasContribution(): boolean { return this.enabled; }

  // 照り返しの寄与のマテリアル。初回だけ組む。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.builtMaterial ??= contributionMaterial(sample, {
      diffuse: this.screenSpaceLight.indirect(sample),
      specular: vec3(0),
    });
    return this.builtMaterial;
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    this.builtMaterial?.dispose();
  }
}
