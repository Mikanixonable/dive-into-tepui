// 地球・月の表面材質を決める THREE 非依存のデータ基盤。
//
// ここで扱うのは「画像から得られる代理値」と気候設定であり、描画用の色空間や
// TSL ノードは持ち込まない。実測の地形/土地被覆データへ差し替える場合も、この
// API の入力を置き換えれば済むようにしている。

export interface SurfaceMaterialMasks {
  readonly ocean: number;
  readonly land: number;
  readonly iceSnow: number;
  readonly vegetation: number;
  readonly rock: number;
}

export interface IceAgeClimate {
  /** 氷河期の基準氷雪量。現代を 0 とし、1 がこのゲームの基準状態。 */
  readonly glacialBaseline: number;
  /** 高緯度の氷床を拡大する係数。 */
  readonly iceSheetExpansion: number;
  /** 海氷を拡大する係数。 */
  readonly seaIceExpansion: number;
  /** 寒冷・乾燥化による植生縮小率。1 で縮小なし。 */
  readonly vegetationRetention: number;
}

export const ICE_AGE_EARTH: IceAgeClimate = {
  glacialBaseline: 0.48,
  iceSheetExpansion: 1.15,
  seaIceExpansion: 1.15,
  vegetationRetention: 0.72,
};

export interface SeasonalSurfaceFactors {
  readonly solarDeclination: number;
  readonly summer: number;
  readonly winter: number;
  readonly snowPersistence: number;
  readonly vegetationActivity: number;
}

export interface SurfaceMaterialSample {
  /** 画像または決定論的地形代理値。0 = 海面/低地、1 = 高地。 */
  readonly landness: number;
  readonly terrainHeight: number;
  /** 単位球上の緯度 [rad]。 */
  readonly latitude: number;
  /** 0〜1 の決定論的局所変動。 */
  readonly localVariation?: number;
}

export interface TerrainNormal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const TROPICAL_YEAR_SECONDS = 365.2422 * 86400;
export const EARTH_OBLIQUITY = 23.43928 * Math.PI / 180;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** 表示時刻から太陽黄経相当の季節位相を返す。位相の原点は共有時刻系に固定する。 */
export function seasonalLongitudeAt(timeSeconds: number, orbitalPeriod = TROPICAL_YEAR_SECONDS): number {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(orbitalPeriod) || orbitalPeriod <= 0) return 0;
  return positiveModulo(timeSeconds / orbitalPeriod, 1) * Math.PI * 2;
}

/** 軸傾斜から太陽赤緯を求める。solarLongitude は北半球夏至を π/2 とする。 */
export function solarDeclination(solarLongitude: number, obliquity = EARTH_OBLIQUITY): number {
  return Math.asin(Math.sin(obliquity) * Math.sin(solarLongitude));
}

/**
 * 氷河期基準と季節を、緯度ごとの雪氷・植生の係数へ変換する。
 * これは気候シミュレーションではなく、軸傾斜と太陽季節に整合する外観用の低次モデル。
 */
export function seasonalSurfaceFactors(
  latitude: number,
  solarLongitude: number,
  climate: IceAgeClimate = ICE_AGE_EARTH,
): SeasonalSurfaceFactors {
  const safeLatitude = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latitude));
  const hemisphere = safeLatitude < 0 ? -1 : 1;
  const absLatitude = Math.abs(safeLatitude) / (Math.PI / 2);
  const declination = solarDeclination(solarLongitude);
  const localSummer = 0.5 + 0.5 * Math.cos(solarLongitude - hemisphere * Math.PI / 2);
  const poleSummer = clamp01(localSummer * smoothstep(0.35, 0.92, absLatitude));
  const poleWinter = 1 - poleSummer;
  const baseline = clamp01(climate.glacialBaseline);
  const snowPersistence = clamp01(
    baseline + climate.iceSheetExpansion * absLatitude * 0.4 + poleWinter * absLatitude * 0.25 - poleSummer * 0.16,
  );
  const vegetationActivity = clamp01(
    climate.vegetationRetention * (0.28 + 0.72 * localSummer) * (1 - snowPersistence * 0.82) * (1 - absLatitude * 0.48),
  );
  return {
    solarDeclination: declination,
    summer: localSummer,
    winter: poleWinter,
    snowPersistence,
    vegetationActivity,
  };
}

