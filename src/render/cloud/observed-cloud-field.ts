// 衛星写真から被覆率・雲頂高度・薄い雲の光学的厚みへ分けた、表示時刻によらない雲場。成分の並びは
// 生成した雲場と同じ。
import * as THREE from 'three/webgpu';
import { DeferredTexture } from '../deferred-texture';
import { CloudFieldSampler } from './cloud-field-sampler';
import type { CloudFieldSource } from './cloud-presentation';

export class ObservedCloudField implements CloudFieldSource {
  private readonly map: DeferredTexture;
  private readonly fieldSampler: CloudFieldSampler;
  // sampler へ最後に差し込んだときの画像の世代。
  private sampledGeneration: number;

  // url は地表と同じ正距円筒の雲場画像(R = 被覆率、G = 雲頂高度、B = 薄い雲の光学的厚み)。
  public constructor(url: string) {
    this.map = new DeferredTexture(url, THREE.NoColorSpace);
    // 正距円筒の経度は周期的なので、場は経度方向へ巻く。
    this.map.texture.wrapS = THREE.RepeatWrapping;
    this.fieldSampler = new CloudFieldSampler(this.map.texture);
    this.sampledGeneration = this.map.generation;
  }

  public get texture(): THREE.Texture { return this.map.texture; }
  public get sampler(): CloudFieldSampler { return this.fieldSampler; }

  // 画像の取得を始め、届いていれば読める mip 段を画像の寸法から引き直す。
  public prepare(): void {
    this.map.request();
    if (this.map.generation === this.sampledGeneration) return;
    this.sampledGeneration = this.map.generation;
    this.fieldSampler.setTexture(this.map.texture);
  }

  // 画像のテクスチャを解放する。
  public dispose(): void { this.map.dispose(); }
}
