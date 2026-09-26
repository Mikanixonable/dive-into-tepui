// 雲の実験環境の 1 面。両面が共有する全球の生成雲場と診断場を、自分の投影の uv を方向へ
// 戻してから読み、選んだ量の色を組む。面を並べればそのまま図法どうしの比較になる。
import type * as THREE from 'three/webgpu';
import type { FieldProjection } from '../../src/render/field-projection';
import type { Vec2Node, Vec3Node } from '../../src/render/tsl-types';
import type { CloudLabGlobalField } from './global-field';
import type { CloudLabView } from './views';

export class CloudLabPane {
  // projection はこの面が張る投影、photo は面どうしで共有してよい(読むだけのテクスチャ)、
  // shared は生成雲場と CPU 診断場を持つ共有の実体。
  public constructor(
    private readonly projection: FieldProjection,
    private readonly photo: THREE.Texture,
    private readonly shared: CloudLabGlobalField,
  ) {}

  // この面の uv(0..1)に出す表示値 0..1 の色。投影が値を持たない範囲は黒。
  public colorAt(view: CloudLabView, uv: Vec2Node): Vec3Node {
    const direction = this.projection.directionAt(uv);
    const color = view.reads === 'cloud' ? view.color(direction, this.shared.cloudAt)
      : view.reads === 'photo' ? view.color(direction, this.photo)
      : view.reads === 'climate' ? view.color(direction, this.shared.climateMap)
      : view.reads === 'wind' ? view.color(direction, this.shared.windField)
      : view.reads === 'diagnostic' ? view.color(direction, this.shared.diagnosticAt(direction))
      : view.color(direction, this.shared.massAt(direction));
    return color.mul(this.projection.insideAt(uv));
  }
}
