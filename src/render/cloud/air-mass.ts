// 気団の出身地。各点から風上へ一定時間だけ遡り、遡った先の緯度がいまの緯度からどれだけ隔たって
// いるかと、その点の追跡の風の速さを写しへ焼く。緯度は温度の代理なので、隔たりの勾配の大きさが
// 「気団の境目がどれだけ押し縮められたか」= 前線に、いまの緯度との差が暖気・寒気どちらの流入かに
// なる。押し縮まりは追跡の風の速さで信を置く — 風の淀む所では風上が定まらず、両側の追跡が同じ点へ
// 畳み込まれるので、そこの押し縮まりは溶かして 1 へ戻す。
import * as THREE from 'three/webgpu';
import { abs, float, length, normalize, smoothstep, vec2, vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { windStep } from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 風上へ遡る時間 [s]。腕の巻きは流れの角速度 × 追跡時間 — 並の低気圧(短軸の半径 1200 km、
// 24 hPa)の半径の所で、折り目は 36 h に 0.7〜0.8 rad 巻いて浅い弧に留まる。長く取るほど巻きが
// 深まって腕が芯へ絡み、windStep の弦近似も破れるので、腕を伸ばすのは追跡ではなく低気圧の半径で行う。
const TRACE_SECONDS = 36 * 3600;

// 出身地の勾配を取る中心差分の刻み [rad]。**この刻みが前線帯の幅を決める** — 気団の境目は
// 折り畳まれて厚みを持たない面になるので、細かく取ると 1 texel の線しか残らない。実際の前線帯の
// 幅(150 km 前後)で均して、帯として読める太さにする。
const GRADIENT_STEP = 0.025;

// 圧縮を信じ始める追跡の風の速さと、そのまま信じる速さ [m/s]。前線の腕の明るい圧縮は 6 m/s 以上の
// 追跡の風の中にある(35〜60° の帯で、圧縮 3 を超える texel はほぼすべて 6 m/s 以上)。腕どうしが
// 出会って明るむ点は、低気圧を囲む閉じた流れの縁の、4 m/s 前後の淀んだ裾にある。風の淀む所では両側
// からの風上の追跡が同じ点へ畳み込まれ、圧縮を信じられない。1 を超える分を 3〜7 m/s で溶かすと、
// その点は 4 m/s で 0.16 に隠れ、腕は 6 m/s で 0.84 以上残る。
const CALM_SPEED = 3;
const WINDY_SPEED = 7;

// 単位方向における気団。compression は気団の境目の押し縮まり(何も起きていない所と、追跡の風が
// 淀んで境目を信じられない所で 1)、warmth はいまの緯度と出身の緯度の差 [rad](正で暖気の流入、
// 負で寒気の流入)。
export type AirMassSample = {
  readonly compression: FloatNode;
  readonly warmth: FloatNode;
};

export class AirMass {
  // 追跡の写し。R が出身の緯度のいまの緯度からの隔たり [rad]、G が追跡の風の速さ [m/s]。
  private readonly trace: BakedField;

  // projection は写しの持ち方、windAt は単位方向における追跡の風、surfaceRadius は気団が流れる
  // 天体の半径 [m]。
  public constructor(
    projection: FieldProjection, windAt: (direction: Vec3Node) => BalancedWind,
    private readonly surfaceRadius: number,
  ) {
    this.trace = new BakedField(
      'airMassTrace', THREE.RGFormat, projection, 1,
      (direction) => {
        const wind = windAt(direction);
        return vec4(this.driftAt(direction, wind), length(wind.velocity), 0, 1);
      });
  }

  // いまの時刻の気団を写しへ焼く。at() のグラフを描く前に、気圧を焼いたあとで呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.trace.render(renderer, gpu);
  }

  // 単位方向 direction(緯度 latitude [rad])における気団。写しを中心と東西南北の 5 点読み、中心から
  // 隔たりと風の速さを、東西南北から隔たりの勾配を取る。
  //
  // **写しが持つのは出身の緯度そのものではなく、いまの緯度からの隔たり。** 半精度の写しで
  // 絶対の緯度を持つと、量子化の刻み(|緯度| 1 rad で 1e-3)が中心差分の分母(0.02)に対して
  // 大きく、圧縮が数 % 揺らぐ。隔たりは 0 のまわりに集まるので、同じ写しで桁が細かくなる。
  // 出身の緯度の勾配は、隔たりの勾配へ緯度そのものの勾配(北向きの単位ベクトル)を足したもの。
  public at(direction: Vec3Node, latitude: FloatNode): AirMassSample {
    const east = eastAt(direction).mul(GRADIENT_STEP);
    const north = northAt(direction).mul(GRADIENT_STEP);
    const center = this.trace.at(direction);
    // 隔たりの勾配は、東西・南北それぞれの中心差分。
    const driftAt = (offset: Vec3Node): FloatNode => this.trace.at(normalize(offset)).r;
    const alongEast = driftAt(direction.add(east)).sub(driftAt(direction.sub(east))).div(2 * GRADIENT_STEP);
    const alongNorth = driftAt(direction.add(north)).sub(driftAt(direction.sub(north))).div(2 * GRADIENT_STEP);
    // 淀んだ所の押し縮まりは信じない。
    const trusted = smoothstep(CALM_SPEED, WINDY_SPEED, center.g);
    return {
      compression: length(vec2(alongEast, alongNorth.add(1))).sub(1).mul(trusted).add(1),
      warmth: abs(latitude).sub(abs(latitude.add(center.r))),
    };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.trace.dispose();
  }

  // 単位方向 direction から風 wind で TRACE_SECONDS だけ風上へ遡った先の緯度と、いまの緯度の差 [rad]。
  private driftAt(direction: Vec3Node, wind: BalancedWind): FloatNode {
    const origin = normalize(
      direction.add(windStep(wind, direction, float(-TRACE_SECONDS)).div(this.surfaceRadius)));
    return latitudeOf(origin).sub(latitudeOf(direction));
  }
}
