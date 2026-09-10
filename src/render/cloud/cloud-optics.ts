// 2D雲場を、球殻上の離散的な光学イベントへ変換する純粋な数値契約。
// ここはThree/TSLを知らないので、Beer-Lambertとfront-to-back合成をCPUテストで固定できる。

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

// 積雲のR(coverage)を鉛直柱光学深さへ変換する。Rは無次元の被覆率、戻り値は無次元のtau。
// 巻雲のBはすでに鉛直柱光学深さなので、この変換を通さず値を使う。
export function columnOpticalDepthFromCoverage(coverage: number): number {
  const bounded = Math.min(Math.max(coverage, 0), 0.99);
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
