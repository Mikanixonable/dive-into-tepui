// 対流がどれだけ活発かを表す 0..1 の場。低周波のノイズが持つ気団の対流のしやすさと、その場の
// 上昇流から出る。凝結の側が対流の振幅へ掛ける利得で、1 で対流がそのまま乗り、0 で対流が消える。
// 値はすべて見えのための調整値。
import * as THREE from 'three/webgpu';
import { clamp, vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { CirculatingNoise, coarsenessFor } from './circulating-noise';
import type { WebGPURenderer } from 'three/webgpu';
import type { Circulation } from './circulation';
import type { FieldProjection } from './field-projection';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 気団のノイズの段(基準の角波長 1000 km、2 段で 500 km まで)と、その振れ幅。雲塊の配置
// (800 km)より粗い所から始めて、積雲の粒(80〜40 km)には届かせない — 粒より細かい所で
// 活発度が振れると、粒が消え残るのではなく 1 つ 1 つが薄まる。振れ幅は、気団だけでは活発度が
// 中間の階調に留まる高さに取る — 板と粒へ振り切るのは上昇流で、気団はそのあいだを配る。
const INSTABILITY_NOISE = [6.4, 2] as const;
const INSTABILITY_AMPLITUDE = 1;
// 上昇流が活発度へ効く利得 [per m/s] と、上昇流の無い所での活発度。並の低気圧(0.02 m/s)で
// 気団に依らず 1 へ、高気圧の吹きおろし(−0.02 m/s)で 0 へ届く。
const LIFT_ACTIVITY = 25;
const ACTIVITY_BASE = 0.5;

export class ConvectiveActivity {
  private readonly instability: BakedField;

  // circulation は気団を運ぶ流れ、projection は写しの持ち方。
  public constructor(circulation: Circulation, projection: FieldProjection) {
    const coarseness = coarsenessFor(projection, INSTABILITY_NOISE);
    const noise = new CirculatingNoise(
      circulation, ...INSTABILITY_NOISE, projection.texelAngle.mul(coarseness));
    this.instability = new BakedField(
      'instability', THREE.RedFormat, projection, coarseness,
      (direction) => vec4(noise.at(direction).mul(INSTABILITY_AMPLITUDE), 0, 0, 1));
  }

  // いまの時刻の気団を写しへ焼く。at() のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.instability.render(renderer);
  }

  // 単位方向 direction、上昇流 lift [m/s] における対流の活発度 0..1。
  public at(direction: Vec3Node, lift: FloatNode): FloatNode {
    return clamp(this.instability.at(direction).r.add(lift.mul(LIFT_ACTIVITY)).add(ACTIVITY_BASE), 0, 1);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.instability.dispose();
  }
}
