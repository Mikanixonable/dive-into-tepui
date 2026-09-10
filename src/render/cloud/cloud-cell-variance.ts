// 雲セルの大きさを、緯度帯と陸域率から連続的に決める数値ポリシー。
// 描画ノードや状態を持たず、CPU側の調整値とテストから共有する。

export type CloudCellVarianceProfile = {
  readonly meanScale: number;
  readonly logSigma: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
};

// 雲セルの倍率を表現・雲影の両方で共通に解釈する安全範囲。地域ごとの細かな上下限はプロフィールが
// 持つが、どの入力でもこの範囲を超えない。
export const CLOUD_CELL_SCALE_MIN = 0.5;
export const CLOUD_CELL_SCALE_MAX = 3.0;

// 観測量:
// - Mieslinger et al. (2019), 1,158シーンの熱帯海洋ASTER観測では、雲サイズ分布の折れ曲がりが
//   約590 mで、風速に伴って約440〜1,300 mへ変化した。
// - De Vera et al. (2024), 熱帯西太平洋ASTER観測では、雲量の半分が面積等価径1.6 km未満で、
//   サイズ分布のべき指数は2.93だった。
// - Liu et al. (2026) は陸域と熱帯海洋を比較し、陸域の雲サイズ・雲頂高度の変動が大きいことを示した。
//
// 推定値:
// これらは観測された絶対サイズをそのまま格納したものではない。各セルの基準サイズは呼び出し側が
// 持つため、ここでは観測された「熱帯海洋は比較的狭い分布」「陸域は変動が大きい」を、代表サイズの
// 倍率(meanScale)、基準1.0に対する対数正規幅(logSigma)、描画で許容する倍率の下限・上限
// (scaleMin/scaleMax)へ写像している。scaleMin/scaleMaxは±1σの観測範囲ではなく、ノイズの裾を
// 含めても0.5〜3.0に収めるためのゲーム用の安全範囲である。低緯度陸域は基準4 kmに対して8 km以上、
// 高緯度陸域はそれ以上になるようmeanScaleを置いた。高緯度の値は、指定要件どおり熱帯より分散を
// 大きくするゲーム上の外挿であり、上記の熱帯ASTER観測からの直接測定値ではない。
//
// 参考文献:
// https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2019JD030768
// https://acp.copernicus.org/articles/24/5603/2024/
// https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2025JD045060
export const CLOUD_CELL_VARIANCE_PROFILES = {
  lowLatitudeOcean: {
    meanScale: 1.00,
    logSigma: 0.18,
    scaleMin: 0.85,
    scaleMax: 1.25,
  },
  lowLatitudeLand: {
    meanScale: 2.15,
    logSigma: 0.30,
    scaleMin: 2.00,
    scaleMax: 2.50,
  },
  highLatitudeOcean: {
    meanScale: 1.45,
    logSigma: 0.28,
    scaleMin: 0.85,
    scaleMax: 2.00,
  },
  highLatitudeLand: {
    meanScale: 2.45,
    logSigma: 0.34,
    scaleMin: 2.00,
    scaleMax: 3.00,
  },
} as const satisfies Record<string, CloudCellVarianceProfile>;

export const CLOUD_CELL_MEAN_SCALE_MIN = CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeOcean.meanScale;
export const CLOUD_CELL_MEAN_SCALE_MAX = CLOUD_CELL_VARIANCE_PROFILES.highLatitudeLand.meanScale;
export const CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_OCEAN = 0;
export const CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN = (
  CLOUD_CELL_VARIANCE_PROFILES.highLatitudeOcean.meanScale - CLOUD_CELL_MEAN_SCALE_MIN
) / (CLOUD_CELL_MEAN_SCALE_MAX - CLOUD_CELL_MEAN_SCALE_MIN);
export const CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND = (
  CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeLand.meanScale - CLOUD_CELL_MEAN_SCALE_MIN
) / (CLOUD_CELL_MEAN_SCALE_MAX - CLOUD_CELL_MEAN_SCALE_MIN);
export const CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_LAND = 1;

