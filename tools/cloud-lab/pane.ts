// 雲の実験環境の 1 面。投影法を 1 つ決め、その持ち方で天気と雲の写しを焼き、選んだ量の色を組む。
// 表示にも写しにも同じ投影法を使うので、面を並べればそのまま図法どうしの比較になる。
import { WebGPURenderer } from 'three/webgpu';
import { createCloudField } from '../../src/render/cloud/cloud-field';
import { WeatherModel } from '../../src/render/cloud/weather-model';
import type { BakedField } from '../../src/render/cloud/baked-field';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { FieldProjection } from '../../src/render/cloud/field-projection';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';
import type { CloudLabView } from './views';

export class CloudLabPane {
  private readonly model: WeatherModel;
  private readonly cloud: BakedField;

  // projection はこの面の持ち方。climate は面どうしで共有してよい(読むだけのテクスチャ)。
  public constructor(private readonly projection: FieldProjection, private readonly climate: ClimateMap) {
    this.model = new WeatherModel(climate, projection);
    this.cloud = createCloudField(this.model, projection);
  }

  // 時刻 [s] をこの面のモデルへ写す。
  public syncTime(seconds: number): void {
    this.model.syncTime(seconds);
  }

  // いまの時刻の写しを焼く。雲の写しは、それを読むビューのときだけ焼く(気圧と移流前の湿度は
  // どのビューも読むので必ず焼く)。
  public bake(renderer: WebGPURenderer, view: CloudLabView): void {
    this.model.bake(renderer);
    if (view.readsCloud) this.cloud.render(renderer);
  }

  // この面の uv(0..1)に出す表示値 0..1 の色。投影が値を持たない範囲は黒。
  public colorAt(view: CloudLabView, uv: Vec2Node): Vec3Node {
    const direction = this.projection.directionAt(uv);
    return view.color(direction, this.model, this.climate, this.cloud).mul(this.projection.insideAt(uv));
  }
}
