// 焼いた気圧の場と、そこから取る接ベクトルの勾配・等圧線方向の曲がり。気圧の偏差は
// 大循環の気圧帯・循環ノイズ・低気圧の谷・高気圧の丘の和として利用側が組み、ここへ焼く。
import * as THREE from 'three/webgpu';
import { cos, normalize, sin, vec4 } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { CLOUD_TUNING } from './cloud-tuning';
import { isobarAt } from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 気圧フィールドからサンプリングした、風向風速の算出に必要な物理量。gradient は気圧勾配の
// 接ベクトル [hPa/rad]、isobar は等圧線方向の単位接ベクトル、bend は等圧線方向の
// 2 階微分 [hPa/rad²]。
export interface PressureSample {
  readonly pressure: FloatNode;
  readonly gradient: Vec3Node;
  readonly isobar: Vec3Node;
  readonly bend: FloatNode;
}

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。緯度の 6 倍の余弦なので、緯度に
// ついての微分は sin(6 φ) × 6 × 振幅 [hPa/rad]。
const PRESSURE_BAND_AMPLITUDE = CLOUD_TUNING.pressureBandAmplitude;

// 緯度 latitude [rad] における大循環の気圧帯の偏差 [hPa]。
export function pressureBandAt(latitude: FloatNode): FloatNode {
  return cos(latitude.mul(6)).mul(PRESSURE_BAND_AMPLITUDE.mul(-1));
}

// 緯度 latitude [rad] における大循環の気圧帯の北向きの勾配 [hPa/rad]。気団の追跡の風を解く
// ときに気圧帯のぶんを勾配から差し引く — 帯を残すと、収束する緯度に緯線に沿った圧縮の環が立つ。
export function pressureBandSlopeAt(latitude: FloatNode): FloatNode {
  return sin(latitude.mul(6)).mul(PRESSURE_BAND_AMPLITUDE.mul(6));
}

// 気圧の勾配を取る中心差分の刻み [rad]。台風の芯の広がり(250 km ≈ 0.039 rad)より細かく、
// 気圧の写しの 1 texel より粗い。写しは視点中心の cap なので texel の角は視点の高さで変わるが、
// いちばん粗い置き方(半径 π/2)でも 2/512 ≈ 3.9e-3 rad で、この刻みを越えない。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取るサンプリング刻み [rad]。半精度テクスチャにおける 2 階差分の量子化ノイズは刻みの二乗で
// 増幅される。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;

export class PressureField {
  private readonly field: BakedField;

  // projection は写しの持ち方、source は単位方向での気圧の偏差 [hPa]。
  public constructor(
    projection: FieldProjection, source: (direction: Vec3Node) => FloatNode,
  ) {
    this.field = new BakedField(
      'pressure', THREE.RedFormat, projection, (direction) => vec4(source(direction), 0, 0, 1),
      GPU_PASS.cloudBake);
  }

  // 現在時刻の気圧を写しへ焼く。気圧の写しを読んで遡る気団より先に焼く。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
  }

  // 単位方向 direction(接平面の東 east・北 north)における気圧と、その勾配・等圧線方向の曲がり。
  public at(direction: Vec3Node, east: Vec3Node, north: Vec3Node): PressureSample {
    const pressure = this.field.at(direction).r;
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.field.at(normalize(direction.add(eastStep))).r;
    const pressureWest = this.field.at(normalize(direction.sub(eastStep))).r;
    const pressureNorth = this.field.at(normalize(direction.add(northStep))).r;
    const pressureSouth = this.field.at(normalize(direction.sub(northStep))).r;
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);
    // 曲がりは等圧線に沿って測る — 勾配の向きに測ると、谷の深さそのものを曲率として検出してしまう。
    const isobar = isobarAt(direction, gradient);
    const isobarStep = isobar.mul(BEND_STEP);
    const pressureAhead = this.field.at(normalize(direction.add(isobarStep))).r;
    const pressureBehind = this.field.at(normalize(direction.sub(isobarStep))).r;
    const bend = pressureAhead.add(pressureBehind).sub(pressure.mul(2)).div(BEND_STEP ** 2);
    return { pressure, gradient, isobar, bend };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
