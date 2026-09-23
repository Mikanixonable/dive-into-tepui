// GOES ABI の製品別 DQF を、観測された NetCDF の flag 定義に沿って解釈する。

export type AbiQualityProduct = 'L1B_RAD' | 'L2_COD' | 'L2_ACTP' | 'L2_ACHA' | 'L2_ACM';

export type AbiQualityClass = 'good' | 'degraded' | 'invalid' | 'unknown';

export interface AbiQualityResult {
  readonly product: AbiQualityProduct;
  readonly rawValue: number;
  readonly classification: AbiQualityClass;
  readonly meaning: string;
  readonly goodOnly: boolean;
  readonly valid: boolean;
  readonly mode?: 'day' | 'night';
}

const QUALITY_RESULT = {
  good: { classification: 'good', goodOnly: true, valid: true },
  degraded: { classification: 'degraded', goodOnly: false, valid: true },
  invalid: { classification: 'invalid', goodOnly: false, valid: false },
  unknown: { classification: 'unknown', goodOnly: false, valid: false },
} as const;

/** NOAA の製品ごとに異なる DQF の数値体系を判別し、good-only 用 mask を返す。 */
export function classifyAbiQualityFlag(value: number, product: AbiQualityProduct): AbiQualityResult {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    return result(product, value, 'unknown', 'DQF is not an unsigned byte');
  }

  switch (product) {
    case 'L1B_RAD':
      return classifyL1b(value);
    case 'L2_COD':
      return classifyCod(value);
    case 'L2_ACTP':
      return classifyCtp(value);
    case 'L2_ACHA':
      return classifyCth(value);
    case 'L2_ACM':
      return classifyAcm(value);
  }
}

/** L1b の列挙値 0..4 を品質区分へ写す。 */
function classifyL1b(value: number): AbiQualityResult {
  const meanings = [
    ['good', 'good_pixel_qf'],
    ['degraded', 'conditionally_usable_pixel_qf'],
    ['invalid', 'out_of_range_pixel_qf'],
    ['invalid', 'no_value_pixel_qf'],
    ['degraded', 'focal_plane_temperature_threshold_exceeded_qf'],
  ] as const;
  const meaning = meanings[value];
  return meaning
    ? result('L1B_RAD', value, meaning[0], meaning[1])
    : result('L1B_RAD', value, 'unknown', 'outside the observed valid range 0..4');
}

/** COD の bit 0 は day/night、bits 1..4 は取得品質として分けて読む。 */
function classifyCod(value: number): AbiQualityResult {
  const retrievalQuality = value & 30;
  const mode = (value & 1) === 0 ? 'day' : 'night';
  const categories: Readonly<Record<number, readonly [AbiQualityClass, string]>> = {
    0: ['good', 'good_quality_qf'],
    2: ['degraded', 'degraded_quality_due_to_snow_or_sea_ice_qf'],
    4: ['degraded', 'degraded_quality_due_to_twilight_qf'],
    6: ['invalid', 'invalid_due_to_clear_conditions_qf'],
    8: ['invalid', 'invalid_due_LZA_threshold_exceeded_qf'],
    10: ['degraded', 'degraded_due_to_LZA_threshold_exceeded_qf'],
    12: ['invalid', 'invalid_due_to_not_geolocated_qf'],
    14: ['invalid', 'invalid_due_to_missing_or_bad_input_data_qf'],
    16: ['degraded', 'degraded_due_to_nonconvergence_qf'],
  };
  const category = categories[retrievalQuality];
  if (!category || value > 16) {
    return { ...result('L2_COD', value, 'unknown', 'outside the observed valid range 0..16'), mode };
  }
  return { ...result('L2_COD', value, category[0], category[1]), mode };
}

/** ACTP の bit 0 にある overall QF を製品全体の品質として返す。 */
function classifyCtp(value: number): AbiQualityResult {
  if (value > 63) return result('L2_ACTP', value, 'unknown', 'outside the observed valid range 0..63');
  const overall = value & 1;
  return overall === 0
    ? result('L2_ACTP', value, 'good', 'overall_good_quality_qf')
    : result('L2_ACTP', value, 'degraded', 'overall_degraded_quality_qf');
}

/** ACHA の valid_range と flag_values が衝突する値 4 は未確定として扱う。 */
function classifyCth(value: number): AbiQualityResult {
  const meanings = [
    ['good', 'good_quality_qf'],
    ['degraded', 'marginal_quality_qf'],
    ['invalid', 'retrieval_attempted_qf'],
    ['invalid', 'bad_quality_qf'],
  ] as const;
  if (value === 4) {
    return result('L2_ACHA', value, 'unknown', 'opaque_retrieval_qf is declared but outside valid_range 0..3');
  }
  const meaning = meanings[value];
  return meaning
    ? result('L2_ACHA', value, meaning[0], meaning[1])
    : result('L2_ACHA', value, 'unknown', 'outside the observed valid range 0..3');
}

/** ACM の列挙値で spare を good-only mask から除外する。 */
function classifyAcm(value: number): AbiQualityResult {
  const meanings = [
    ['good', 'good_quality_qf'],
    ['invalid', 'bad_quality_qf'],
    ['invalid', 'space_qf'],
    ['unknown', 'spare_qf'],
    ['unknown', 'spare_qf'],
    ['unknown', 'spare_qf'],
    ['degraded', 'degraded_quality_qf'],
  ] as const;
  const meaning = meanings[value];
  return meaning
    ? result('L2_ACM', value, meaning[0], meaning[1])
    : result('L2_ACM', value, 'unknown', 'outside the observed valid range 0..6');
}

/** 区分から valid と good-only の契約を一貫して組み立てる。 */
function result(
  product: AbiQualityProduct,
  rawValue: number,
  classification: AbiQualityClass,
  meaning: string,
): AbiQualityResult {
  return { product, rawValue, ...QUALITY_RESULT[classification], classification, meaning };
}