/** 画像の土地被覆代理値と季節係数から材質マスクを作る。 */
export function surfaceMaterialMasks(
  sample: SurfaceMaterialSample,
  seasonal: SeasonalSurfaceFactors,
  climate: IceAgeClimate = ICE_AGE_EARTH,
): SurfaceMaterialMasks {
  const land = clamp01(sample.landness);
  const height = clamp01(sample.terrainHeight);
  const latitude = clamp01(Math.abs(sample.latitude) / (Math.PI / 2));
  const variation = clamp01(sample.localVariation ?? 0.5);
  const polarIce = smoothstep(0.64, 0.98, latitude) * (0.66 + 0.34 * seasonal.snowPersistence);
  const mountainIce = smoothstep(0.58, 0.92, height) * (0.28 + 0.42 * seasonal.snowPersistence);
  const iceSnow = clamp01((polarIce * climate.iceSheetExpansion + mountainIce) * land);
  const ocean = 1 - land;
  const seaIce = ocean * polarIce * climate.seaIceExpansion;
  const finalIce = clamp01(iceSnow + seaIce);
  const vegetation = clamp01(
    land * (1 - iceSnow) * seasonal.vegetationActivity * (0.62 + variation * 0.38),
  );
  const rock = clamp01(land * (1 - iceSnow) * (0.18 + height * 0.72) * (1 - vegetation * 0.55));
  return { ocean: clamp01(ocean - seaIce), land, iceSnow: finalIce, vegetation, rock };
}

function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function normalize3(x: number, y: number, z: number): TerrainNormal {
  const length = length3(x, y, z);
  if (length < 1e-12) return { x: 0, y: 1, z: 0 };
  return { x: x / length, y: y / length, z: z / length };
}

function sphereDirection(u: number, v: number): TerrainNormal {
  const longitude = u * Math.PI * 2 - Math.PI;
  const latitude = Math.PI / 2 - v * Math.PI;
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.cos(longitude),
    y: Math.sin(latitude),
    z: cosLatitude * Math.sin(longitude),
  };
}

/**
 * equirectangular height の局所勾配を球面接線へ変換する。
 * 周期境界のサンプルは呼び出し側で用意するため、描画/画像ローダーに依存しない。
 */
export function terrainNormalFromEquirectangular(
  u: number,
  v: number,
  heightLeft: number,
  heightRight: number,
  heightUp: number,
  heightDown: number,
  strength = 0.035,
): TerrainNormal {
  const radial = sphereDirection(u, v);
  const east = normalize3(-radial.z, 0, radial.x);
  const north = normalize3(east.y * radial.z - east.z * radial.y, east.z * radial.x - east.x * radial.z, east.x * radial.y - east.y * radial.x);
  const dEast = (heightRight - heightLeft) * 0.5 * strength;
  const dNorth = (heightDown - heightUp) * 0.5 * strength;
  return normalize3(
    radial.x - east.x * dEast - north.x * dNorth,
    radial.y - east.y * dEast - north.y * dNorth,
    radial.z - east.z * dEast - north.z * dNorth,
  );
}

/** 資産が持つ局所勾配だけでは足りない月面のクレーター細部用の固定ノイズ法線。 */
export function deterministicDetailNormal(x: number, y: number, z: number, scale = 1): TerrainNormal {
  const east = Math.sin((x * 17.13 + z * 11.71 + y * 5.37) * scale) * 0.5;
  const north = Math.cos((z * 13.19 - x * 7.31 + y * 19.07) * scale) * 0.5;
  return normalize3(x - east * 0.055, y + north * 0.055, z - east * 0.035);
}

export function blendTerrainNormals(base: TerrainNormal, detail: TerrainNormal, amount: number): TerrainNormal {
  const t = clamp01(amount);
  return normalize3(
    base.x + (detail.x - base.x) * t,
    base.y + (detail.y - base.y) * t,
    base.z + (detail.z - base.z) * t,
  );
}
