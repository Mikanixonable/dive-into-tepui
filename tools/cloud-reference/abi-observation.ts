// ABI の一画素を校正値と製品別品質・観測幾何で評価する。
// 入力は CF scale/offset をまだ適用していない packed 画素値とする。
// 空間・時間の再標本化、雲頂視差、検索 mask の推定は行わず、観測演算子全体ではない。

import { abiPixelAngles, type AbiPixelAngles } from './abi-angles';
import type { AbiFixedGridCoordinate, AbiFixedGridProjection } from './abi-projection';
import { classifyAbiQualityFlag, type AbiQualityProduct, type AbiQualityResult } from './abi-quality';
import { decodeAbiPackedValue } from './radiometry';

export type AbiObservationInvalidReason =
  | 'non-finite-packed-value'
  | 'fill-value'
  | 'outside-valid-range'
  | 'quality-not-good'
  | 'limb'
  | 'night'
  | 'solar-zenith-limit';

export interface AbiPackedSample {
  readonly packedValue: number;
  readonly fillValue: number;
  readonly validRange: readonly [number, number];
  readonly scaleFactor: number;
  readonly addOffset: number;
}

export interface AbiObservationSample {
  readonly value: number | null;
  readonly valid: boolean;
  readonly quality: AbiQualityResult;
  readonly angles: AbiPixelAngles | null;
  readonly reasons: readonly AbiObservationInvalidReason[];
}

export interface AbiObservationTile {
  /** 幅 * 高さが 4096 以下の連続小窓を行優先で並べる。 */
  readonly packedSamples: ArrayLike<number>;
  readonly qualityValues: ArrayLike<number>;
  readonly xAnglesRadians: ArrayLike<number>;
  readonly yAnglesRadians: ArrayLike<number>;
  readonly sample: Omit<AbiPackedSample, 'packedValue'>;
  readonly product: AbiQualityProduct;
  readonly projection: AbiFixedGridProjection;
  readonly scanTimeUtc: string;
  /** 可視の比較だけ上限角を渡す。赤外は null とし夜間も有効にする。 */
  readonly maximumSolarZenithRadians: number | null;
}

/**
 * ABI の packed 観測値を一画素だけ復号し、good-only DQF と幾何条件を評価する。
 * 可視帯域では呼出側が 70° などの太陽天頂角上限を渡す。上限 null は IR 等で使う。
 * scanTimeUtc は製品全体の撮像時刻であり、ラインごとの撮像時刻差を補正しない。
 */
export function evaluateAbiObservationSample(
  sample: AbiPackedSample,
  qualityValue: number,
  product: AbiQualityProduct,
  coordinate: AbiFixedGridCoordinate,
  projection: AbiFixedGridProjection,
  scanTimeUtc: string,
  maximumSolarZenithRadians: number | null,
): AbiObservationSample {
  validateSample(sample, maximumSolarZenithRadians);
  const quality = classifyAbiQualityFlag(qualityValue, product);
  const reasons: AbiObservationInvalidReason[] = [];

  if (!Number.isFinite(sample.packedValue)) reasons.push('non-finite-packed-value');
  if (sample.packedValue === sample.fillValue) reasons.push('fill-value');
  if (sample.packedValue < sample.validRange[0] || sample.packedValue > sample.validRange[1]) {
    reasons.push('outside-valid-range');
  }
  if (!quality.goodOnly) reasons.push('quality-not-good');

  const angles = abiPixelAngles(coordinate, projection, scanTimeUtc);
  if (angles === null) {
    reasons.push('limb');
    return { value: null, valid: false, quality, angles: null, reasons };
  }
  if (maximumSolarZenithRadians !== null) {
    if (angles.solarZenithRadians >= Math.PI / 2) reasons.push('night');
    if (angles.solarZenithRadians > maximumSolarZenithRadians) reasons.push('solar-zenith-limit');
  }

  if (reasons.length > 0) return { value: null, valid: false, quality, angles, reasons };
  const value = decodeAbiPackedValue(sample.packedValue, sample.scaleFactor, sample.addOffset);
  return { value, valid: true, quality, angles, reasons };
}

/** ABI の連続小窓を行優先に評価する。画像全体ではなく、呼出側が切り出した小窓を渡す。 */
export function evaluateAbiObservationTile(tile: AbiObservationTile): readonly AbiObservationSample[] {
  const { xAnglesRadians: xAngles, yAnglesRadians: yAngles } = tile;
  const pixelCount = xAngles.length * yAngles.length;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > 4096
    || tile.packedSamples.length !== pixelCount || tile.qualityValues.length !== pixelCount) {
    throw new Error('ABI observation tile must contain matching non-empty arrays for at most 4096 pixels');
  }

  const results: AbiObservationSample[] = [];
  for (let row = 0; row < yAngles.length; row += 1) {
    for (let column = 0; column < xAngles.length; column += 1) {
      const index = row * xAngles.length + column;
      results.push(evaluateAbiObservationSample(
        { ...tile.sample, packedValue: tile.packedSamples[index]! },
        tile.qualityValues[index]!,
        tile.product,
        { xAngleRadians: xAngles[column]!, yAngleRadians: yAngles[row]! },
        tile.projection,
        tile.scanTimeUtc,
        tile.maximumSolarZenithRadians,
      ));
    }
  }
  return results;
}

function validateSample(sample: AbiPackedSample, maximumSolarZenithRadians: number | null): void {
  if (![sample.fillValue, sample.validRange[0], sample.validRange[1], sample.scaleFactor, sample.addOffset].every(Number.isFinite)
    || sample.validRange[0] > sample.validRange[1]) {
    throw new Error('ABI sample metadata must be finite with an ordered valid range');
  }
  if (sample.scaleFactor <= 0) throw new Error('ABI radiometric scale factor must be positive');
  if (maximumSolarZenithRadians !== null
    && (!Number.isFinite(maximumSolarZenithRadians)
      || maximumSolarZenithRadians < 0 || maximumSolarZenithRadians > Math.PI)) {
    throw new Error('ABI solar-zenith limit must be null or between zero and π radians');
  }
}
