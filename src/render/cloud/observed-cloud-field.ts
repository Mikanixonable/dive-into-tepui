// 衛星写真から被覆率・雲頂高度・薄い雲の光学的厚みへ分けた、表示時刻によらない雲場。成分の並びは
// 生成した雲場と同じ。読み手の契約を cap 1 つにするため、全球の画像は生成側と同じ cap の写しへ
// 焼き直して渡す。
import * as THREE from 'three/webgpu';
import { float, int, log2, max, texture } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { BakedField } from './baked-field';
import { equirectUvFromDirection, type FieldProjection } from './field-projection';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudFieldSource } from './cloud-presentation';
import type { Vec4Node } from '../tsl-types';

export class ObservedCloudField implements CloudFieldSource {
  private readonly map: DeferredTexture;
  private readonly field: BakedField;
  // 焼いたときの画像の世代と cap の版。どちらかが変わったときだけ焼き直す。
  private bakedGeneration = -1;
  private bakedRevision = -1;

  // url は地表と同じ正距円筒の雲場画像(R = 被覆率、G = 雲頂高度、B = 薄い雲の光学的厚み)、
  // projection は焼き直す先の持ち方。
  public constructor(url: string, private readonly projection: FieldProjection) {
    this.map = new DeferredTexture(url, THREE.NoColorSpace);
    // 正距円筒の経度は周期的なので、画像は経度方向へ巻く。
    this.map.texture.wrapS = THREE.RepeatWrapping;
    const image = texture(this.map.texture);
    // **読む段は焼くときに 1 回だけ決める** — 画面微分に任せると、経度の巻き目(u が 1 から 0 へ
    // 跳ぶ列)で最も粗い段が選ばれ、日付変更線に 1 本の線が出る。画像の 1 texel が張る角は
    // pi / 画像の高さ。
    const imageHeight = float((image.size(int(0)) as THREE.Node<'uvec2'>).y);
    const lod = max(log2(projection.texelAngle.mul(imageHeight).div(Math.PI)), 0);
    this.field = new BakedField(
      'observedCloud', THREE.RGBAFormat, projection,
      (direction) => image.sample(equirectUvFromDirection(direction)).level(lod) as Vec4Node,
    );
  }

  public get texture(): THREE.Texture { return this.field.texture; }

  // 画像の取得を始め、届いた画像か cap の置き方が変わっていれば写しを焼き直す。
  public prepare(renderer: WebGPURenderer, _displayTime: number, gpu?: GpuTimingSink): void {
    this.map.request();
    const generation = this.map.generation;
    const revision = this.projection.revision;
    if (generation === this.bakedGeneration && revision === this.bakedRevision) return;
    this.bakedGeneration = generation;
    this.bakedRevision = revision;
    this.field.render(renderer, gpu);
  }

  // 画像と写しを解放する。
  public dispose(): void {
    this.map.dispose();
    this.field.dispose();
  }
}
