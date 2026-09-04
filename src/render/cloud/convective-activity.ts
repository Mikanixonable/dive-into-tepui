// 対流がどれだけ活発かを表す 0..1 の場。低周波のノイズが持つ気団の対流のしやすさと、その場の
// 上昇流と、寒気の流入から出る — 冷たい空気が暖かい面の上を渡るところは不安定で、雲は粒へ千切れる。
// 凝結の側が対流の振幅へ掛ける利得で、1 で対流がそのまま乗り、0 で対流が消える。**床から下へは
// 落とさない** — 一枚板として覆う空にも細胞の起伏はあり、活発度が 0 まで落ちた所は平坦な灰色になる。
// 値はすべて見えのための調整値。
import * as THREE from 'three/webgpu';
import { clamp, vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { CirculatingNoise, coarsenessFor } from './circulating-noise';
import type { WebGPURenderer } from 'three/webgpu';
import type { NoiseOctave } from './circulating-noise';
import type { Circulation } from './circulation';
import type { FieldProjection } from './field-projection';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 気団のノイズの段の表と、その振れ幅。雲塊の配置(800 km)より粗い所から始めて、積雲の粒
// (80〜40 km)には届かせない — 粒より細かい所で活発度が振れると、粒が消え残るのではなく
// 1 つ 1 つが薄まる。振れ幅は、気団だけでは活発度が中間の階調に留まる高さに取る — 板と粒へ
// 振り切るのは上昇流と気団の流入で、ノイズはそのあいだを配る。
const INSTABILITY_NOISE: readonly NoiseOctave[] = [
  { frequency: 6.4, amplitude: 1 }, // 1000 km
  { frequency: 12.8, amplitude: 0.65 }, // 500 km
];
const INSTABILITY_AMPLITUDE = 0.8;
// 上昇流が活発度へ効く利得 [per m/s] と、上昇流の無い所での活発度。並の低気圧(0.02 m/s)で
// 気団に依らず 1 へ、高気圧の吹きおろし(−0.02 m/s)で床へ届く。
const LIFT_ACTIVITY = 25;
const ACTIVITY_BASE = 0.5;
// 寒気の流入が活発度へ効く利得 [per rad] と、活発度の床。並の寒気の吹き出し(−0.35 rad)で
// 活発度が半分ぶん上がる高さに取る。
const COLD_ACTIVITY = 1.4;
const ACTIVITY_MIN = 0.3;
// 陸の上で上がる分。日射で温まる地面の上は不安定で、雲は板ではなく粒になる。
const LAND_ACTIVITY = 0.3;

export class ConvectiveActivity {
  private readonly instability: BakedField;

  // circulation は気団を運ぶ流れ、projection は写しの持ち方。
  public constructor(circulation: Circulation, projection: FieldProjection) {
    const coarseness = coarsenessFor(projection, INSTABILITY_NOISE);
    const noise = new CirculatingNoise(circulation, INSTABILITY_NOISE, projection.texelAngle.mul(coarseness));
    this.instability = new BakedField(
      'instability', THREE.RedFormat, projection, coarseness,
      (direction) => vec4(noise.at(direction).mul(INSTABILITY_AMPLITUDE), 0, 0, 1));
  }

  // いまの時刻の気団を写しへ焼く。at() のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.instability.render(renderer);
  }

  // 単位方向 direction、上昇流 lift [m/s]、暖気の流入 warmth [rad](負で寒気)、陸らしさ land
  // 0..1 における対流の活発度 0..1。
  public at(direction: Vec3Node, lift: FloatNode, warmth: FloatNode, land: FloatNode): FloatNode {
    return clamp(
      this.instability.at(direction).r.add(lift.mul(LIFT_ACTIVITY)).sub(warmth.mul(COLD_ACTIVITY))
        .add(land.mul(LAND_ACTIVITY)).add(ACTIVITY_BASE), ACTIVITY_MIN, 1);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.instability.dispose();
  }
}
