// 衛星写真から被覆率・雲頂高度・薄層雲の光学的厚みに分離した静的雲場。チャンネル構成は
// プロシージャル生成雲場と一致する。全球正距円筒画像を生成雲場と同じ RGBA basis へ変換し、
// 共有する全球の投影テクスチャとして供給する。
import * as THREE from 'three/webgpu';
import { float, int, log2, max, smoothstep, texture, vec4 } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { GPU_PASS } from '../gpu-timings';
import { CloudFieldStorage } from './cloud-field-storage';
import { equirectUvFromDirection, type FieldProjection } from '../field-projection';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudFieldSource } from './cloud-field-source';
import type { Vec3Node, Vec4Node } from '../tsl-types';
import type { CloudStateBinding } from './cloud-state';

export class ObservedCloudField implements CloudFieldSource {
  private readonly map: DeferredTexture;
  private readonly field: CloudFieldStorage;
  // 焼いたときの画像の世代と投影の版。どちらかが変わったときだけ焼き直す。
  private bakedGeneration = -1;
  private bakedRevision = -1;
  private generationValue = 0;
  private readonly stateValue: CloudStateBinding = {
    absoluteTimeSeconds: 0,
    seed: 0,
  };

  // url は地表と同じ正距円筒の旧観測画像(R = 被覆率、G = 雲頂の proxy、B = 薄い雲の光学的厚み)、
  // projection は焼き直す先の持ち方。旧 RGB は basis adapter を通してから runtime field へ入れる。
  public constructor(url: string, public readonly projection: FieldProjection) {
    this.map = new DeferredTexture(url, THREE.NoColorSpace);
    // 正距円筒の経度は周期的なので、画像は経度方向へ巻く。
    this.map.texture.wrapS = THREE.RepeatWrapping;
    const image = texture(this.map.texture);
    // **読む段は焼くときに 1 回だけ決める** — 画面微分に任せると、経度の巻き目(u が 1 から 0 へ
    // 跳ぶ列)で最も粗い段が選ばれ、日付変更線に 1 本の線が出る。画像の 1 texel が張る角は
    // pi / 画像の高さ。
    const imageHeight = float((image.size(int(0)) as THREE.Node<'uvec2'>).y);
    const lod = max(log2(projection.texelAngle.mul(imageHeight).div(Math.PI)), 0);
    const observedAt = (direction: Vec3Node): Vec4Node =>
      image.sample(equirectUvFromDirection(direction)).level(lod) as Vec4Node;
    this.field = new CloudFieldStorage(
      'observedCloud', projection,
      (direction) => {
        // 観測画像だけから相を確定しない。旧 R/G/B の被覆率・雲頂・薄雲を
        // low/middle/convective/in-situ basis へ連続変換する。
        const observed = observedAt(direction);
        const convectiveWeight = smoothstep(0.45, 0.88, observed.g);
        const middleWeight = smoothstep(0.12, 0.58, observed.g).mul(float(1).sub(convectiveWeight));
        const lowWeight = float(1).sub(middleWeight).sub(convectiveWeight);
        return vec4(
          observed.r.mul(max(lowWeight, 0)),
          observed.r.mul(max(middleWeight, 0)),
          observed.r.mul(max(convectiveWeight, 0)),
          observed.b,
        );
      },
      (direction) => {
        const observed = observedAt(direction);
        return vec4(observed.r, observed.g, 0, 1);
      },
      GPU_PASS.cloudBake,
    );
  }

  public get basisTexture(): THREE.Texture { return this.field.basisTexture; }
  public get shapeTexture(): THREE.Texture { return this.field.shapeTexture; }
  public get generation(): number { return this.generationValue; }
  public get state(): CloudStateBinding { return this.stateValue; }

  // 画像の取得を始め、届いた画像か投影の置き方が変わっていれば写しを焼き直す。
  public prepare(renderer: WebGPURenderer, _displayTime: number, gpu?: GpuTimingSink | null): void {
    this.map.request();
    const generation = this.map.generation;
    const revision = this.projection.revision;
    if (generation === this.bakedGeneration && revision === this.bakedRevision) return;
    this.bakedGeneration = generation;
    this.bakedRevision = revision;
    this.field.render(renderer, gpu ?? undefined);
    this.generationValue += 1;
  }

  // 画像と写しを解放する。
  public dispose(): void {
    this.map.dispose();
    this.field.dispose();
  }
}
