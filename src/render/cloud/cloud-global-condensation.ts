// 全球の層別・相別質量場 [kg/m²] を雲標本(被覆率・雲頂高度・薄い雲の光学的厚み)へ凝結する。
// 供給が CPU の配列で届くので、全セルの標本も CPU の配列として組む。質量から可視光の
// 光学厚 τ までは physics のバルク閉包に従い、列の消散を「不透明な被覆」と「薄い部分」へ
// 分けるのがここの写像である。

import { iceOpticalDepth, liquidOpticalDepth } from '../../physics/cloud-optical-closures';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { validateCloudGlobalMassField } from './global-mass-field';
import type { CloudGlobalMassField } from './global-mass-field';

// 液水・氷の有効粒径 [m] と氷の消散効率。粒径は層で分けず一定 — 海洋性の水雲・氷雲の
// 代表値に取る。層別の粒径が要る設計が入ったらここも層別へ変える。
const LIQUID_EFFECTIVE_RADIUS_M = 10e-6;
const ICE_EFFECTIVE_RADIUS_M = 30e-6;
const ICE_EXTINCTION_EFFICIENCY = 2;

// 未解像の被覆率へ写す雲内の柱光学厚 [無次元]。セル平均の消散 τ を、雲内 τ の部分被覆
// f = 1 − exp(−τ/τ_c) とみなす。τ_c は雲内の列消散の代表値で、海洋性層雲の LWP
// (~0.1 kg/m² → τ ≈ 15)から取る — τ=τ_c で被覆 63%、τ=3τ_c で 95%。
const IN_CLOUD_OPTICAL_DEPTH = 15;

// 層を薄い側へ数える重みの τ 尺度 [無次元]。層 τ がこれより小さいほど薄い雲へ、
// 大きいほど不透明な被覆へ寄る。層 τ = 0.3 で 74% が薄い側、τ = 3 で 5%。
const TAU_THIN_SCALE = 1;

// 雲頂を決める層 τ の下限 [無次元]。これ以下の層は質量が存在するとみなさない —
// 透過率 95% 以上の層を雲頂としては数えない。
const TAU_PRESENT = 0.05;

// 薄い雲の光学的厚みの上限 [無次元]。薄い雲は不透明にならず、下地が常に e^−τ だけ
// 透ける。tanh の頭打ちで τ をここへ漸近させる。
const TRANSLUCENT_TAU_LIMIT = 0.63;

// CPU 側の雲標本。単位とチャンネルの意味は CloudSample と同じ(coverage・translucent は
// 無次元、cloudTopM は m)。
export interface GlobalColumnSample {
  readonly coverage: number;
  readonly cloudTopM: number;
  // 薄い雲の光学的厚み τ。
  readonly translucent: number;
}

// 層の列質量 [kg/m²] を液水・氷あわせた消散 τ へ写す。
function columnTau(liquidKgM2: number, iceKgM2: number): number {
  return liquidOpticalDepth(liquidKgM2, LIQUID_EFFECTIVE_RADIUS_M)
    + iceOpticalDepth(iceKgM2, ICE_EFFECTIVE_RADIUS_M, ICE_EXTINCTION_EFFICIENCY);
}

// 層別の消散 τ の列から雲標本を組む。各層の τ を薄い重みで不透明側と薄い側へ分け
// (τ_opaque + τ_thin = 総 τ で保存)、雲頂は τ が閾値を超える最上層の上端とする。
function condenseColumnTaus(
  layerTaus: readonly number[], layerEdgesM: readonly number[],
): GlobalColumnSample {
  let opaqueTau = 0;
  let thinTau = 0;
  let cloudTopM = 0;
  for (const [layerIndex, tau] of layerTaus.entries()) {
    const thinWeight = Math.exp(-tau / TAU_THIN_SCALE);
    opaqueTau += tau * (1 - thinWeight);
    thinTau += tau * thinWeight;
    if (tau > TAU_PRESENT) cloudTopM = layerEdgesM[layerIndex + 1]!;
  }
  return {
    coverage: 1 - Math.exp(-opaqueTau / IN_CLOUD_OPTICAL_DEPTH),
    cloudTopM,
    translucent: Math.tanh(thinTau / TRANSLUCENT_TAU_LIMIT) * TRANSLUCENT_TAU_LIMIT,
  };
}

// 1 列ぶんの層別・相別質量 [kg/m²] を凝結する。配列の長さは層数(layerEdgesM - 1)に一致すること。
export function condenseGlobalColumn(
  liquidKgM2ByLayer: readonly number[],
  iceKgM2ByLayer: readonly number[],
  layerEdgesM: readonly number[],
): GlobalColumnSample {
  const layerCount = layerEdgesM.length - 1;
  if (liquidKgM2ByLayer.length !== layerCount || iceKgM2ByLayer.length !== layerCount) {
    throw new RangeError('column mass arrays must match the layer count');
  }
  const layerTaus = new Array<number>(layerCount);
  for (let index = 0; index < layerCount; index += 1) {
    layerTaus[index] = columnTau(liquidKgM2ByLayer[index]!, iceKgM2ByLayer[index]!);
  }
  return condenseColumnTaus(layerTaus, layerEdgesM);
}

// 全球の質量場を全セルぶん凝結し、焼き込み用の RGBA 配列へ載せる。返す配列は
// width × height × 4 で、行 0 が北極側 — 場のセル配置のままなので、DataTexture
// (flipY なし、v=0 が行 0)へそのまま渡せる。チャンネルは cloud-field-sample.ts の
// 配置と同じ(R=被覆率、G=雲頂/CLOUD_TOP_SPAN、B=薄い雲の τ、A=1)。
export function condenseGlobalMassField(field: CloudGlobalMassField): Float32Array {
  validateCloudGlobalMassField(field);
  const layerCount = field.layerEdgesM.length - 1;
  const cellCount = field.width * field.height;
  const texels = new Float32Array(cellCount * 4);
  const layerTaus = new Array<number>(layerCount);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
      const index = layerIndex * cellCount + cellIndex;
      layerTaus[layerIndex] = columnTau(field.liquidKgM2[index]!, field.iceKgM2[index]!);
    }
    const sample = condenseColumnTaus(layerTaus, field.layerEdgesM);
    const texel = cellIndex * 4;
    texels[texel] = sample.coverage;
    texels[texel + 1] = Math.min(Math.max(sample.cloudTopM / CLOUD_TOP_SPAN, 0), 1);
    texels[texel + 2] = sample.translucent;
    texels[texel + 3] = 1;
  }
  return texels;
}
