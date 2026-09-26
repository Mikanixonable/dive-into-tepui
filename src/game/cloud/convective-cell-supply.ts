// 対流イベントセルへ与える供給系の値を環境プロファイルから導く閉包と、
// 局所・全球の雲場が共有する高度層分けと対流ポテンシャルの散らし。
// 2つの場供給がここへ揃えることで、同じ環境入力から同じセル値が出る。

import type { CloudEnvironmentProfile } from './cloud-environment';

// 雲場が共有する高度層の分け方 [m]。質量格子・層別質量場・光学ボリュームの枠は
// 同じ層で運ばれ、層別の微物理もこの層へ合わせて置く。
export const CLOUD_MASS_LAYER_EDGES_M = [0, 1_500, 4_000, 7_000, 10_000] as const;

// 0°C の水の蒸発潜熱 [J/kg]。地表の潜熱フラックスをそのまま対流の水供給率へ換算する近似。
const LATENT_HEAT_VAPORIZATION_J_PER_KG = 2.501e6;
const MIN_CONVECTIVE_DURATION_SECONDS = 900;
const MAX_CONVECTIVE_DURATION_SECONDS = 7_200;

// セルの対流ポテンシャルの幅。均一格子にしないため種とセル番号から散らす。
export const CONVECTIVE_POTENTIAL_MIN = 0.05;
export const CONVECTIVE_POTENTIAL_RANGE = 0.8;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 環境プロファイルからセルへ与える供給系の値。
export interface ConvectiveCellSupplyValues {
  readonly upperRelativeHumidity: number;
  readonly liquidSupplyRateKgM2S: number;
  readonly convectiveDurationSeconds: number;
  readonly sourceHeightM: number;
  readonly iceReleaseHeightM: number;
}

// 環境プロファイルから、セルへ与える供給系の値を導く。雲底はパーセルの LCL(無ければ境界層
// の深さ)、氷放出高は平衡高度(無ければプロファイル上端)、供給率は潜熱フラックスの蒸発量換算、
// 対流の継続時間は雲の深さを CAPE 由来の上昇速度で渡る時間の数倍で近似する。
export function convectiveCellSupplyValues(
  environment: CloudEnvironmentProfile,
): ConvectiveCellSupplyValues {
  const topEdgeM = CLOUD_MASS_LAYER_EDGES_M[CLOUD_MASS_LAYER_EDGES_M.length - 1]!;
  const parcel = environment.parcel;
  const cloudBaseM = clamp(
    parcel.lclHeightM ?? environment.boundaryLayer.depthM,
    CLOUD_MASS_LAYER_EDGES_M[0]!, topEdgeM - 1);
  const releaseM = clamp(
    parcel.equilibriumHeightM ?? environment.levels[environment.levels.length - 1]!.heightM,
    CLOUD_MASS_LAYER_EDGES_M[0]!, topEdgeM - 1);
  const updraftMPerS = Math.sqrt(2 * Math.max(0, parcel.capeJPerKg));
  // 上昇流で雲の深さを渡る時間の約4倍を対流の一生とみなす。CAPE が小さい環境では
  // 供給の細い短命なイベントだけが残る。
  const convectiveDurationSeconds = updraftMPerS >= 0.5 && releaseM > cloudBaseM
    ? clamp(4 * (releaseM - cloudBaseM) / updraftMPerS,
      MIN_CONVECTIVE_DURATION_SECONDS, MAX_CONVECTIVE_DURATION_SECONDS)
    : MIN_CONVECTIVE_DURATION_SECONDS;
  return {
    upperRelativeHumidity: clamp(environment.upperIceMoistureFactor, 0, 1),
    liquidSupplyRateKgM2S: environment.surfaceLatentHeatFluxWPerM2
      / LATENT_HEAT_VAPORIZATION_J_PER_KG,
    convectiveDurationSeconds,
    sourceHeightM: cloudBaseM,
    iceReleaseHeightM: releaseM,
  };
}
