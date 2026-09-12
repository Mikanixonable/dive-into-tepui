// 雲の実験環境の 1 面。地球の生成雲場を 1 つ持ち、その場の投影で面を張って、選んだ量の色を組む。
// 表示にも写しにも場の投影を使うので、面を並べればそのまま図法どうしの比較になる。
import type * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { GeneratedCloudField } from '../../src/render/cloud/generated-cloud-field';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';
import type { CloudLabView } from './views';

export class CloudLabPane {
  // field はこの面が焼いて見せる雲場。photo は面どうしで共有してよい(読むだけのテクスチャ)。
  public constructor(private readonly field: GeneratedCloudField, private readonly photo: THREE.Texture) {}

  // この面が読む気候。画像が届くのを待つのに要る。
  public get climate(): ClimateMap { return this.field.climateMap; }

  // 表示時刻 seconds [s] の場を焼く。
  public bake(renderer: WebGPURenderer, seconds: number): void {
    this.field.prepare(renderer, seconds);
  }

  // この面の uv(0..1)に出す表示値 0..1 の色。投影が値を持たない範囲は黒。
  public colorAt(view: CloudLabView, uv: Vec2Node): Vec3Node {
    const projection = this.field.fieldProjection;
    const direction = projection.directionAt(uv);
    const color = view.reads === 'cloud' ? view.color(direction, this.field.sampler)
      : view.reads === 'photo' ? view.color(direction, this.photo)
      : view.color(direction, this.field.weatherModel, this.field.climateMap);
    return color.mul(projection.insideAt(uv));
  }
}
