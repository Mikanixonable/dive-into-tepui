// 環の光学モデル。レンダラーやThree.jsに依存しないため、数値回帰テストで直接検証できる。

const EPSILON = 1e-6;
const FOUR_PI = 4 * Math.PI;

export type RingArcInterval = {
  readonly fromDeg: number;
  readonly toDeg: number;
  readonly opticalDepthScale: number;
};

/** 観測開き角を考慮した、環を通過する光の透過率。 */
export function ringTransmission(tauNormal: number, muView: number): number {
  if (!(tauNormal > 0)) return 1;
  return Math.exp(-tauNormal / Math.max(EPSILON, Math.min(1, Math.abs(muView))));
}

/** Henyey–Greenstein位相関数。積分値が1になる正規化を使う。 */
export function henyeyGreenstein(cosTheta: number, g: number): number {
  const clampedG = Math.max(-0.999, Math.min(0.999, g));
  const c = Math.max(-1, Math.min(1, cosTheta));
  const denominator = 1 + clampedG * clampedG - 2 * clampedG * c;
  return (1 - clampedG * clampedG) / (FOUR_PI * Math.pow(Math.max(EPSILON, denominator), 1.5));
}

/** アーク区間に入っているときの法線光学的厚さ。重ね描きではなく倍率で表現する。 */
export function ringArcOpticalDepth(
  baseTau: number,
  arcScale: number,
  longitudeDeg: number,
  arcs: readonly RingArcInterval[] = [],
): number {
  const longitude = ((longitudeDeg % 360) + 360) % 360;
  let scale = 1;
  for (const arc of arcs) {
    const from = ((arc.fromDeg % 360) + 360) % 360;
    const to = ((arc.toDeg % 360) + 360) % 360;
    const inside = from <= to ? longitude >= from && longitude < to : longitude >= from || longitude < to;
    if (inside) scale *= arc.opticalDepthScale;
  }
  return Math.max(0, baseTau * arcScale * scale);
}

/** 薄板近似の単一散乱。戻り値は等方散乱を1とした相対放射輝度。 */
export function ringSingleScattering(
  tauNormal: number,
  muSun: number,
  muView: number,
  cosTheta: number,
  albedo: number,
  phaseG: number,
): number {
  const tau = Math.max(0, tauNormal);
  const direct = 1 - ringTransmission(tau, muSun);
  const escape = ringTransmission(tau * 0.5, muView);
  const isotropicRelativePhase = henyeyGreenstein(cosTheta, phaseG) * FOUR_PI;
  return Math.max(0, albedo) * direct * escape * isotropicRelativePhase;
}
