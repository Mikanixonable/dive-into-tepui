// 大気の見た目用の光学計算。ゲームプレイ用の atmosphere.ts とは独立しており、
// THREE/DOM に依存しない。距離は m、消散係数は m^-1 を単位とする。

const EPSILON = 1e-12;
const FOUR_PI = 4 * Math.PI;

export type OpticsVec3 = Readonly<{ x: number; y: number; z: number }>;
export type Rgb = Readonly<{ r: number; g: number; b: number }>;

export type RaySphereDistances = Readonly<{ enter: number; exit: number }>;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number): number {
  return Math.max(0, finite(value));
}

function unitDirection(direction: OpticsVec3): OpticsVec3 | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > EPSILON) || !Number.isFinite(length)) return null;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

/**
 * 原点が球心基準のレイと球の交差距離。方向ベクトルの長さには依存しない。
 * 接線は enter === exit、レイの後方だけにある交差は null を返す。
 */
export function raySphereDistances(
  origin: OpticsVec3,
  direction: OpticsVec3,
  radius: number,
): RaySphereDistances | null {
  const unit = unitDirection(direction);
  const r = nonNegative(radius);
  if (!unit || !(r > 0)) return null;

  const b = origin.x * unit.x + origin.y * unit.y + origin.z * unit.z;
  const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z - r * r;
  const discriminant = b * b - c;
  if (!Number.isFinite(discriminant) || discriminant < 0) return null;

  const root = Math.sqrt(Math.max(0, discriminant));
  // -b ± sqrt(D) をそのまま引くと、遠距離のかすめるレイで片方の根が桁落ちする。
  // q と c/q の組にして、常に片方だけを加算で求める安定形を使う。
  const q = -b - (b >= 0 ? root : -root);
  const rootA = q;
  const rootB = Math.abs(q) > EPSILON ? c / q : -b;
  const near = Math.min(rootA, rootB);
  const far = Math.max(rootA, rootB);
  if (far < 0) return null;
  return { enter: Math.max(0, near), exit: far === 0 ? 0 : far };
}

/** 海抜高度における等温・指数大気の相対密度。地表未満は地表密度へ丸める。 */
export function exponentialAtmosphereDensity(
  altitudeMeters: number,
  scaleHeightMeters: number,
  seaLevelDensity = 1,
): number {
  const scaleHeight = finite(scaleHeightMeters);
  if (!(scaleHeight > 0)) return 0;
  const altitude = Math.max(0, finite(altitudeMeters));
  return nonNegative(seaLevelDensity) * Math.exp(-altitude / scaleHeight);
}

/** Rayleigh 散乱の正規化位相関数 (sr^-1)。 */
export function rayleighPhase(cosTheta: number): number {
  const cosine = Math.max(-1, Math.min(1, finite(cosTheta)));
  return (3 * (1 + cosine * cosine)) / (16 * Math.PI);
}

/** Henyey-Greenstein Mie 散乱の正規化位相関数 (sr^-1)。 */
export function henyeyGreensteinPhase(cosTheta: number, asymmetry: number): number {
  const cosine = Math.max(-1, Math.min(1, finite(cosTheta)));
  const g = Math.max(-0.999, Math.min(0.999, finite(asymmetry)));
  const denominator = Math.max(EPSILON, 1 + g * g - 2 * g * cosine);
  return (1 - g * g) / (FOUR_PI * Math.pow(denominator, 1.5));
}

/** RGB 光学的厚さ τ = σ × 距離。 */
export function rgbOpticalDepth(extinctionPerMeter: Rgb, distanceMeters: number): Rgb {
  const distance = nonNegative(distanceMeters);
  return {
    r: nonNegative(extinctionPerMeter.r) * distance,
    g: nonNegative(extinctionPerMeter.g) * distance,
    b: nonNegative(extinctionPerMeter.b) * distance,
  };
}

/** Beer-Lambert 則による RGB 透過率。 */
export function beerLambertTransmittance(opticalDepth: Rgb): Rgb {
  return {
    r: Math.exp(-nonNegative(opticalDepth.r)),
    g: Math.exp(-nonNegative(opticalDepth.g)),
    b: Math.exp(-nonNegative(opticalDepth.b)),
  };
}

/**
 * 球対称な指数大気のレイ列密度を、中点積分で求める。
 * bodyRadius の内側の区間は除外するので、地表に突き当たるレイにも安全に使える。
 */
export function exponentialAtmosphereColumnDensity(
  origin: OpticsVec3,
  direction: OpticsVec3,
  distanceMeters: number,
  bodyRadius: number,
  scaleHeightMeters: number,
  seaLevelDensity = 1,
  samples = 24,
): number {
  const unit = unitDirection(direction);
  const distance = nonNegative(distanceMeters);
  const radius = nonNegative(bodyRadius);
  if (!unit || !(distance > 0) || !(radius > 0) || !(scaleHeightMeters > 0)) return 0;

  const count = Math.max(1, Math.min(256, Math.floor(finite(samples, 24))));
  const step = distance / count;
  let column = 0;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) * step;
    const x = origin.x + unit.x * t;
    const y = origin.y + unit.y * t;
    const z = origin.z + unit.z * t;
    const altitude = Math.hypot(x, y, z) - radius;
    if (altitude >= 0) column += exponentialAtmosphereDensity(altitude, scaleHeightMeters, seaLevelDensity) * step;
  }
  return finite(column);
}

/** 列密度に、海面での RGB 消散係数を掛けた光学的厚さ。 */
export function rgbAtmosphereOpticalDepth(
  seaLevelExtinctionPerMeter: Rgb,
  columnDensity: number,
): Rgb {
  return rgbOpticalDepth(seaLevelExtinctionPerMeter, columnDensity);
}
