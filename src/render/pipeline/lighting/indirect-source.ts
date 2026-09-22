// 照り返しの光源。近くの明るい面と自己発光する面が返す光を、拡散の光として足す。
import type * as THREE from 'three/webgpu';
import { texture, vec3 } from 'three/tsl';
import { contributionMaterial, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';

export class IndirectSource implements LightSource {
  // 初回の material() で組む。
  private builtMaterial: THREE.MeshBasicNodeMaterial | null = null;
  // 描画設定「遮蔽と照り返し」が照り返しを集めるか。
  private enabled = false;

  // indirectTexture は全解像度の照り返しの放射照度(rgb、SUN_IRRADIANCE_1AU の目盛り)。
  public constructor(private readonly indirectTexture: THREE.Texture) {}

  // 描画設定「遮蔽と照り返し」が照り返しを集めるかを設定する。
  public setEnabled(enabled: boolean): void { this.enabled = enabled; }

  public hasContribution(): boolean { return this.enabled; }

  // 照り返しの寄与のマテリアル。初回だけ組む。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.builtMaterial ??= contributionMaterial(sample, {
      diffuse: texture(this.indirectTexture, sample.uv).rgb,
      specular: vec3(0),
    });
    return this.builtMaterial;
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    this.builtMaterial?.dispose();
  }
}
