// 気団の出身地。各点から風上へ一定時間だけ遡り、遡った先の緯度がいまの緯度からどれだけ隔たって
// いるかを写しへ焼く。緯度は温度の代理なので、その勾配の大きさが「気団の境目がどれだけ押し縮め
// られたか」= 前線に、いまの緯度との差が暖気・寒気どちらの流入かになる。
import * as THREE from 'three/webgpu';
import { abs, float, length, normalize, vec2, vec4 } from 'three/tsl';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { BakedField } from './baked-field';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { windStep } from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 風上へ遡る時間 [s]。並の低気圧の周りの差回転(600 km で角速度 2.5e-5 rad/s)は、48 h で
// 600 km に圧縮 8.6、1500 km に 1.4 を作る — 腕は 1200〜1500 km 伸びる。腕は時間の平方根で
// 伸びるが、長く取るほど芯での 1 歩の巻きが増え、windStep の弦近似が破れて芯へ巻き込みすぎる。
const TRACE_SECONDS = 48 * 3600;

// 出身地の勾配を取る中心差分の刻み [rad]。**この刻みが前線帯の幅を決める** — 気団の境目は
// 折り畳まれて厚みを持たない面になるので、細かく取ると 1 texel の線しか残らない。実際の前線帯の
// 幅(150 km 前後)で均して、帯として読める太さにする。
const GRADIENT_STEP = 0.025;

// 単位方向における気団。compression は気団の境目の押し縮まり(何も起きていなければ 1)、
// warmth はいまの緯度と出身の緯度の差 [rad](正で暖気の流入、負で寒気の流入)。
export type AirMassSample = {
  readonly compression: FloatNode;
  readonly warmth: FloatNode;
};

export class AirMass {
  private readonly drift: BakedField;

  // projection は写しの持ち方、windAt は単位方向における追跡の風。
  public constructor(projection: FieldProjection, windAt: (direction: Vec3Node) => BalancedWind) {
    this.drift = new BakedField(
      'airMassDrift', THREE.RedFormat, projection, 1,
      (direction) => vec4(this.driftAt(direction, windAt(direction)), 0, 0, 1));
  }

  // いまの時刻の気団を写しへ焼く。at() のグラフを描く前に、気圧を焼いたあとで呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.drift.render(renderer);
  }

  // 単位方向 direction(緯度 latitude [rad])における気団。写しを中心と東西南北の 5 点読む。
  //
  // **写しが持つのは出身の緯度そのものではなく、いまの緯度からの隔たり。** 半精度の写しで
  // 絶対の緯度を持つと、量子化の刻み(|緯度| 1 rad で 1e-3)が中心差分の分母(0.02)に対して
  // 大きく、圧縮が数 % 揺らぐ。隔たりは 0 のまわりに集まるので、同じ写しで桁が細かくなる。
  // 出身の緯度の勾配は、隔たりの勾配へ緯度そのものの勾配(北向きの単位ベクトル)を足したもの。
  public at(direction: Vec3Node, latitude: FloatNode): AirMassSample {
    const east = eastAt(direction).mul(GRADIENT_STEP);
    const north = northAt(direction).mul(GRADIENT_STEP);
    const driftAt = (offset: Vec3Node): FloatNode => this.drift.at(normalize(offset)).r;
    const alongEast = driftAt(direction.add(east)).sub(driftAt(direction.sub(east))).div(2 * GRADIENT_STEP);
    const alongNorth = driftAt(direction.add(north)).sub(driftAt(direction.sub(north))).div(2 * GRADIENT_STEP);
    return {
      compression: length(vec2(alongEast, alongNorth.add(1))),
      warmth: abs(latitude).sub(abs(latitude.add(driftAt(direction)))),
    };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.drift.dispose();
  }

  // 単位方向 direction から風 wind で TRACE_SECONDS だけ風上へ遡った先の緯度と、いまの緯度の差 [rad]。
  private driftAt(direction: Vec3Node, wind: BalancedWind): FloatNode {
    const origin = normalize(direction.add(windStep(wind, direction, float(-TRACE_SECONDS)).div(R_EARTH)));
    return latitudeOf(origin).sub(latitudeOf(direction));
  }
}
