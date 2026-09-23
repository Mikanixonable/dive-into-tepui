// 衛星写真から液相被覆率・雲頂高度・上層氷雲の光学的厚み・氷雲中心高度に分離した静的雲場。
// チャンネル構成はプロシージャル生成雲場と一致する。読み出し側のサンプリング処理を球面キャップ1枚に統一するため、
// 全球正距円筒画像を同一仕様の球面キャップ投影テクスチャへ再投影して供給する。
import * as THREE from 'three/webgpu';
import { float, int, log2, max, texture } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { equirectUvFromDirection, type FieldProjection } from '../field-projection';
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
  private generationValue = 0;

  // url は地表と同じ正距円筒の雲場画像(R = 液相被覆率、G = 雲頂高度/CLOUD_TOP_SPAN、
  // B = 上層氷雲の鉛直光学深さ、A = 氷雲中心高度/CLOUD_TOP_SPAN)。従来画像のA=1は15kmとして
  // 解釈できるので旧素材も同じ契約で読める。projection は焼き直す先の持ち方。
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
      GPU_PASS.cloudBake,
    );
  }

  public get texture(): THREE.Texture { return this.field.texture; }
  public get generation(): number { return this.generationValue; }

  // 画像の取得を始め、届いた画像か cap の置き方が変わっていれば写しを焼き直す。
  public prepare(renderer: WebGPURenderer, _displayTime: number, gpu?: GpuTimingSink): void {
    this.map.request();
    const generation = this.map.generation;
    const revision = this.projection.revision;
    if (generation === this.bakedGeneration && revision === this.bakedRevision) return;
    this.bakedGeneration = generation;
    this.bakedRevision = revision;
    this.field.render(renderer, gpu);
    this.generationValue += 1;
  }

  // 画像と写しを解放する。
  public dispose(): void {
    this.map.dispose();
    this.field.dispose();
  }
}
