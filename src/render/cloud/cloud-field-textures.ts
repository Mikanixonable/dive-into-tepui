// 天気のモデルが凝結する雲の場を、正距円筒図法の写し 3 枚(不透明雲のスラブ 0–3 / 4–7、薄い雲)へ
// 描く。呼ばれるたびに全面を描き直す。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, vec4 } from 'three/tsl';
import { directionFromEquirectUv } from './sphere-frame';
import { condense, SLAB_COUNT } from './condensation';
import type { WeatherModel } from './weather-model';
import type { FloatNode } from '../tsl-types';

// 写しの解像度 [texel]。正距円筒なので幅は高さの 2 倍。
export const CLOUD_FIELD_WIDTH = 2048;
export const CLOUD_FIELD_HEIGHT = 1024;

export class CloudFieldTextures {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // model の雲を写すグラフを一度だけ組む。
  public constructor(model: WeatherModel) {
    this.target = new THREE.RenderTarget(CLOUD_FIELD_WIDTH, CLOUD_FIELD_HEIGHT, {
      count: 3, depthBuffer: false, samples: 0,
    });
    const [opaqueLow, opaqueHigh, translucent] = this.target.textures;
    for (const [tex, name, format] of [
      [opaqueLow!, 'opaqueLow', THREE.RGBAFormat],
      [opaqueHigh!, 'opaqueHigh', THREE.RGBAFormat],
      [translucent!, 'translucent', THREE.RedFormat],
    ] as const) {
      tex.name = name;
      tex.format = format;
      tex.type = THREE.HalfFloatType;
    }

    // texel ごとに単位方向へ写し、そこでの雲を 3 枚へ振り分ける。
    const cloud = condense(model.weatherAt(directionFromEquirectUv(screenUV)));
    if (cloud.slabs.length !== SLAB_COUNT) throw new Error(`cloud slabs must be ${SLAB_COUNT}`);
    const slab = (k: number): FloatNode => cloud.slabs[k]!;
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({
      opaqueLow: vec4(slab(0), slab(1), slab(2), slab(3)),
      opaqueHigh: vec4(slab(4), slab(5), slab(6), slab(7)),
      translucent: vec4(cloud.translucent, 0, 0, 1),
    });
    this.quad = new QuadMesh(this.material);
  }

  // rgba16f: スラブ 0..3 の不透明雲の光学的厚み。
  public get opaqueLowTexture(): THREE.Texture { return this.target.textures[0]!; }
  // rgba16f: スラブ 4..7 の不透明雲の光学的厚み。
  public get opaqueHighTexture(): THREE.Texture { return this.target.textures[1]!; }
  // r16f: 薄い雲の光学的厚み。
  public get translucentTexture(): THREE.Texture { return this.target.textures[2]!; }

  // model がいま指している時刻の雲を写しへ描く。
  public render(renderer: WebGPURenderer): void {
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する
  // 単一の板なので、ここでは解放しない。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
