// 雲の生成モデルの調整値。気象モデル・移流・凝結・対流の活発度が読む「見えのための調整値」を
// uniform として1箇所へ集約し、実験環境(cloud-lab)がスライダーで値を動かせるようにする。
// 値はグラフを組んだあとでも uniform の .value へ書けば次の焼き直しに乗る。
// **ゲームでは既定値のまま動く** — 書き換えるのは実験環境だけで、ここを読むコードは
// 値が変わりうることを前提にしない。
import { uniform } from 'three/tsl';
import type { FloatUniform } from '../../tsl-types';

// 調整値の既定値と並び。実験環境はこの表から初期値・リセット値・スライダーの対象を引く。
// 各値がモデルのどこへ効くかは、参照しているモジュールのコメントが持つ。
export const CLOUD_TUNING_DEFAULTS = {
  // weather-transport.ts — 移流前の湿度の基準と振れ幅
  surfaceHumidityBase: 0.435,
  upperHumidityBase: 0.42,
  surfaceHumidityNoiseAmplitude: 0.5625,
  // 足した段を解像しない全球の写しの振れ幅を、足す前と同じに保つ補正込みの値。
  upperHumidityNoiseAmplitude: 0.65625 * (1.84 + 0.14 + 0.09) / 1.84,
  convectionNoiseAmplitude: 0.30,
  upperAdvection: 1.6,
  convectionAdvection: 1.3,
  convectionWinding: 2.5,
  // weather-model.ts — 気圧・上昇流
  pressureNoiseAmplitude: 18,
  pressureBandAmplitude: 8,
  pressureLiftGain: 0.02,
  pressureLiftScale: 27,
  liftLimit: 0.06,
  terrainLiftGain: 0.35,
  // weather-model.ts — 帯(前線・雨帯)
  frontOnset: 1.65,
  frontWidth: 0.35,
  rainbandOnset: 5,
  rainbandWidth: 4,
  bandLift: 0.06,
  bandHumidity: 0.1,
  // weather-model.ts — 上昇源(平地の過渡源・日射加熱・地形性上昇)とプルームの減衰
  transientGain: 0.3,
  transientActivityOnset: 0.62,
  transientActivityFull: 0.85,
  landHeatingGain: 0.4,
  orographicGain: 2,
  plumeDecaySeconds: 6 * 3600,
  // weather-model.ts — 湿度への寄与
  surfaceSubsidenceDrying: 1.0,
  upperLiftHumidity: 0.7,
  upperSubsidenceDrying: 2,
  vortexContrast: 1.0,
  warmHumidity: 0.6,
  anvilHumidity: 0.2,
  surfaceEyeDryness: 0.8,
  upperEyeDryness: 2,
  surfaceMeanCloudinessWeight: 0.15,
  upperMeanCloudinessWeight: 0.24,
  meanCloudinessDry: 0.10,
  meanCloudinessWet: 0.85,
  // weather-model.ts — 圏界面
  tropopauseEquator: 17000,
  tropopausePole: 9000,
  // condensation.ts — 被覆率
  coverageOnset: 0.50,
  coverageWidth: 0.22,
  coverageDispersion: 2,
  coverageExcessPower: 1.5,
  convectionGain: 1.2,
  bandGrainFade: 0.8,
  // condensation.ts — セル径が被覆率を千切る深さへ効く強さと下限
  cellGrainDepth: 0.25,
  cellGrainFloor: 0.3,
  deepCoverageOnset: 0.7,
  deepCoverageFull: 0.93,
  // condensation.ts — 層状の雲と塔
  cloudBaseHeight: 1000,
  layerTopSpan: 6000,
  cloudTopLift: 50,
  cloudTopRelief: 27,
  cloudTopBias: 2.05,
  warmTop: 3,
  bandTop: 3,
  towerOnset: 0.015,
  towerWidth: 0.09,
  towerLiftGate: 0.005,
  // condensation.ts — 層積雲
  stratocumulusSubsidenceScale: 150,
  stratocumulusHumidityOnset: 0.35,
  stratocumulusHumidityWidth: 0.20,
  stratocumulusCloudinessOnset: 0.48,
  stratocumulusCloudinessWidth: 0.24,
  stratocumulusActivityOnset: 0.35,
  stratocumulusActivityWidth: 0.45,
  stratocumulusDeckAdd: 0.35,
  shapeNetworkHumidity: 0.45,
  shapeGrainHumidity: 0.70,
  // condensation.ts — 巻雲(薄い雲)の光学的厚み
  hazeOnset: 0.5,
  hazeGain: 0.66,
  hazeCloudinessOnset: 0.15,
  hazeCloudinessFull: 0.35,
  streakOnset: 0.48,
  streakGain: 2.36,
  translucentKnee: 0.25,
  translucentLimit: 0.85,
  // cell-size.ts — 積雲のセル径 [km] と門
  cellClosedKm: 70,
  cellOpenKm: 25,
  cellOpenWarmthOnset: 0,
  cellOpenWarmthFull: 0.2,
  cellLandKm: 4,
  cellClusterKm: 120,
  cellBandKm: 35,
  cellMarineKm: 50,
  cellResidualWeight: 0.15,
  // cell-size.ts — 巻雲の要素径 [km] と門
  cirrusCellFiberKm: 2.5,
  cirrusCellMackerelKm: 4,
  cirrusCellAnvilKm: 80,
  cirrusCellSheetKm: 20,
  cirrusCellResidualWeight: 0.15,
  cirrusFiberWindOnset: 20,
  cirrusFiberWindFull: 45,
  // convective-activity.ts — 対流の活発度
  instabilityAmplitude: 1.0,
  liftActivity: 25,
  coldActivity: 1.9,
  landActivity: 0.3,
  bandActivity: 0.5,
  activityBase: 0.5,
  activityMin: 0.3,
} as const;

export type CloudTuningId = keyof typeof CLOUD_TUNING_DEFAULTS;

// 調整値の実体。添字は CLOUD_TUNING_DEFAULTS のキーと同じ。
export type CloudTuning = Record<CloudTuningId, FloatUniform>;

// 調整値の実体。値を変えるときは uniform の .value へ書く。
export const CLOUD_TUNING: CloudTuning = Object.fromEntries(
  Object.entries(CLOUD_TUNING_DEFAULTS).map(([id, value]) => [id, uniform(value)]),
) as CloudTuning;