const LOW_LATITUDE_BLEND_START_RAD = 15 * Math.PI / 180;
const HIGH_LATITUDE_BLEND_END_RAD = 60 * Math.PI / 180;

/**
 * 絶対緯度と陸域率から雲セルのサイズ変動幅を返す。
 * 緯度15〜60度と陸域率0〜1の両方を滑らかに補間するため、海岸線・緯度境界で不連続にならない。
 */
export function cloudCellVarianceProfileAt(
  absLatitudeRad: number,
  landFraction: number,
): CloudCellVarianceProfile {
  const latitude = clamp(absLatitudeRad, 0, Math.PI / 2);
  const land = clamp(landFraction, 0, 1);
  const latitudeWeight = smoothstep(
    LOW_LATITUDE_BLEND_START_RAD,
    HIGH_LATITUDE_BLEND_END_RAD,
    latitude,
  );

  const lowLatitudeMean = lerp(
    CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeOcean.meanScale,
    CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeLand.meanScale,
    land,
  );
  const highLatitudeMean = lerp(
    CLOUD_CELL_VARIANCE_PROFILES.highLatitudeOcean.meanScale,
    CLOUD_CELL_VARIANCE_PROFILES.highLatitudeLand.meanScale,
    land,
  );
  const meanScale = lerp(lowLatitudeMean, highLatitudeMean, latitudeWeight);
  const profileIndex = clamp(
    (meanScale - CLOUD_CELL_MEAN_SCALE_MIN) / (CLOUD_CELL_MEAN_SCALE_MAX - CLOUD_CELL_MEAN_SCALE_MIN),
    0,
    1,
  );
  return profileAtIndex(profileIndex, meanScale);
}

/**
 * -1..1のノイズを、プロフィールの対数正規的な倍率へ変換する。
 * ノイズの分布自体は呼び出し側の責務なので、ここでは入力を安全な範囲へ飽和させるだけにする。
 */
export function cloudCellScaleFromNoise(
  noise: number,
  profile: CloudCellVarianceProfile,
): number {
  const boundedNoise = Number.isFinite(noise) ? clamp(noise, -1, 1) : 0;
  const rawScale = profile.meanScale * Math.exp(boundedNoise * profile.logSigma);
  return clamp(rawScale, profile.scaleMin, profile.scaleMax, CLOUD_CELL_SCALE_MIN, CLOUD_CELL_SCALE_MAX);
}

function interpolateProfile(
  from: CloudCellVarianceProfile,
  to: CloudCellVarianceProfile,
  weight: number,
): CloudCellVarianceProfile {
  return {
    meanScale: lerp(from.meanScale, to.meanScale, weight),
    logSigma: lerp(from.logSigma, to.logSigma, weight),
    scaleMin: lerp(from.scaleMin, to.scaleMin, weight),
    scaleMax: lerp(from.scaleMax, to.scaleMax, weight),
  };
}

function profileAtIndex(index: number, meanScale: number): CloudCellVarianceProfile {
  if (index <= CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN) {
    return withMeanScale(interpolateProfile(
      CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeOcean,
      CLOUD_CELL_VARIANCE_PROFILES.highLatitudeOcean,
      smoothstep(CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_OCEAN, CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN, index),
    ), meanScale);
  }
  if (index <= CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND) {
    return withMeanScale(interpolateProfile(
      CLOUD_CELL_VARIANCE_PROFILES.highLatitudeOcean,
      CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeLand,
      smoothstep(CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN, CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND, index),
    ), meanScale);
  }
  return withMeanScale(interpolateProfile(
    CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeLand,
    CLOUD_CELL_VARIANCE_PROFILES.highLatitudeLand,
    smoothstep(CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND, CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_LAND, index),
  ), meanScale);
}

function withMeanScale(
  profile: CloudCellVarianceProfile,
  meanScale: number,
): CloudCellVarianceProfile {
  return { ...profile, meanScale };
}

function lerp(from: number, to: number, weight: number): number {
  return from + (to - from) * weight;
}

function clamp(value: number, min: number, max: number, outputMin = min, outputMax = max): number {
  return Math.max(outputMin, Math.min(outputMax, Math.max(min, Math.min(max, value))));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
