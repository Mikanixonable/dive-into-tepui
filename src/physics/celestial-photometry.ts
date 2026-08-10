// 天体の見た目に使う純粋な測光・食幾何。描画層から独立させ、全て無次元量または rad を使う。

const EPSILON = 1e-12;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function saturate(value: number): number {
  return Math.max(0, Math.min(1, finite(value)));
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, finite(value)));
}

/**
 * Schlick のFresnel近似。cosine は法線と視線の余弦、f0 は垂直入射時反射率。
 * 入力が有限でない場合にも [0, 1] の有限値を返す。
 */
export function fresnelSchlick(cosine: number, f0: number): number {
  const c = saturate(cosine);
  const base = saturate(f0);
  return base + (1 - base) * Math.pow(1 - c, 5);
}

/**
 * Lambert 球の位相関数。phaseAngle=0 は満月/衝、π は新月/合で、戻り値は [0,1]。
 */
export function lambertSpherePhase(phaseAngleRadians: number): number {
  const phase = clamp(phaseAngleRadians, 0, Math.PI);
  if (phase === 0) return 1;
  if (phase === Math.PI) return 0;
  // sin(π) の丸め残りが新月をわずかに正にしないよう、物理範囲へ明示的に丸める。
  return saturate((Math.sin(phase) + (Math.PI - phase) * Math.cos(phase)) / Math.PI);
}

/**
 * 観測者へ届く地球照の相対強度。
 * 地球の Lambert 位相と、観測者から見た地球の立体角を掛ける。半径角が小さい範囲では
 * angularRadius^2 に比例し、光源としての見かけの大きさが自然に反映される。
 */
export function earthshineIntensity(
  earthPhaseAngleRadians: number,
  earthAngularRadiusRadians: number,
): number {
  const angularRadius = clamp(earthAngularRadiusRadians, 0, Math.PI / 2);
  const solidAngle = 2 * Math.PI * (1 - Math.cos(angularRadius));
  return lambertSpherePhase(earthPhaseAngleRadians) * solidAngle / Math.PI;
}

/** 二つの見かけ円盤の共通面積。半径・中心間隔は同一平面上の角半径(rad)で近似する。 */
export function circleOverlapArea(radiusA: number, radiusB: number, centerDistance: number): number {
  const a = Math.max(0, finite(radiusA));
  const b = Math.max(0, finite(radiusB));
  const d = Math.max(0, finite(centerDistance));
  if (!(a > EPSILON) || !(b > EPSILON)) return 0;
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2;

  const a2 = a * a;
  const b2 = b * b;
  const d2 = d * d;
  const angleA = Math.acos(clamp((d2 + a2 - b2) / (2 * d * a), -1, 1));
  const angleB = Math.acos(clamp((d2 + b2 - a2) / (2 * d * b), -1, 1));
  const radical = Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));
  return a2 * angleA + b2 * angleB - 0.5 * Math.sqrt(radical);
}

/**
 * 球形遮蔽体が太陽円盤を覆う面積比。入力は観測地点からの真の幾何
 * (各半径[m]、各中心までの距離[m]、中心方向の離角[rad]) であり、関数内で角半径に変換する。
 * 返り値 0 は非食、1 は太陽円盤の全遮蔽を表す。
 */
export function solarDiscOcclusionFraction(
  occluderRadiusMeters: number,
  occluderDistanceMeters: number,
  sunRadiusMeters: number,
  sunDistanceMeters: number,
  centerSeparationRadians: number,
): number {
  const occluderRadius = Math.max(0, finite(occluderRadiusMeters));
  const occluderDistance = Math.max(0, finite(occluderDistanceMeters));
  const sunRadius = Math.max(0, finite(sunRadiusMeters));
  const sunDistance = Math.max(0, finite(sunDistanceMeters));
  if (!(occluderRadius > 0) || !(occluderDistance > 0) || !(sunRadius > 0) || !(sunDistance > 0)) return 0;

  const occluderAngularRadius = Math.asin(clamp(occluderRadius / occluderDistance, 0, 1));
  const sunAngularRadius = Math.asin(clamp(sunRadius / sunDistance, 0, 1));
  if (!(sunAngularRadius > EPSILON)) return 0;
  const overlap = circleOverlapArea(occluderAngularRadius, sunAngularRadius, Math.max(0, finite(centerSeparationRadians)));
  return saturate(overlap / (Math.PI * sunAngularRadius * sunAngularRadius));
}

/**
 * 月食中に残る地球大気起源の赤色光の係数。半影では色変化を抑え、皆既に近づくほど滑らかに増す。
 * 太陽円盤の遮蔽率を入力に取り、0 (非食) から 1 (皆既相当) を返す。
 */
export function lunarEclipseRedGlowFactor(solarOcclusionFraction: number): number {
  const occlusion = saturate(solarOcclusionFraction);
  const onset = saturate((occlusion - 0.55) / 0.45);
  return onset * onset * (3 - 2 * onset);
}
