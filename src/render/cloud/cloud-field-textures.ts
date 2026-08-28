// 天気のモデルが凝結する雲の場(鉛直光学的厚み・雲頂)を、正距円筒図法の写しへ描く。時刻を渡す
// たびに全面を描き直す。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, vec4 } from 'three/tsl';
import { directionFromEquirectUv } from './sphere-frame';
import type { WeatherModel } from './weather-model';

// 写しの解像度 [texel]。正距円筒なので幅は高さの 2 倍。
export const CLOUD_FIELD_WIDTH = 2048;
export const CLOUD_FIELD_HEIGHT = 1024;

export class CloudFieldTextures {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // model の雲を写すグラフを一度だけ組む。時刻は render() のたびに受ける。
  public constructor(private readonly model: WeatherModel) {
    this.target = new THREE.RenderTarget(CLOUD_FIELD_WIDTH, CLOUD_FIELD_HEIGHT, {
      count: 1, depthBuffer: false, samples: 0,
    });
    const fieldTex = this.target.textures[0]!;
    fieldTex.name = 'field';
    fieldTex.format = THREE.RGFormat;
    fieldTex.type = THREE.HalfFloatType;

    // texel ごとに単位方向へ写し、そこでの雲を書く。
    const cloud = model.condense(model.weatherAt(directionFromEquirectUv(screenUV)));
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({ field: vec4(cloud.opticalDepth, cloud.top, 0, 1) });
    this.quad = new QuadMesh(this.material);
  }

  // rg16f: r = 鉛直光学的厚み、g = 雲頂の高さ 0..1。
  public get fieldTexture(): THREE.Texture { return this.target.textures[0]!; }

  // 時刻 [s] の雲を写しへ描く。
  public render(renderer: WebGPURenderer, seconds: number): void {
    this.model.syncTime(seconds);
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
