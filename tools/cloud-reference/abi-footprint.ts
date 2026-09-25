// GOES-R ABI の角度画素を、呼び出し側が選ぶ局所 ENU 平面の画素多角形へ変換する。
// 四隅は基準楕円体の高度 0 に置く。雲頂視差は補正せず、得られる多角形は局所平面近似であり、
// Step 1 の観測演算子全体を実装するものではない。

import type { AbiCollocationPoint } from './abi-collocation';
import {
  abiFixedGridToGeodetic,
  type AbiFixedGridCoordinate,
  type AbiFixedGridProjection,
  type AbiGeodeticCoordinate,
} from './abi-projection';

/** ABI 角度画素の中心と角度間隔から ENU 多角形を作る。 */
export function abiFixedGridPixelFootprintToEnu(
  pixelCenter: AbiFixedGridCoordinate,
  xStepRadians: number,
  yStepRadians: number,
  projection: AbiFixedGridProjection,
  referenceCenter: AbiGeodeticCoordinate,
): readonly AbiCollocationPoint[] | null {
  validateArguments(pixelCenter, xStepRadians, yStepRadians, referenceCenter);
  const halfX = xStepRadians / 2;
  const halfY = yStepRadians / 2;
  const cornerAngles: readonly AbiFixedGridCoordinate[] = [
    { xAngleRadians: pixelCenter.xAngleRadians - halfX, yAngleRadians: pixelCenter.yAngleRadians - halfY },
    { xAngleRadians: pixelCenter.xAngleRadians + halfX, yAngleRadians: pixelCenter.yAngleRadians - halfY },
    { xAngleRadians: pixelCenter.xAngleRadians + halfX, yAngleRadians: pixelCenter.yAngleRadians + halfY },
    { xAngleRadians: pixelCenter.xAngleRadians - halfX, yAngleRadians: pixelCenter.yAngleRadians + halfY },
  ];
  const geodeticCorners = cornerAngles.map((corner) => abiFixedGridToGeodetic(corner, projection));
  if (geodeticCorners.some((corner) => corner === null)) return null;
  return geodeticCorners.map((corner) => geodeticToEnu(corner!, referenceCenter, projection));
}

function validateArguments(
  pixelCenter: AbiFixedGridCoordinate,
  xStepRadians: number,
  yStepRadians: number,
  referenceCenter: AbiGeodeticCoordinate,
): void {
  if (![pixelCenter.xAngleRadians, pixelCenter.yAngleRadians].every(Number.isFinite)) {
    throw new Error('ABI pixel-center angles must be finite');
  }
  if (![xStepRadians, yStepRadians].every(Number.isFinite) || xStepRadians <= 0 || yStepRadians <= 0) {
    throw new Error('ABI angular pixel steps must be finite and positive');
  }
  if (![referenceCenter.latitudeRadians, referenceCenter.longitudeRadians].every(Number.isFinite)
    || Math.abs(referenceCenter.latitudeRadians) > Math.PI / 2) {
    throw new Error('ENU reference center must have finite longitude and latitude between -π/2 and π/2');
  }
}

/** 高度 0 の GRS80 測地座標を東・北の接平面座標へ変換する。 */
function geodeticToEnu(
  coordinate: AbiGeodeticCoordinate,
  reference: AbiGeodeticCoordinate,
  projection: AbiFixedGridProjection,
): AbiCollocationPoint {
  const point = geodeticToEcef(coordinate, projection);
  const origin = geodeticToEcef(reference, projection);
  const deltaX = point.x - origin.x;
  const deltaY = point.y - origin.y;
  const deltaZ = point.z - origin.z;
  const sinLongitude = Math.sin(reference.longitudeRadians);
  const cosLongitude = Math.cos(reference.longitudeRadians);
  const sinLatitude = Math.sin(reference.latitudeRadians);
  const cosLatitude = Math.cos(reference.latitudeRadians);
  return {
    x: -sinLongitude * deltaX + cosLongitude * deltaY,
    y: -sinLatitude * cosLongitude * deltaX
      - sinLatitude * sinLongitude * deltaY + cosLatitude * deltaZ,
  };
}

/** 楕円体上の測地座標を地心地球固定座標 [m] へ変換する。 */
function geodeticToEcef(
  coordinate: AbiGeodeticCoordinate,
  projection: AbiFixedGridProjection,
): { readonly x: number; readonly y: number; readonly z: number } {
  const { semiMajorAxisMeters: a, semiMinorAxisMeters: b } = projection;
  const latitude = coordinate.latitudeRadians;
  const longitude = coordinate.longitudeRadians;
  const eccentricitySquared = 1 - b ** 2 / a ** 2;
  const sinLatitude = Math.sin(latitude);
  const primeVerticalRadius = a / Math.sqrt(1 - eccentricitySquared * sinLatitude ** 2);
  return {
    x: primeVerticalRadius * Math.cos(latitude) * Math.cos(longitude),
    y: primeVerticalRadius * Math.cos(latitude) * Math.sin(longitude),
    z: primeVerticalRadius * (1 - eccentricitySquared) * sinLatitude,
  };
}
