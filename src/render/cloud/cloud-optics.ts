// 2D雲場を球殻上の離散的な光学イベントへ変換する純粋計算モジュール。
// Three/TSL に依存せず、Beer-Lambert 則と front-to-back 合成を独立して評価できる。
import { CLOUD_MODEL_PARAMETERS } from './cloud-model-parameters';

export interface CloudOpticalEvent {
  // 雲自身の局所散乱。イベント自身の透過を二重に掛けず、手前イベントだけで減衰させる。
  readonly radiance: number;
  // カメラからこのイベントまでの背景大気の透過。イベントごとに一度だけ掛ける。
  readonly backgroundTransmittance: number;
  // このイベントの雲を抜けた透過率。vertical column optical depth × airmassから導く。
  readonly transmittance: number;
}

export interface CloudOpticalComposite {
  readonly transmittance: number;
  readonly radiance: number;
}

// CPUの基準式とGPUのTSL式が共有する入力の上限。被覆率1は無限大のtauになるので、有限の雲を保つ。
export const MAX_COLUMN_COVERAGE = 0.99;

export interface CloudBasisOptics {
  readonly liquidColumn: number;
  readonly iceColumn: number;
  readonly singleScatteringAlbedo: number;
  readonly asymmetry: number;
}

// basis と相の連続 weight から、render path 共通の最小光学量を求める CPU 基準式。
export function cloudBasisOptics(
  low: number, middle: number, convective: number, inSitu: number,
  liquidWeight: number, iceWeight: number,
): CloudBasisOptics {
  const liquidColumn = columnOpticalDepthFromCoverage(low + middle + convective * 0.8)
    * liquidWeight * CLOUD_MODEL_PARAMETERS.liquidTauScale;
  const iceColumn = Math.max(0, inSitu + convective * 0.25)
    * CLOUD_MODEL_PARAMETERS.iceTauScale * (0.35 + iceWeight * 0.65);
  const total = liquidColumn + iceColumn;
  return {
    liquidColumn,
    iceColumn,
    singleScatteringAlbedo: total > 0 ? liquidColumn / total : 0,
    asymmetry: 0.72 * liquidWeight + 0.55 * iceWeight,
  };
}

// basis の不透明成分を鉛直柱光学深さへ変換する。coverage は雲場の別チャンネルで保持する量で、
// basis の光学重みとは混ぜない。
// 巻雲のBはすでに鉛直柱光学深さなので、この変換を通さず値を使う。
export function columnOpticalDepthFromCoverage(coverage: number): number {
  const bounded = Math.min(Math.max(coverage, 0), MAX_COLUMN_COVERAGE);
  return -Math.log1p(-bounded);
}

// 球殻の厚みを通る視線airmass。cosineは鉛直方向との内積、thickness/radiusは同じ長さ単位。
// 接線でも有限値を返し、薄い殻を無限大の光路へ発散させない。
export function shellAirmass(cosine: number, thickness: number, radius: number): number {
  const safeRadius = Math.max(radius, Number.EPSILON);
  const grazingCosine = Math.sqrt(Math.max(thickness, Number.EPSILON) / (2 * safeRadius));
  return 1 / Math.max(Math.abs(cosine), grazingCosine, Number.EPSILON);
}

// 鉛直柱光学深さtauと視線airmassから、イベント1回ぶんの透過率を得る。
export function transmittanceFromColumnOpticalDepth(
  columnOpticalDepth: number, airmass: number,
): number {
  return Math.exp(-Math.max(columnOpticalDepth, 0) * Math.max(airmass, 0));
}

// eventsはカメラに近い順。backgroundRadianceは雲を含む大気積分の結果なので、雲イベントの
// 背景透過をもう一度掛けない。各イベントの背景透過は、そのイベントの局所radianceにだけ一度掛ける。
export function composeCloudEvents(
  events: readonly CloudOpticalEvent[],
  backgroundTransmittance: number,
  backgroundRadiance: number,
): CloudOpticalComposite {
  let frontTransmittance = 1;
  let radiance = 0;
  for (const event of events) {
    radiance += frontTransmittance * event.backgroundTransmittance * event.radiance;
    frontTransmittance *= event.transmittance;
  }
  return {
    transmittance: backgroundTransmittance * frontTransmittance,
    radiance: backgroundRadiance + radiance,
  };
}
