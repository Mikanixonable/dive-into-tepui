// 衛星写真から被覆率・雲頂高度・薄層雲の光学的厚みに分離した静的雲場。層の構成はプロシージャル生成
// 雲場と一致し、写真から分からない形態には中庸の値を置く。読み出し側のサンプリング処理を球面キャップ
// 1枚に統一するため、全球正距円筒画像を同一仕様の球面キャップ投影テクスチャへ再投影して供給する。
import * as THREE from 'three/webgpu';
import { float, int, log2, max, texture, vec4 } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { equirectUvFromDirection, type FieldProjection } from '../field-projection';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { latitudeOf } from './sphere-frame';
import { upperCloudAltitude } from './tropopause';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudFieldSource } from './cloud-presentation';
import type { CloudFieldTextures } from './cloud-field-sampler';
import type { Vec4Node } from '../tsl-types';

// 写真から分からない形態に置く中庸の値。下層のセル性と勢い、上層の繊維性。
const NEUTRAL_CELLULARITY = 0.5;
const NEUTRAL_VIGOR = 0.5;
const NEUTRAL_FIBROUSNESS = 0.5;

export class ObservedCloudField implements CloudFieldSource {
  private readonly map: DeferredTexture;
  private readonly field: BakedField;
  // 焼いたときの画像の世代と cap の版。どちらかが変わったときだけ焼き直す。
  private bakedGeneration = -1;
  private bakedRevision = -1;
  private generationValue = 0;

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
      (direction) => {
        const photo = image.sample(equirectUvFromDirection(direction)).level(lod) as Vec4Node;
        const upperAltitude = upperCloudAltitude(latitudeOf(direction), float(0));
        return [
          vec4(photo.r, photo.g, NEUTRAL_CELLULARITY, NEUTRAL_VIGOR),
          vec4(photo.b, upperAltitude.div(CLOUD_TOP_SPAN), NEUTRAL_FIBROUSNESS, 0),
        ];
      },
      GPU_PASS.cloudBake,
    );
  }

  public get textures(): CloudFieldTextures {
    return { lower: this.field.textureAt(0), upper: this.field.textureAt(1) };
  }
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
