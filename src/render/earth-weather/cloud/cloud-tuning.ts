// 雲の生成モデルの調整値。気象モデル・移流・凝結・対流の活発度が読む「見えのための調整値」を
// uniform として1箇所へ集約し、実験環境(cloud-lab)がスライダーで値を動かせるようにする。
// 値はグラフを組んだあとでも uniform の .value へ書けば次の焼き直しに乗る。
// **ゲームでは既定値のまま動く** — 書き換えるのは実験環境だけで、ここを読むコードは
// 値が変わりうることを前提にしない。開発ビルドだけは、実験環境が書いた git 管理外の上書きを
// applyCloudTuningOverrides で重ねて、ゲームで見た目を確かめられる(tools/ の
// cloud-tuning-overrides-file.cjs が配る)。
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
  // weather-model.ts — 帯(雨帯は気団の圧縮の稜線を写像する)
  rainbandOnset: 5,
  rainbandWidth: 4,
  bandLift: 0.06,
  // pressure-feature.ts — 前線骨格(谷に端部を持つ寒冷・温暖・閉塞の腕)。腕は気団の境目が
  // 渦の循環に乗って巻き上げられた形で、回る速さは循環そのもの(積算の巻き上げ角 wound ×
  // 半径プロファイル)。腕が届く長さは循環の風が縁の速さを下回る半径まで。腕の半値幅と
  // 三点の半径は谷の短軸の半径を尺にした倍率、向きは [°]、曲がりは半径の冪。
  // 閉塞点(三点)が出ると寒冷・温暖の根元の向きは三点の向きへ寄り、3 本が同じ点へ繋がる。
  frontArmWidth: 0.32,
  frontBandSkew: 0.45,
  frontEdgeSpeed: 4,
  frontWarmRatio: 0.55,
  frontTripleRadius: 0.55,
  frontTripleAngleDeg: -45,
  frontColdAngleDeg: -100,
  frontColdTipAngleDeg: -115,
  frontColdBend: 1.5,
  frontWarmAngleDeg: 15,
  frontWarmTipAngleDeg: 25,
  frontWarmBend: 1.5,
  frontOccSwingDeg: 35,
  frontOccBend: 1.0,
  frontTailLatitudeStartDeg: 15,
  frontTailLatitudeFullDeg: 25,
  // weather-model.ts — 上昇源(平地の過渡源・日射加熱・地形性上昇)とプルームの減衰
  transientGain: 0.3,
  transientActivityOnset: 0.62,
  transientActivityFull: 0.85,
  landHeatingGain: 0.3,
  orographicGain: 2,
  plumeDecaySeconds: 6 * 3600,
  // weather-model.ts / weather-transport.ts — 風上の降水が風下へ運ぶ乾き(雨陰)
  rainoutGain: 2.5,
  rainoutDecaySeconds: 24 * 3600,
  // terrain-flow.ts — 細かい勾配から障壁の高さを見積もる裾野の半幅 [m]
  reliefLength: 30e3,
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
  towerDeepGain: 0.1,
  towerDeepMoist: 0.3,
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
  // 靄の斑の門(斑の場 −1..1 の裾と肩) — 薄い雲が一面を覆わないよう百キロ級の透き間を空ける。
  cirrusPatchOnset: -0.15,
  cirrusPatchFull: 0.45,
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
  // convective-activity.ts — 対流の活発度(粒か板かの形態)
  instabilityAmplitude: 1.0,
  liftActivity: 25,
  coldActivity: 1.9,
  surfaceActivity: 0.6,
  landActivity: 0.15,
  bandActivity: 0.5,
  activityBase: 0.5,
  activityMin: 0.3,
  // convective-activity.ts — 地表の駆動(日射・湿り・比高・海面水温)。日射のピークからの遅れ [h]、
  // 山地で早まる時間 [h]、陸の湿りを平年の雲量から読む門、山地と見なす比高の門 [m]。
  shallowLagHours: 0,
  deepLagHours: 4,
  mountainPhaseAdvanceHours: 2,
  wetnessCloudinessOnset: 0.15,
  wetnessCloudinessFull: 0.45,
  reliefOnset: 300,
  reliefFull: 1000,
  // 浅い積雲の駆動: 海の基準と日変化の振れ幅(基準比)、湿度へ足す利得。
  shallowNightFloor: 0.3,
  shallowDriveMean: 0.59,
  oceanDiurnal: 0.25,
  shallowForcingGain: 0.12,
  // 深い対流の駆動: 陸の平地の強さ(山地を 1 として)、暖かい海の強さと早朝の振れ幅、暖かい海の門 [K]。
  landDeepScale: 0.72,
  oceanDeepScale: 0.5,
  oceanDeepDiurnal: 0.15,
  warmSeaTemperatureOnset: 299,
  warmSeaTemperatureFull: 302.5,
} as const;

export type CloudTuningId = keyof typeof CLOUD_TUNING_DEFAULTS;

// 調整値の実体。添字は CLOUD_TUNING_DEFAULTS のキーと同じ。
export type CloudTuning = Record<CloudTuningId, FloatUniform>;

// 調整値の実体。値を変えるときは uniform の .value へ書く。
export const CLOUD_TUNING: CloudTuning = Object.fromEntries(
  Object.entries(CLOUD_TUNING_DEFAULTS).map(([id, value]) => [id, uniform(value)]),
) as CloudTuning;

// 調整値の版。書き手(applyCloudTuningOverrides と実験環境)が値を変えたら版を上げ、焼き手は
// 版を見て古い焼きを捨てる。実験環境が .value を直接書くときは、実験環境側の焼き直しが版の
// 代わりをするので版は上げない。
let tuningRevision = 0;
export function cloudTuningRevision(): number {
  return tuningRevision;
}

// 上書き表(id → 数値)を調整値へ適用し、版を1つ上げる。表に無い項目・数値でない項目は既定値へ
// 戻す — 上書きは「既定値からの差分」として扱い、消えた項目は上書きの解除になる。
export function applyCloudTuningOverrides(overrides: Readonly<Record<string, number>>): void {
  for (const id of Object.keys(CLOUD_TUNING_DEFAULTS) as CloudTuningId[]) {
    const value = overrides[id];
    CLOUD_TUNING[id].value = typeof value === 'number' && Number.isFinite(value) ? value : CLOUD_TUNING_DEFAULTS[id];
  }
  tuningRevision += 1;
}
