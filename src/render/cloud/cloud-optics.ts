// 雲の光学の基準式と、球殻上の離散的な光学イベントの合成をまとめた純粋計算モジュール。
// Three/TSL に依存せず、雲が返す光・通す光・イベントの順序を独立して評価できる。

// 非対称因子 g。液水の雲 0.85・氷の雲 0.75 は、保存散乱の Eddington 近似(Meador & Weaver
// 1980)の 2 流近似へ入れる前向き散乱の強さの代表値。
export const LIQUID_CLOUD_ASYMMETRY = 0.85;
export const ICE_CLOUD_ASYMMETRY = 0.75;

export interface CloudOpticalEvent {
  // 雲自身の局所散乱。イベント自身の透過を二重に掛けず、手前イベントだけで減衰させる。
  readonly radiance: number;
  // カメラからこのイベントまでの背景大気の透過。イベントごとに一度だけ掛ける。
  readonly backgroundTransmittance: number;
  // このイベントの雲を抜けて下地へ届く光の割合。R(τ·airmass) の残り 1 − R。
  readonly transmittance: number;
}

interface CloudOpticalComposite {
  readonly transmittance: number;
  readonly radiance: number;
}

// 保存散乱(吸収なし)の層が、拡散入射に対して半球へ返す光の割合。2 流近似
// (Eddington、Meador & Weaver 1980)で R = γτ/(1 + γτ)、γ = 0.75·(1 − g)。
// τ ≥ 0 で 0 ≤ R < 1 に収まり、τ → 0 で R → 0、τ → ∞ で R → 1。返さなかった光は
// 下へ抜けるので、透過率は T = 1 − R。
export function cloudReflectance(opticalDepth: number, asymmetry: number): number {
  const scaled = 0.75 * (1 - asymmetry) * Math.max(opticalDepth, 0);
  return scaled / (1 + scaled);
}

// 球殻の厚みを通る視線airmass。cosineは鉛直方向との内積、thickness/radiusは同じ長さ単位。
// 接線でも有限値を返し、薄い殻を無限大の光路へ発散させない。
export function shellAirmass(cosine: number, thickness: number, radius: number): number {
  const safeRadius = Math.max(radius, Number.EPSILON);
  const grazingCosine = Math.sqrt(Math.max(thickness, Number.EPSILON) / (2 * safeRadius));
  return 1 / Math.max(Math.abs(cosine), grazingCosine, Number.EPSILON);
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
