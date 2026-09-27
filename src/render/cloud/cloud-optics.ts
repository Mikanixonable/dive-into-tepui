// 2D雲場を球殻上の離散的な光学イベントへ変換する純粋計算モジュール。
// Three/TSL に依存せず、Beer-Lambert 則と front-to-back 合成を独立して評価できる。

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

// 積雲のR(coverage)を鉛直柱光学深さへ変換する。Rは無次元の被覆率、戻り値は無次元のtau。
// 巻雲のBはすでに鉛直柱光学深さなので、この変換を通さず値を使う。
export function columnOpticalDepthFromCoverage(coverage: number): number {
  const bounded = Math.min(Math.max(coverage, 0), MAX_COLUMN_COVERAGE);
  return -Math.log1p(-bounded);
}

// 雲粒の散乱の非対称因子 g。水雲の可視域の典型値。
export const CLOUD_ASYMMETRY = 0.85;

// 保存散乱の二流近似による、鉛直柱光学深さ tau の雲層の反射率 R = 3(1−g)τ / (4 + 3(1−g)τ)。
// 厚い雲ほど 1 へ漸近し、薄い雲は下地を透かす灰色になる。
export function cloudReflectance(columnOpticalDepth: number): number {
  const scaled = 3 * (1 - CLOUD_ASYMMETRY) * Math.max(columnOpticalDepth, 0);
  return scaled / (4 + scaled);
}

// 下層の雲の鉛直柱光学深さを、雲底から雲頂までの厚み depth [m] から見積もる。断熱的な雲では液水量が
// 厚みの 2 乗、光学深さが液水量の 5/6 乗に比例するので τ ∝ 厚み^(5/3)。係数は厚み 1 km で τ 8
// (層積雲の典型)、上限は積乱雲の芯の典型 150 に取る調整値。
export const LOW_CLOUD_OPTICAL_DEPTH_PER_KM = 8;
export const LOW_CLOUD_OPTICAL_DEPTH_EXPONENT = 5 / 3;
export const MAX_LOW_CLOUD_OPTICAL_DEPTH = 150;
export function lowCloudOpticalDepth(depth: number): number {
  const kilometers = Math.max(depth, 0) / 1000;
  return Math.min(
    LOW_CLOUD_OPTICAL_DEPTH_PER_KM * kilometers ** LOW_CLOUD_OPTICAL_DEPTH_EXPONENT,
    MAX_LOW_CLOUD_OPTICAL_DEPTH);
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
