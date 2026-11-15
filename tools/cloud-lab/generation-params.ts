// 生成モデルの調整値をいじるスライダーの表。値そのものの正本は
// src/render/cloud/cloud-tuning.ts の CLOUD_TUNING_DEFAULTS で、ここはつまみの表示名と
// 並び(行)と目盛りだけを持つ。range は値を動かしてよい幅であって、物理的に正しい範囲ではない。
import type { CloudTuningId } from '../../src/render/cloud/cloud-tuning';

// スライダーを置く行。モデルの段の流れ(気象 → 移流 → 凝結、活発度は横断)と同じ並び。
export type GenerationParamRow = 'weather' | 'transport' | 'condense' | 'activity';

export interface GenerationParamSpec {
  readonly label: string;
  readonly row: GenerationParamRow;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const GENERATION_PARAMS: Record<CloudTuningId, GenerationParamSpec> = {
  // 気象 — 気圧と上昇流
  pressureNoiseAmplitude: { label: '気圧の振幅 [hPa]', row: 'weather', min: 0, max: 40, step: 0.5 },
  pressureBandAmplitude: { label: '大循環の気圧帯 [hPa]', row: 'weather', min: 0, max: 20, step: 0.25 },
  pressureLiftGain: { label: '上昇流の利得', row: 'weather', min: 0, max: 0.08, step: 0.001 },
  pressureLiftScale: { label: '上昇流の尺度 [hPa]', row: 'weather', min: 5, max: 80, step: 1 },
  liftLimit: { label: '上昇流の頭打ち [m/s]', row: 'weather', min: 0.01, max: 0.2, step: 0.002 },
  terrainLiftGain: { label: '地形の上昇の利得', row: 'weather', min: 0, max: 1.2, step: 0.02 },
  upperMeanderMaxAngle: { label: '上層の蛇行の向き [rad]', row: 'weather', min: 0, max: 0.8, step: 0.01 },
  // 気象 — 帯(前線・雨帯)
  frontOnset: { label: '前線の開始閾値', row: 'weather', min: 0.5, max: 4, step: 0.05 },
  frontWidth: { label: '前線の遷移幅', row: 'weather', min: 0.05, max: 1, step: 0.01 },
  moistureGradientOnset: { label: '湿度勾配の閾値', row: 'weather', min: 0, max: 0.5, step: 0.005 },
  moistureGradientWidth: { label: '湿度勾配の遷移幅', row: 'weather', min: 0.02, max: 0.8, step: 0.01 },
  rainbandOnset: { label: '雨帯の開始閾値', row: 'weather', min: 1, max: 12, step: 0.1 },
  rainbandWidth: { label: '雨帯の遷移幅', row: 'weather', min: 0.5, max: 10, step: 0.1 },
  bandLift: { label: '帯の上昇流 [m/s]', row: 'weather', min: 0, max: 0.15, step: 0.002 },
  bandHumidity: { label: '帯の湿度の底上げ', row: 'weather', min: 0, max: 0.4, step: 0.005 },
  // 気象 — 湿度への寄与
  surfaceLiftHumidity: { label: '地表の上昇→湿度', row: 'weather', min: 0, max: 4, step: 0.05 },
  surfaceSubsidenceDrying: { label: '地表の沈降→乾き', row: 'weather', min: 0, max: 4, step: 0.05 },
  upperLiftHumidity: { label: '上層の上昇→湿度', row: 'weather', min: 0, max: 3, step: 0.05 },
  upperSubsidenceDrying: { label: '上層の沈降→乾き', row: 'weather', min: 0, max: 6, step: 0.1 },
  vortexContrast: { label: '渦の湿度の増幅', row: 'weather', min: 0, max: 4, step: 0.05 },
  warmHumidity: { label: '暖気流入→湿度', row: 'weather', min: 0, max: 2, step: 0.02 },
  anvilHumidity: { label: '金床→湿度', row: 'weather', min: 0, max: 0.8, step: 0.01 },
  surfaceEyeDryness: { label: '目の乾き(地表)', row: 'weather', min: 0, max: 2.5, step: 0.02 },
  upperEyeDryness: { label: '目の乾き(上層)', row: 'weather', min: 0, max: 6, step: 0.05 },
  surfaceMeanCloudinessWeight: { label: '平年雲量の重み(地表)', row: 'weather', min: 0, max: 0.6, step: 0.005 },
  upperMeanCloudinessWeight: { label: '平年雲量の重み(上層)', row: 'weather', min: 0, max: 0.6, step: 0.005 },
  meanCloudinessDry: { label: '平年雲量の裾', row: 'weather', min: 0, max: 0.4, step: 0.005 },
  meanCloudinessWet: { label: '平年雲量の肩', row: 'weather', min: 0.5, max: 1, step: 0.005 },
  tropopauseEquator: { label: '圏界面(赤道) [m]', row: 'weather', min: 12000, max: 20000, step: 100 },
  tropopausePole: { label: '圏界面(極) [m]', row: 'weather', min: 6000, max: 14000, step: 100 },
  // 移流 — 源の湿度と流し方
  surfaceHumidityBase: { label: '基底湿度(地表)', row: 'transport', min: 0, max: 0.7, step: 0.005 },
  upperHumidityBase: { label: '基底湿度(上層)', row: 'transport', min: 0, max: 0.7, step: 0.005 },
  surfaceHumidityNoiseAmplitude: { label: '湿度の振れ(地表)', row: 'transport', min: 0, max: 1, step: 0.01 },
  upperHumidityNoiseAmplitude: { label: '湿度の振れ(上層)', row: 'transport', min: 0, max: 1.2, step: 0.01 },
  convectionNoiseAmplitude: { label: '対流の振れ', row: 'transport', min: 0, max: 0.8, step: 0.01 },
  upperAdvection: { label: '上層の移流の倍率', row: 'transport', min: 0.5, max: 4, step: 0.05 },
  convectionAdvection: { label: '対流の移流の倍率', row: 'transport', min: 0.5, max: 4, step: 0.05 },
  convectionWinding: { label: '対流の巻きの上限 [rad]', row: 'transport', min: 0.5, max: 6, step: 0.1 },
  // 凝結 — 被覆率
  coverageOnset: { label: '被覆率の閾値', row: 'condense', min: 0.2, max: 0.8, step: 0.005 },
  coverageWidth: { label: '被覆率の遷移幅', row: 'condense', min: 0.05, max: 0.5, step: 0.005 },
  coverageDispersion: { label: '覆いの散らばり', row: 'condense', min: 0.5, max: 6, step: 0.05 },
  coverageExcessPower: { label: '超過量の冪', row: 'condense', min: 0.5, max: 4, step: 0.05 },
  convectionGain: { label: '対流→湿度の重み', row: 'condense', min: 0, max: 3, step: 0.05 },
  bandGrainFade: { label: '帯の粒の弱め', row: 'condense', min: 0, max: 1, step: 0.01 },
  deepCoverageOnset: { label: '深い雲の閾値', row: 'condense', min: 0.3, max: 0.9, step: 0.01 },
  deepCoverageFull: { label: '深い雲の飽和', row: 'condense', min: 0.6, max: 1, step: 0.005 },
  // 凝結 — 層状の雲と塔
  cloudBaseHeight: { label: '雲底の高さ [m]', row: 'condense', min: 0, max: 3000, step: 50 },
  layerTopSpan: { label: '層状の厚み [m]', row: 'condense', min: 2000, max: 12000, step: 100 },
  cloudTopLift: { label: '雲頂←上昇流', row: 'condense', min: 0, max: 150, step: 1 },
  cloudTopRelief: { label: '雲頂←対流', row: 'condense', min: 0, max: 80, step: 1 },
  cloudTopBias: { label: '雲頂の底', row: 'condense', min: 0, max: 5, step: 0.05 },
  warmTop: { label: '雲頂←暖気流入', row: 'condense', min: 0, max: 8, step: 0.1 },
  bandTop: { label: '雲頂←帯', row: 'condense', min: 0, max: 8, step: 0.1 },
  towerOnset: { label: '塔の峰の閾値', row: 'condense', min: 0, max: 0.1, step: 0.001 },
  towerWidth: { label: '塔の峰の遷移幅', row: 'condense', min: 0.02, max: 0.3, step: 0.005 },
  towerLiftGate: { label: '塔の沈降の門 [m/s]', row: 'condense', min: 0, max: 0.03, step: 0.0005 },
  // 凝結 — 層積雲
  stratocumulusSubsidenceScale: { label: '層積雲の沈降門', row: 'condense', min: 20, max: 600, step: 5 },
  stratocumulusHumidityOnset: { label: '層積雲の湿度閾値', row: 'condense', min: 0, max: 0.7, step: 0.005 },
  stratocumulusHumidityWidth: { label: '層積雲の湿度幅', row: 'condense', min: 0.02, max: 0.6, step: 0.01 },
  stratocumulusCloudinessOnset: { label: '層積雲の雲量閾値', row: 'condense', min: 0, max: 0.8, step: 0.005 },
  stratocumulusCloudinessWidth: { label: '層積雲の雲量幅', row: 'condense', min: 0.02, max: 0.6, step: 0.01 },
  stratocumulusActivityOnset: { label: '層積雲の活発度閾値', row: 'condense', min: 0, max: 0.8, step: 0.005 },
  stratocumulusActivityWidth: { label: '層積雲の活発度幅', row: 'condense', min: 0.02, max: 0.9, step: 0.01 },
  stratocumulusDeckAdd: { label: '層積雲の板の高さ', row: 'condense', min: 0, max: 0.8, step: 0.005 },
  shapeNetworkHumidity: { label: '形(網目側)', row: 'condense', min: 0.1, max: 0.7, step: 0.005 },
  shapeGrainHumidity: { label: '形(粒側)', row: 'condense', min: 0.4, max: 0.95, step: 0.005 },
  // 凝結 — 巻雲
  hazeOnset: { label: '靄の閾値', row: 'condense', min: 0.1, max: 0.7, step: 0.005 },
  hazeGain: { label: '靄の利得', row: 'condense', min: 0, max: 2, step: 0.02 },
  streakOnset: { label: '筋の閾値', row: 'condense', min: 0.1, max: 0.8, step: 0.005 },
  streakGain: { label: '筋の利得', row: 'condense', min: 0, max: 6, step: 0.05 },
  translucentKnee: { label: '薄い雲の膝', row: 'condense', min: 0.05, max: 1, step: 0.01 },
  translucentLimit: { label: '薄い雲の上限', row: 'condense', min: 0.2, max: 2, step: 0.01 },
  // 活発度
  instabilityAmplitude: { label: '気団の不安定の振れ', row: 'activity', min: 0, max: 2.5, step: 0.05 },
  liftActivity: { label: '上昇流→活発度', row: 'activity', min: 0, max: 60, step: 0.5 },
  coldActivity: { label: '寒気流入→活発度', row: 'activity', min: 0, max: 5, step: 0.05 },
  landActivity: { label: '陸→活発度', row: 'activity', min: 0, max: 1, step: 0.01 },
  bandActivity: { label: '帯→活発度', row: 'activity', min: 0, max: 1.5, step: 0.01 },
  activityBase: { label: '活発度の基準', row: 'activity', min: 0, max: 1, step: 0.01 },
  activityMin: { label: '活発度の床', row: 'activity', min: 0, max: 1, step: 0.01 },
};
